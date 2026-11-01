const queues = new Map();
const busy = new Set();
function accountKey(account) {return `${account.pt || account.platform || ''}|${account.phone || ''}`;}
function next(key) {
  if (busy.has(key)) return;
  const queue = queues.get(key);
  if (!queue?.length) {queues.delete(key); return;}
  queue.sort((a,b) => b.priority - a.priority);
  const entry = queue.shift(); busy.add(key);
  let released = false;
  entry.resolve(() => {if (released) return; released = true; busy.delete(key); next(key);});
}
function acquireAccountOperation(account, priority = 0) {
  const key = accountKey(account);
  return new Promise(resolve => {if (!queues.has(key)) queues.set(key,[]); queues.get(key).push({resolve,priority}); next(key);});
}
async function withAccountOperation(account, run) {const release = await acquireAccountOperation(account); try {return await run();} finally {release();}}
module.exports = {acquireAccountOperation, withAccountOperation};
