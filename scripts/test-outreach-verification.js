const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const {verificationSnapshot, readVisibleContent} = require('../src/main/services/douyinOutreach/reader');

function classify({panels = [], body = '', content = false, pathname = '/search/test'} = {}) {
  return vm.runInNewContext(`(${verificationSnapshot.toString()})()`, {
    location: {pathname}, window: {getComputedStyle: () => ({display: 'block', visibility: 'visible'})},
    document: {body: {innerText: body}, querySelectorAll: () => panels, querySelector: () => content ? {} : null},
  });
}
const panel = (text, hidden = false) => ({innerText: text, id: '', className: '', tagName: 'DIV', getClientRects: () => hidden ? [] : [{}]});

async function main() {
  assert.equal(classify({panels: [panel('请完成安全验证')]}).reason, 'verification');
  assert.equal(classify({panels: [panel('扫码登录')]}).reason, 'login');
  assert.equal(classify({pathname: '/login'}).reason, 'login');
  assert.equal(classify({panels: [panel('扫码登录', true)], content: true}).blocked, false);
  assert.equal(classify({body: '视频介绍：扫码登录教程', content: true}).blocked, false);
  const presentationSource = fs.readFileSync(require.resolve('../src/main/services/publishWindowPresentation.js'), 'utf8');
  const {revealPublishVerificationWindow} = await import(`data:text/javascript;base64,${Buffer.from(presentationSource).toString('base64')}`);
  const account = {phone: '测试账号', pt: '抖音'};
  function fixture(states) {
    let index = 0, clock = 0, cancelled = false;
    const events = [];
    const win = {
      isDestroyed: () => false, isMinimized: () => true, isVisible: () => false,
      restore: () => events.push('restore'), setAlwaysOnTop: value => events.push(`top:${value}`),
      show: () => events.push('show'), focus: () => events.push('focus'), moveTop: () => events.push('moveTop'),
      close: () => events.push('close'), removeMenu: () => {},
      loadURL: async () => events.push('load'),
      webContents: {getURL: () => 'https://www.douyin.com/search/test', executeJavaScript: async source => {
        if (source.includes('function verificationSnapshot')) return states[Math.min(index++, states.length - 1)];
        return {works: [{platformWorkId: '123456789', description: '袜子', author: {name: '作者'}}], coverUrl: 'https://p3.douyinpic.com/test.jpg', comments: [{platformCommentId: 'comment', text: '内容'}]};
      }},
    };
    return {events, win, cancel: () => {cancelled = true;}, run: (operation, extra = {}) => readVisibleContent(operation,
      {keywords: ['袜子'], works: [{id: 'work', url: 'https://www.douyin.com/video/123456789'}]},
      {account, isCancelled: () => cancelled}, async () => win,
      {revealWindow: revealPublishVerificationWindow, audit: () => {}, now: () => clock, wait: async ms => {clock += ms;}, verificationTimeoutMs: 500, ...extra})};
  }
  for (const operation of ['search', 'sync_covers', 'sync_comments']) {
    const f = fixture([{blocked: true, reason: 'login'}, {blocked: true, reason: 'login'}, {blocked: false}]);
    const notices = [];
    const audit = [];
    const result = await f.run(operation, {audit: (name, detail) => audit.push({name, detail}), notifyVerification: async notice => {notices.push(notice); throw Error('provider failed');}});
    assert.ok(result.works || result.covers || result.comments);
    assert.equal(f.events.filter(x => x === 'load').length, 1, 'resume without reloading or switching accounts');
    assert.equal(f.events.filter(x => x === 'show').length, 1);
    assert.equal(notices.length, 1, 'one notification per challenge, independent of provider errors');
    assert.equal(notices[0].account.phone, '测试账号');
    assert.equal(notices[0].source, `outreach_${operation}`);
    assert.equal(notices[0].windowShown, true);
    for (const name of ['read.started', 'verification.detected', 'verification.window', 'verification.cleared', 'read.completed']) assert.ok(audit.some(row => row.name === name));
    assert.equal(audit.find(row => row.name === 'read.started').detail.traceId, notices[0].traceId);
    assert.ok(f.events.includes('restore') && f.events.includes('focus') && f.events.includes('top:true'));
    assert.ok(f.events.indexOf('top:false') < f.events.indexOf('close'));
  }
  const timed = fixture([{blocked: true, reason: 'verification'}]);
  await assert.rejects(timed.run('search'), e => e.code === 'VERIFICATION_TIMEOUT');
  assert.ok(timed.events.includes('show'));
  assert.ok(!timed.events.includes('close'), 'keep verification window available after timeout');
  const cancelled = fixture([{blocked: true, reason: 'verification'}]);
  await assert.rejects(cancelled.run('search', {wait: async () => cancelled.cancel()}), e => e.code === 'CANCELLED');
  assert.ok(cancelled.events.includes('close'));
  const failed = fixture([{blocked: true, reason: 'login'}]);
  let popupFailureNotice;
  await assert.rejects(failed.run('search', {revealWindow: () => false, notifyVerification: notice => {popupFailureNotice = notice;}}), e => e.code === 'VERIFICATION_WINDOW_UNAVAILABLE');
  assert.equal(popupFailureNotice.windowShown, false);
  assert.ok(!failed.events.includes('close'));
  console.log('PASS: visible challenge detection, shared publish popup, resume all read operations, timeout retention and cancellation');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
