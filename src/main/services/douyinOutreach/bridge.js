const { createRuntime } = require('./runtime');
const { defaultStore } = require('./store');
const { TYPES } = require('./schema');
const { createProductionAdapter } = require('./adapter');
const {withAccountOperation} = require('../accountOperationLock');

function registerOutreachHandlers(wsClient, {resolveAccount, openWindow, revealWindow, notifyVerification, store, adapter, audit = () => {}} = {}) {
  wsClient.getOutreachRuntime = () => {
    if (!wsClient.outreachRuntime) wsClient.outreachRuntime = createRuntime({
      store: store || defaultStore(`${wsClient.serverUrl}|${wsClient.clientId}`),
      adapter: adapter || createProductionAdapter({openWindow, revealWindow, notifyVerification}), resolveAccount, withAccountOperation,
      audit,
    });
    return wsClient.outreachRuntime;
  };
  for (const type of TYPES) wsClient.registerTaskHandler(type, task => wsClient.getOutreachRuntime().accept(task));
  wsClient.registerTaskHandler('outreach_cancel', async task => {
    const data = task?.data;
    if (!data || typeof data.outreachTaskId !== 'string' || typeof data.executionToken !== 'string') throw new Error('Invalid cancellation');
    return {action: 'outreach_cancel', accepted: wsClient.getOutreachRuntime().cancel(data.outreachTaskId, data.executionToken)};
  });
}
module.exports = {registerOutreachHandlers};
