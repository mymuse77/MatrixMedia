'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createPublishResultStore(serverUrl, clientId) {
  const { app } = require('electron');
  if (!app || typeof app.getPath !== 'function') {
    throw new Error('发布结果存储需要 Electron 用户数据目录');
  }
  const scope = crypto.createHash('sha256').update(`${serverUrl}\n${clientId}`).digest('hex').slice(0, 16);
  const filePath = path.join(app.getPath('userData'), `publish-results-${scope}.json`);
  return {
    load() {
      if (!fs.existsSync(filePath)) return [];
      const records = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!Array.isArray(records)) throw new Error('发布结果队列格式无效');
      return records;
    },
    save(records) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      const fd = fs.openSync(temporaryPath, 'w', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(records), 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporaryPath, filePath);
    },
  };
}

module.exports = { createPublishResultStore };
