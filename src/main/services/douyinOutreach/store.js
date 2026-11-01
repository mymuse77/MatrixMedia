const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// One atomic snapshot holds receipt, action intent, result and independent outbox.
// Never recover a corrupt store as empty: that would permit replaying side effects.
function createStore(file) {
  return {
    load() {
      if (!fs.existsSync(file)) return { version: 1, tasks: {}, outbox: {} };
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state.version !== 1 || !state.tasks || !state.outbox || Array.isArray(state.tasks) || Array.isArray(state.outbox)) throw new Error('Invalid outreach ledger; manual recovery required');
      return state;
    },
    save(state) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      let fd;
      try {
        fd = fs.openSync(temp, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        fs.renameSync(temp, file);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      }
    },
  };
}
function defaultStore(scope) {
  const { app } = require('electron');
  const key = crypto.createHash('sha256').update(scope).digest('hex');
  return createStore(path.join(app.getPath('userData'), 'douyin-outreach', `${key}.json`));
}
module.exports = { createStore, defaultStore };
