const assert = require('assert/strict');
const {createVerificationNotifier, createEmailTransport, createSmsTransport} = require('../src/main/services/verificationNotifications/core');
const event = {source: 'outreach_search', taskId: 'task-1', account: {id: 'account-1', phone: '开发测试抖音2', pt: '抖音'}, challengeType: 'sms', windowShown: true};
const routes = [{channel: 'desktop'}, {channel: 'email', recipient: 'ops@example.test'}, {channel: 'sms', recipient: '+8613800000000'}];
const statuses = result => result.deliveries.map(delivery => delivery.status);
async function main() {
  let emails = [], texts = [], popups = [];
  const transports = {
    desktop: {send: async value => {popups.push(value); return true;}},
    email: createEmailTransport(async value => {emails.push(value); return {accepted: true};}),
    sms: createSmsTransport(async value => {texts.push(value); return {accepted: true};}),
  };
  const disabled = createVerificationNotifier({transports, resolveRoutes: () => routes});
  assert.deepEqual(statuses(await disabled.notify(event)), ['accepted', 'disabled', 'disabled']);
  assert.equal(emails.length + texts.length, 0, 'external channels disabled by default');
  let clock = 1000;
  const notifier = createVerificationNotifier({transports, enabledChannels: ['desktop', 'email', 'sms'], resolveRoutes: () => routes, now: () => clock});
  const first = await notifier.notify({...event, executionToken: 'secret-token', qrImage: 'secret-qr', code: 'secret-code'});
  assert.deepEqual(statuses(first), ['accepted', 'accepted', 'accepted']);
  const payload = JSON.stringify({emails, texts, popups});
  assert.ok(!payload.includes('secret-'));
  assert.ok(emails[0].text.includes('开发测试抖音2') && emails[0].text.includes('验证窗口已弹出'));
  assert.equal(texts[0].params.verification, '短信验证');
  assert.equal(emails[0].eventId, texts[0].eventId);
  assert.ok(emails[0].idempotencyKey);
  const repeated = await Promise.all([notifier.notify(event), notifier.notify({...event, taskId: 'task-2', source: 'publish_video'})]);
  assert.deepEqual(repeated.map(statuses), [['suppressed', 'suppressed', 'suppressed'], ['suppressed', 'suppressed', 'suppressed']]);
  clock += 5 * 60 * 1000;
  assert.deepEqual(statuses(await notifier.notify(event)), ['accepted', 'accepted', 'accepted']);
  assert.deepEqual(statuses(await notifier.notify({...event, account: {...event.account, phone: '另一个账号'}})), ['accepted', 'accepted', 'accepted']);
  const isolated = createVerificationNotifier({enabledChannels: ['email', 'sms'], resolveRoutes: () => routes.slice(1), transports: {
    email: {send: () => {throw new Error('secret-password');}}, sms: transports.sms,
  }});
  const failure = await isolated.notify(event);
  assert.deepEqual(statuses(failure), ['failed', 'accepted']);
  assert.ok(!JSON.stringify(failure).includes('secret-password'));
  const timed = createVerificationNotifier({timeoutMs: 5, enabledChannels: ['email'], resolveRoutes: () => [routes[1]], transports: {email: {send: () => new Promise(() => {})}}});
  assert.deepEqual(statuses(await timed.notify(event)), ['timeout']);
  assert.deepEqual(statuses(await timed.notify(event)), ['suppressed'], 'no replay on uncertain delivery');
  const rate = createVerificationNotifier({transports, cooldownMs: 1, maxPerHour: 2, now: () => clock});
  await rate.notify(event); clock += 2; await rate.notify(event); clock += 2;
  assert.deepEqual(statuses(await rate.notify(event)), ['rate_limited']);
  clock += 60 * 60 * 1000;
  assert.deepEqual(statuses(await rate.notify(event)), ['accepted']);
  const invalid = createVerificationNotifier({enabledChannels: ['email'], transports, resolveRoutes: () => [{channel: 'email', recipient: 'ops@example.test\r\nBcc: other@example.test'}]});
  assert.deepEqual(statuses(await invalid.notify(event)), ['invalid_recipient']);
  assert.equal((await notifier.notify({account: {}})).status, 'invalid');
  const broken = createVerificationNotifier({resolveRoutes: () => {throw Error('secret');}});
  assert.equal((await broken.notify(event)).status, 'routing_failed');
  const masked = createVerificationNotifier({transports});
  await masked.notify({...event, account: {phone: '13812345678', pt: '抖音'}});
  assert.equal(popups.at(-1).event.account.name, '138****5678');
  console.log('PASS: channel defaults, safe envelopes, routing, deduplication, limits, failure isolation and timeout without replay');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
