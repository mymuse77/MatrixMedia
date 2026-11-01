const { ACTIONS, fail } = require('./schema');
const OPERATIONS = ['search', 'sync_covers', 'sync_comments', ...ACTIONS];
// No positive claim until an exact account and an actual read/write adapter have
// been verified. In particular, opening a page is not evidence of a sent action.
const capabilities = Object.freeze(Object.fromEntries(OPERATIONS.map(action => [action,
  Object.freeze({ supported: false, verified: false, reason: 'UNVERIFIED' }),
])));
function createProductionAdapter({openWindow, revealWindow, notifyVerification} = {}) {
  return {
    capabilities,
    async read(operation, data, context) {
      // Runtime checks capabilities before entering. This implementation remains
      // disabled until the designated account and DOM selectors are verified.
      return require('./reader').readVisibleContent(operation, data, context, openWindow, {revealWindow, notifyVerification});
    },
    async execute() { fail('Douyin outbound adapter unverified; no platform operation performed', 'UNVERIFIED'); },
  };
}
module.exports = { capabilities, createProductionAdapter };
