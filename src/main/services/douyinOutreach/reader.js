const { fail } = require('./schema');

// Runs only inside a dedicated account window. No cookies, hidden state, or private
// endpoints are exported. Selectors and account identity still require a live probe.
function verificationSnapshot() {
  const visible = element => {
    const style = window.getComputedStyle(element);
    return element.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const panels = Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="login-panel"],[class*="login-modal"],[id*="captcha"],[class*="captcha"],iframe[src*="verify"],iframe[src*="captcha"]')).filter(visible);
  const verification = /(安全验证|身份验证|拖动滑块|请输入验证码|短信验证码|获取验证码)/;
  const login = /(扫码登录|二维码登录|请先登录|登录后继续|登录已过期|登录已失效)/;
  const challengeType = text => /短信|获取验证码/.test(text) ? 'sms' : /扫码|二维码/.test(text) ? 'qr_login' : 'captcha';
  for (const panel of panels) {
    const text = panel.innerText || '';
    if (panel.tagName === 'IFRAME' || verification.test(text) || /captcha/i.test(panel.id + ' ' + panel.className)) return {blocked: true, reason: 'verification', challengeType: challengeType(text)};
    if (login.test(text)) return {blocked: true, reason: 'login', challengeType: /扫码|二维码/.test(text) ? 'qr_login' : 'login'};
  }
  if (/\/login(?:\/|$)/.test(location.pathname)) return {blocked: true, reason: 'login', challengeType: 'login'};
  // Do not treat a video's caption discussing QR codes as an actual login wall.
  const hasContent = document.querySelector('a[href*="/video/"],a[href*="/note/"],video,[data-e2e="video-desc"],[data-comment-id]');
  if (!hasContent) {
    const body = document.body?.innerText || '';
    if (verification.test(body)) return {blocked: true, reason: 'verification', challengeType: challengeType(body)};
    if (login.test(body)) return {blocked: true, reason: 'login', challengeType: /扫码|二维码/.test(body) ? 'qr_login' : 'login'};
  }
  return {blocked: false};
}

