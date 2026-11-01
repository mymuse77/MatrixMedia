const crypto = require('crypto');
const { validateTask, fail } = require('./schema');
const { createProductionAdapter } = require('./adapter');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = account => hash([account.id, account.phone, account.pt]);
function createRuntime({ store, adapter = createProductionAdapter(), resolveAccount = async () => null, withAccountOperation = async (_account, run) => run(), audit = () => {} }) {
  const state = store.load();
  const queues = new Map();
  const running = new Map();
  let poisoned = false;
  const log = (event, record, detail = {}) => {try {audit(event, {taskId: record.task.taskId, accountId: record.task.data.account.id,
    accountName: record.task.data.account.phone, platform: record.task.data.account.pt, source: record.task.type, ...detail});} catch (_) {}};
  function save() {
    if (poisoned) fail('Outreach ledger unavailable', 'STORE_UNAVAILABLE');
    try { store.save(state); } catch (error) { poisoned = true; throw error; }
  }
  function envelope(record, extra = {}) {
    return { domain: 'outreach', outreachTaskId: record.task.data.outreachTaskId,
      executionToken: record.task.data.executionToken, ...extra };
  }
  function finish(key, record, data) {
    record.result = data;
    record.status = data.error?.code === 'UNKNOWN' ? 'UNKNOWN' : 'DONE';
    record.events.push({ event: record.status, at: Date.now() });
    state.outbox[key] = { taskId: record.task.taskId, status: data.error ? 'failed' : 'success', data };
    save(); log('task.finished', record, {status: record.status, errorCode: data.error?.code}); return data;
  }
  // Interrupted receipt or execution is never implicitly retried, even for reads.
  for (const [key, record] of Object.entries(state.tasks)) {
    if (!record || !record.task || !Array.isArray(record.events)) fail('Invalid persisted task', 'STORE_UNAVAILABLE');
    if (!['DONE', 'UNKNOWN'].includes(record.status)) {
      const items = (record.task.data.actionItems || []).map(item => {
        const result = record.events.find(event => event.event === 'ACTION_RESULT' && event.actionId === item.actionId);
        return { actionId: item.actionId, status: result?.status || (record.events.some(event => event.event === 'ACTION_INTENT' && event.actionId === item.actionId) ? 'unknown' : 'cancelled') };
      });
      const unknown = items.some(item => item.status === 'unknown');
      finish(key, record, envelope(record, { ...(record.task.type === 'outreach_execute' ? {items} : {}), error: { code: unknown ? 'UNKNOWN' : 'INTERRUPTED', message: 'Restart interrupted task; no automatic replay' } }));
    }
  }
  async function perform(key, record) {
    const task = record.task; const d = task.data;
    try {
      if (record.cancelled) fail('Task cancelled before execution', 'CANCELLED');
      if (Object.values(state.tasks).some(other => other !== record && other.accountKey === record.accountKey && other.status === 'UNKNOWN')) fail('Account has unresolved execution', 'UNKNOWN');
      const account = await resolveAccount(d.account);
      if (!account || identity(account) !== record.accountKey) fail('Exact account id/phone/platform not found', 'ACCOUNT_MISMATCH');
      record.status = 'RUNNING'; record.events.push({ event: 'RUNNING', at: Date.now() }); save();
      log('task.running', record);
      if (task.type !== 'outreach_execute') {
        const operation = task.type.slice('outreach_'.length);
        if (!adapter.capabilities?.[operation]?.verified || !adapter.capabilities?.[operation]?.supported) fail('Read capability unverified', 'UNVERIFIED');
        const data = await adapter.read(operation, d, { account, isCancelled: () => record.cancelled });
        if (record.cancelled) fail('Read cancelled', 'CANCELLED');
        const field = { search: 'works', sync_covers: 'covers', sync_comments: 'comments' }[operation];
        if (!data || !Array.isArray(data[field])) fail('Invalid adapter response', 'INVALID_ADAPTER_RESULT');
        return finish(key, record, envelope(record, { [field]: data[field], ...(operation === 'sync_comments' && data.commentPages ? {commentPages: data.commentPages} : {}) }));
      }
      const items = [];
      for (const item of d.actionItems) {
        if (record.cancelled) { items.push({ actionId: item.actionId, status: 'cancelled' }); continue; }
        if (item.dependsOnActionId && items.find(x => x.actionId === item.dependsOnActionId)?.status !== 'success') {
          items.push({ actionId: item.actionId, status: 'blocked', error: { code: 'DEPENDENCY_FAILED' } }); continue;
        }
        if (!adapter.capabilities?.[item.action]?.verified || !adapter.capabilities?.[item.action]?.supported) {
          items.push({ actionId: item.actionId, status: 'blocked', error: { code: 'UNVERIFIED' } }); continue;
        }
        // Cross-task action IDs cannot be reused to evade the receipt fence.
        const seen = Object.values(state.tasks).some(other => other !== record && other.accountKey === record.accountKey && (other.task.data.actionItems || []).some(x => x.actionId === item.actionId));
        if (seen) { items.push({ actionId: item.actionId, status: 'blocked', error: { code: 'DUPLICATE_ACTION' } }); continue; }
        record.events.push({ event: 'ACTION_INTENT', actionId: item.actionId, at: Date.now() }); save();
        log('action.intent', record, {actionId: item.actionId, status: item.action});
        let outcome;
        try { outcome = await adapter.execute(item, { account, isCancelled: () => record.cancelled }); }
        catch (_) { outcome = { status: 'unknown' }; }
        const status = ['success', 'failed'].includes(outcome?.status) ? outcome.status : 'unknown';
        items.push({ actionId: item.actionId, status, ...(outcome?.error ? {error: outcome.error} : {}) });
        record.events.push({ event: 'ACTION_RESULT', actionId: item.actionId, status, at: Date.now() }); save();
        log('action.result', record, {actionId: item.actionId, status, errorCode: outcome?.error?.code});
        if (status === 'unknown') {
          for (const rest of d.actionItems.slice(items.length)) items.push({ actionId: rest.actionId, status: 'blocked', error: { code: 'UNKNOWN' } });
          return finish(key, record, envelope(record, { items, error: { code: 'UNKNOWN', message: 'Action outcome unknown; no automatic retry' } }));
        }
      }
      return finish(key, record, envelope(record, { items, ...(items.some(x => x.status !== 'success') ? { error: { code: 'ACTIONS_NOT_COMPLETED', message: 'One or more actions blocked or failed' } } : {}) }));
    } catch (error) {
      if (poisoned) throw error;
      const items = (d.actionItems || []).map(item => ({actionId: item.actionId, status: error.code === 'CANCELLED' ? 'cancelled' : 'blocked', error: {code: error.code || 'EXECUTION_FAILED'}}));
      return finish(key, record, envelope(record, { ...(task.type === 'outreach_execute' ? {items} : {}), error: { code: error.code || 'EXECUTION_FAILED', message: error.message } }));
    }
  }
  return {
    capabilities: adapter.capabilities,
    accept(input) {
      if (poisoned) fail('Outreach ledger unavailable', 'STORE_UNAVAILABLE');
      const task = validateTask(input); const key = hash(task.data.outreachTaskId);
      const fingerprint = hash({ type: task.type, data: task.data });
      const existing = state.tasks[key];
      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.task.taskId !== task.taskId) fail('Task identity reused with different payload/token', 'IDEMPOTENCY_CONFLICT');
        if (running.has(key)) return running.get(key);
        if (existing.result) { state.outbox[key] = { taskId: task.taskId, status: existing.result.error ? 'failed' : 'success', data: existing.result }; save(); return Promise.resolve(existing.result); }
        fail('Unresolved receipt', 'UNKNOWN');
      }
      const record = { task, fingerprint, accountKey: identity(task.data.account), status: 'RECEIVED', events: [{ event: 'RECEIVED', at: Date.now() }] };
      state.tasks[key] = record; save();
      log('task.received', record);
      const previous = queues.get(record.accountKey) || Promise.resolve();
      const pending = previous.catch(() => undefined).then(() => withAccountOperation(task.data.account, () => perform(key, record)));
      queues.set(record.accountKey, pending); running.set(key, pending);
      const cleanup = () => { running.delete(key); if (queues.get(record.accountKey) === pending) queues.delete(record.accountKey); };
      pending.then(cleanup, cleanup);
      return pending;
    },
    cancel(outreachTaskId, executionToken) {
      const record = state.tasks[hash(outreachTaskId)];
      if (!record || record.task.data.executionToken !== executionToken || ['DONE', 'UNKNOWN'].includes(record.status)) return false;
      record.cancelled = true; record.events.push({ event: 'CANCEL_REQUESTED', at: Date.now() }); save(); log('task.cancel_requested', record); return true;
    },
    pendingResults() { return JSON.parse(JSON.stringify(Object.values(state.outbox))); },
    acknowledge(receipt) {
      // A transport ACK or generic success is NOT a durable BS commit receipt.
      if (receipt?.domain !== 'outreach' || receipt?.committed !== true) return false;
      const key = hash(receipt.outreachTaskId); const result = state.outbox[key];
      if (!result || result.taskId !== receipt.taskId || result.data.executionToken !== receipt.executionToken) return false;
      delete state.outbox[key]; save(); log('task.result_acknowledged', state.tasks[key]); return true;
    },
  };
}
module.exports = { createRuntime };
