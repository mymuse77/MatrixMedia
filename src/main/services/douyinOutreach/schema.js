const TYPES = ['outreach_search', 'outreach_sync_covers', 'outreach_sync_comments', 'outreach_execute'];
const ACTIONS = ['follow', 'message', 'comment', 'reply'];
function fail(message, code = 'INVALID_SCHEMA') { const error = new Error(message); error.code = code; throw error; }
function object(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail(`${name}: invalid object or unknown fields`);
}
function text(value, name, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) fail(`${name}: invalid string`);
}
function work(value) {
  object(value, ['id', 'platformWorkId', 'url'], 'work');
  text(value.id, 'work.id'); text(value.platformWorkId, 'work.platformWorkId');
  if (!/^\d{5,30}$/.test(value.platformWorkId)) fail('Invalid platform work id');
  let url; try { url = new URL(value.url); } catch (_) { fail('Invalid work URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'www.douyin.com' || url.port || url.username || url.password || url.search || url.hash || ![`/video/${value.platformWorkId}`, `/note/${value.platformWorkId}`].includes(url.pathname)) fail('Work URL must exactly match platformWorkId');
}
function validateTask(task) {
  object(task, ['taskId', 'type', 'data', 'timestamp', 'protocolVersion'], 'task');
  text(task.taskId, 'taskId');
  if (!TYPES.includes(task.type)) fail('Unknown outreach task type', 'UNSUPPORTED_CAPABILITY');
  const d = task.data;
  object(d, ['schemaVersion', 'outreachTaskId', 'executionToken', 'account', 'keywords', 'works', 'actionItems', 'clientId'], 'data');
  if (d.schemaVersion !== 1) fail('Outreach schemaVersion 1 required', 'UNSUPPORTED_PROTOCOL');
  text(d.outreachTaskId, 'outreachTaskId'); text(d.executionToken, 'executionToken');
  if (task.taskId !== d.outreachTaskId) fail('Task id does not match outreach task id');
  object(d.account, ['id', 'phone', 'pt'], 'account');
  text(d.account.id, 'account.id'); text(d.account.phone, 'account.phone');
  if (d.account.pt !== '抖音') fail('Only explicit Douyin account supported');
  if (task.type === 'outreach_search') {
    if (!Array.isArray(d.keywords) || !d.keywords.length || d.keywords.length > 20 || d.works !== undefined || d.actionItems !== undefined) fail('Search requires keywords only');
    d.keywords.forEach(x => text(x, 'keyword', 100));
  } else if (task.type !== 'outreach_execute') {
    if (!Array.isArray(d.works) || !d.works.length || d.works.length > 50 || d.keywords !== undefined || d.actionItems !== undefined) fail('Sync requires selected works only');
    d.works.forEach(work);
    if (new Set(d.works.map(x => x.id)).size !== d.works.length) fail('Duplicate works');
  } else {
    if (d.keywords !== undefined || d.works !== undefined || !Array.isArray(d.actionItems) || !d.actionItems.length || d.actionItems.length > 100) fail('Execute requires actionItems only');
    const prior = new Map();
    d.actionItems.forEach(item => {
      object(item, ['actionId', 'action', 'target', 'text', 'dependsOnActionId'], 'actionItem');
      text(item.actionId, 'actionId');
      if (prior.has(item.actionId)) fail('Duplicate actionId');
      if (!ACTIONS.includes(item.action)) fail('Unknown action', 'UNSUPPORTED_CAPABILITY');
      object(item.target, ['work', 'platformUserId', 'platformCommentId'], 'target');
      work(item.target.work);
      if (['follow', 'message'].includes(item.action)) text(item.target.platformUserId, 'platformUserId');
      if (item.action === 'reply') text(item.target.platformCommentId, 'platformCommentId');
      if (item.action === 'comment' && item.target.platformCommentId !== undefined) fail('Top-level comment cannot target a comment');
      if (item.action === 'follow') { if (item.text !== undefined) fail('Follow cannot contain text'); }
      else text(item.text, 'text', 2000);
      if (item.dependsOnActionId !== undefined) {
        const dependency = prior.get(item.dependsOnActionId);
        if (!dependency || dependency.action !== 'follow' || item.action !== 'message' || dependency.target.platformUserId !== item.target.platformUserId) fail('Dependency must be preceding follow of same user');
      }
      prior.set(item.actionId, item);
    });
  }
  return JSON.parse(JSON.stringify(task));
}
module.exports = { TYPES, ACTIONS, validateTask, fail };
