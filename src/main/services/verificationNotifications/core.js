const crypto = require('crypto');
const CHANNELS = ['desktop', 'email', 'sms'];
const TYPES = {qr_login: '扫码登录', login: '登录', sms: '短信验证', captcha: '验证码验证', verification: '安全验证'};
const clean = (value, max = 120) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function normalizeEvent(input, now) {
  const account = input?.account || {};
  const rawName = clean(account.name || account.phone);
  const platform = clean(account.platform || account.pt, 40);
  if (!rawName || !platform) throw new Error('Verification event requires account and platform');
  const name = /^\+?\d{7,15}$/.test(rawName) ? `${rawName.slice(0, 3)}****${rawName.slice(-4)}` : rawName;
  const challengeType = Object.hasOwn(TYPES, input.challengeType) ? input.challengeType : 'verification';
  return Object.freeze({
    id: crypto.randomUUID(), type: 'verification.required', createdAt: new Date(now).toISOString(),
    accountKey: hash(`${platform}|${rawName}`),
    account: Object.freeze({id: clean(account.id, 160), name, platform}),
    source: clean(input.source, 60) || 'automation', taskId: clean(input.taskId, 160),
    clientId: clean(input.clientId, 160), challengeType, windowShown: input.windowShown === true,
    traceId: clean(input.traceId, 160),
  });
}

function formatNotification(event) {
  const action = TYPES[event.challengeType];
  return {
    subject: `视媒助手：${event.account.platform}账号需要${action}`,
    text: `账号「${event.account.name}」需要${action}。${event.windowShown ? '验证窗口已弹出' : '请打开对应账号的验证窗口'}，请在运行客户端的电脑上完成操作。任务：${event.source}${event.taskId ? `（${event.taskId}）` : ''}。`,
    // Fixed, sanitized parameters only. Never include a code, QR image, cookie,
    // execution token, scraped text, or URL supplied by the platform page.
    params: {account: event.account.name, platform: event.account.platform, verification: action},
  };
}

function createEmailTransport(sendEmail) {
  if (typeof sendEmail !== 'function') throw new Error('sendEmail provider required');
  return {send: ({recipient, event, message, signal, idempotencyKey}) => sendEmail({to: recipient, subject: message.subject, text: message.text, eventId: event.id, signal, idempotencyKey})};
}
function createSmsTransport(sendSms) {
  if (typeof sendSms !== 'function') throw new Error('sendSms provider required');
  return {send: ({recipient, event, message, signal, idempotencyKey}) => sendSms({to: recipient, params: message.params, eventId: event.id, signal, idempotencyKey})};
}

function createVerificationNotifier({transports = {}, enabledChannels = ['desktop'], resolveRoutes = () => [{channel: 'desktop'}],
  cooldownMs = 5 * 60 * 1000, maxPerHour = 6, timeoutMs = 5000, now = Date.now, maxEntries = 2000, audit = () => {}} = {}) {
  if (![cooldownMs, maxPerHour, timeoutMs, maxEntries].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid notification limits');
  if (!Array.isArray(enabledChannels) || enabledChannels.some(channel => !CHANNELS.includes(channel))) throw new Error('Unknown notification channel');
  const enabled = new Set(enabledChannels);
  const attempts = new Map();
  const log = (name, detail) => {try {audit(name, detail);} catch (_) {}};
  async function notify(input) {
    let event;
    try {event = normalizeEvent(input, now());} catch (_) {log('notification.invalid', {status: 'invalid'}); return {status: 'invalid', deliveries: []};}
    const context = {traceId: event.traceId, eventId: event.id, taskId: event.taskId, accountId: event.account.id,
      accountName: event.account.name, platform: event.account.platform, source: event.source, challengeType: event.challengeType};
    log('notification.requested', {...context, windowShown: event.windowShown});
    let routes;
    try {routes = resolveRoutes(event);} catch (_) {log('notification.routing_failed', context); return {status: 'routing_failed', eventId: event.id, deliveries: []};}
    if (!Array.isArray(routes) || routes.length > 10) {log('notification.routing_failed', context); return {status: 'routing_failed', eventId: event.id, deliveries: []};}
    if (!routes.length) log('notification.no_routes', context);
    const seen = new Set();
    const deliveries = await Promise.all(routes.map(async route => {
      const channel = route?.channel;
      if (!CHANNELS.includes(channel)) return {channel: 'unknown', status: 'invalid_route'};
      if (!enabled.has(channel)) return {channel, status: 'disabled'};
      const recipient = channel === 'desktop' ? '' : route.recipient;
      const validRecipient = typeof recipient === 'string' && recipient.length <= 254 &&
        (channel === 'email' ? /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(recipient) : channel === 'sms' ? /^\+[1-9]\d{6,14}$/.test(recipient) : true);
      if (!validRecipient) return {channel, status: 'invalid_recipient'};
      const key = hash(`${event.accountKey}|${channel}|${recipient}`);
      if (seen.has(key)) return {channel, status: 'suppressed'};
      seen.add(key);
      if (typeof transports[channel]?.send !== 'function') return {channel, status: 'unconfigured'};
      const at = now();
      for (const [entryKey, entry] of attempts) if (!entry.pending && at - entry.last >= Math.max(cooldownMs, 60 * 60 * 1000)) attempts.delete(entryKey);
      const record = attempts.get(key);
      if (record && (record.pending || at - record.last < cooldownMs)) return {channel, status: 'suppressed'};
      const recent = (record?.times || []).filter(time => at - time < 60 * 60 * 1000);
      if (recent.length >= maxPerHour || (!record && attempts.size >= maxEntries)) return {channel, status: 'rate_limited'};
      // Claim before any await, including failed/unknown attempts. No automatic
      // retry after timeout: the provider may already have accepted the message.
      const attempt = {last: at, times: [...recent, at], pending: true};
      attempts.set(key, attempt);
      log('notification.attempt', {...context, channel, recipientHash: hash(recipient)});
      const controller = new AbortController();
      let timer;
      try {
        const response = await Promise.race([
          Promise.resolve().then(() => transports[channel].send({recipient, event, message: formatNotification(event), signal: controller.signal, idempotencyKey: hash(`${key}|${at}`)})),
          new Promise(resolve => {timer = setTimeout(() => {controller.abort(); resolve({timeout: true});}, timeoutMs);}),
        ]);
        return {channel, status: response?.timeout ? 'timeout' : response === true || response?.accepted === true ? 'accepted' : 'failed'};
      } catch (_) {
        // Provider error bodies can contain secrets; do not log or expose them.
        return {channel, status: 'failed'};
      } finally {clearTimeout(timer); attempt.pending = false;}
    }));
    deliveries.forEach((delivery, index) => log('notification.result', {...context, ...delivery,
      recipientHash: hash(String(routes[index]?.recipient || ''))}));
    return {status: 'processed', eventId: event.id, deliveries};
  }
  return {notify};
}
module.exports = {createVerificationNotifier, createEmailTransport, createSmsTransport, formatNotification};