function visibleSnapshot() {
  const works = Array.from(document.querySelectorAll('a[href*="/video/"],a[href*="/note/"]')).map(link => {
    const match = link.href.match(/^https:\/\/www\.douyin\.com\/(video|note)\/(\d{5,30})/);
    if (!match) return null;
    const card = link.closest('[data-e2e="search-result"],.search-result-card') || link.closest('li') || link.parentElement;
    const user = card?.querySelector('a[href*="/user/"]');
    const rawUserId = user?.href.match(/\/user\/([^/?#]+)/)?.[1] || '';
    const userId = rawUserId === 'self' ? '' : rawUserId;
    // These fallback classes were observed on the live video search page. A
    // changed layout must leave a field empty rather than mixing card metadata.
    const description = card?.querySelector('[data-e2e="video-desc"],.VDYK8Xd7');
    const authorName = user || card?.querySelector('.MZNczJmS');
    return {platformWorkId: match[2], contentType: match[1] === 'note' ? 'image' : 'video', url: `https://www.douyin.com/${match[1]}/${match[2]}`, title: '',
      description: (link.getAttribute('title') || description?.textContent || '').trim().slice(0,10000),
      author: {id: userId, name: (authorName?.textContent || '').trim().slice(0,500)}};
  }).filter(Boolean);
  const comments = Array.from(document.querySelectorAll('[data-comment-id],[data-cid]')).map(element => {
    const platformCommentId = element.getAttribute('data-comment-id') || element.getAttribute('data-cid');
    const user = element.querySelector('a[href*="/user/"]');
    const text = element.querySelector('[data-e2e="comment-content"]')?.textContent;
    if (!platformCommentId || !text) return null;
    return {platformCommentId, text: text.trim().slice(0,10000), author: {id: user?.href.match(/\/user\/([^/?#]+)/)?.[1] || '', name: (user?.textContent || '').trim().slice(0,500)},
      ...(element.getAttribute('data-parent-comment-id') ? {parentCommentId: element.getAttribute('data-parent-comment-id')} : {})};
  }).filter(Boolean);
  const coverUrl = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
  return {works, comments, coverUrl};
}

async function readVisibleContent(operation, data, {account, isCancelled}, openWindow, options = {}) {
  if (!openWindow) fail('Account window reader unavailable', 'UNVERIFIED');
  const now = options.now || Date.now;
  const startedAt = now();
  const traceId = require('crypto').randomUUID();
  const audit = options.audit || require('../operationAudit').auditOperation;
  const context = {traceId, taskId: data.outreachTaskId, accountId: account.id, accountName: account.phone,
    platform: account.pt, source: `outreach_${operation}`};
  const log = (event, detail = {}) => {try {audit(event, {...context, ...detail});} catch (_) {}};
  const success = result => {log('read.completed', {count: (result.works || result.covers || result.comments || []).length, durationMs: now() - startedAt}); return result;};
  log('read.started');
  let win;
  try {win = await openWindow(account);} catch (error) {log('read.failed', {errorCode: error.code || 'WINDOW_OPEN_FAILED'}); throw error;}
  const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const verificationTimeoutMs = options.verificationTimeoutMs ?? 10 * 60 * 1000;
  let keepWindow = false;
  let presented = false;
  const releaseTop = () => {if (!win.isDestroyed()) win.setAlwaysOnTop?.(false);};
  const snapshot = async (url, waitForSearchResults = false) => {
    if (isCancelled()) fail('Read cancelled', 'CANCELLED');
    await win.loadURL(url);
    let deadline = now() + 15000;
    let verificationDeadline;
    do {
      if (isCancelled()) fail('Read cancelled', 'CANCELLED');
      if (win.isDestroyed()) fail('验证窗口已关闭，请重新发起读取', 'WINDOW_CLOSED');
      const state = await win.webContents.executeJavaScript(`(${verificationSnapshot.toString()})()`);
      if (state?.blocked) {
        if (verificationDeadline === undefined) verificationDeadline = now() + verificationTimeoutMs;
        if (!presented) {
          log('verification.detected', {challengeType: state.challengeType || state.reason});
          keepWindow = true;
          let windowShown = false;
          try {windowShown = options.revealWindow?.(win) === true;} catch (_) {}
          log('verification.window', {windowShown});
          try {
            Promise.resolve(options.notifyVerification?.({source: `outreach_${operation}`, taskId: data.outreachTaskId,
              traceId, clientId: data.clientId, account, challengeType: state.challengeType || (state.reason === 'login' ? 'login' : 'verification'), windowShown})).catch(() => {log('notification.callback_failed', {errorCode: 'NOTIFICATION_FAILED'});});
          } catch (_) {log('notification.callback_failed', {errorCode: 'NOTIFICATION_FAILED'});} // Never interrupt verification.
          if (!windowShown) fail('验证窗口未能主动显示，请手动打开对应账号窗口后重试', 'VERIFICATION_WINDOW_UNAVAILABLE');
          presented = true;
          console.warn(`[outreach] ${account.phone}：请在弹出的抖音窗口完成${state.reason === 'login' ? '扫码登录' : '验证码验证'}，读取任务正在等待`);
        }
        if (now() >= verificationDeadline) fail('等待人工验证超时，已保留对应账号窗口；完成验证后请重新发起读取', 'VERIFICATION_TIMEOUT');
        await wait(250);
        continue;
      }
      if (presented) {log('verification.cleared'); releaseTop(); presented = false; keepWindow = false; verificationDeadline = undefined; deadline = now() + 15000;}
      if (!win.webContents.getURL().startsWith('https://www.douyin.com/')) fail('页面跳转异常，请检查账号窗口后重新读取', 'VERIFICATION_REQUIRED');
      const result = await win.webContents.executeJavaScript(`(${visibleSnapshot.toString()})()`);
      const ready = waitForSearchResults ? result.works?.length : operation === 'sync_covers' ? result.coverUrl : result.comments?.length;
      if (ready || (!waitForSearchResults && now() >= deadline)) return result;
      await wait(250);
    } while (verificationDeadline !== undefined || now() <= deadline);
    fail('Search results were not ready; an empty result was not confirmed', 'READ_NOT_READY');
  };
  try {
    if (operation === 'search') {
      const works = new Map();
      for (const keyword of data.keywords) {
        const result = await snapshot(`https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`, true);
        for (const work of result.works || []) {if (works.size < 200) works.set(work.platformWorkId, {...work,id: work.platformWorkId});}
      }
      return success({works: [...works.values()]});
    }
    if (operation === 'sync_covers') {
      const covers = [];
      for (const work of data.works) {const result = await snapshot(work.url); if (result.coverUrl) covers.push({workId: work.id, coverUrl: result.coverUrl});}
      return success({covers});
    }
    if (operation === 'sync_comments') {
      const comments = []; const commentPages = [];
      for (const work of data.works) {
        const result = await snapshot(work.url);
        comments.push(...(result.comments || []).slice(0,200).map(comment => ({...comment,id: `${work.id}/${comment.platformCommentId}`,workId: work.id})));
        commentPages.push({workId: work.id, status: 'partial'});
      }
      return success({comments: comments.slice(0,2000), commentPages});
    }
    fail('Unsupported read operation', 'UNSUPPORTED_CAPABILITY');
  } catch (error) {
    log(error.code === 'CANCELLED' ? 'read.cancelled' : 'read.failed', {errorCode: error.code || 'READ_FAILED', durationMs: now() - startedAt});
    throw error;
  } finally {
    if (!win.isDestroyed()) {releaseTop(); const retained = keepWindow && !isCancelled(); if (!retained) win.close(); log('read.window_finished', {retained});}
  }
}
module.exports = { verificationSnapshot, visibleSnapshot, readVisibleContent };
