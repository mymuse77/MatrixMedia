const fs = require('fs');
const path = require('path');
const text = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160);
const fields = ['traceId', 'eventId', 'taskId', 'actionId', 'accountId', 'accountName', 'platform', 'source', 'challengeType', 'channel', 'status', 'errorCode', 'recipientHash'];

function createAuditLogger({directory, maxBytes = 5 * 1024 * 1024, backups = 5, now = Date.now, onError = () => console.error('[Audit] 操作日志写入失败，请检查磁盘空间和权限')} = {}) {
  if (!directory || !Number.isInteger(backups) || backups < 1 || backups > 20 || !Number.isFinite(maxBytes) || maxBytes < 256) throw new Error('Invalid audit configuration');
  const file = path.join(directory, 'operations.jsonl');
  return {file, record(event, detail = {}) {
    try {
      if (!/^[a-z][a-z0-9_.-]{0,79}$/.test(event)) throw Error('Invalid event');
      const row = {timestamp: new Date(now()).toISOString(), event};
      for (const key of fields) if (detail[key] !== undefined) {
        let value = text(detail[key]);
        if (key === 'accountName' && /^\+?\d{7,15}$/.test(value)) value = `${value.slice(0, 3)}****${value.slice(-4)}`;
        if (key === 'errorCode' && !/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) value = 'UNCLASSIFIED_ERROR';
        row[key] = value;
      }
      for (const key of ['windowShown', 'retained']) if (typeof detail[key] === 'boolean') row[key] = detail[key];
      for (const key of ['count', 'durationMs']) if (Number.isFinite(detail[key]) && detail[key] >= 0) row[key] = detail[key];
      const line = JSON.stringify(row) + '\n';
      fs.mkdirSync(directory, {recursive: true});
      if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > maxBytes) {
        const oldest = `${file}.${backups}`;
        if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
        for (let index = backups - 1; index >= 1; index--) if (fs.existsSync(`${file}.${index}`)) fs.renameSync(`${file}.${index}`, `${file}.${index + 1}`);
        fs.renameSync(file, `${file}.1`);
      }
      fs.appendFileSync(file, line, {encoding: 'utf8', mode: 0o600});
      return true;
    } catch (_) {
      try {onError();} catch (_) {}
      return false;
    }
  }};
}

let logger;
function auditOperation(event, detail) {
  try {
    if (!logger) logger = createAuditLogger({directory: path.join(require('electron').app.getPath('userData'), 'logs')});
    return logger.record(event, detail);
  } catch (_) {
    console.error('[Audit] 操作日志初始化失败，请检查客户端日志目录');
    return false;
  }
}
module.exports = {createAuditLogger, auditOperation};
