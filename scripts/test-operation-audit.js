const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {createAuditLogger} = require('../src/main/services/operationAudit');
const {createVerificationNotifier} = require('../src/main/services/verificationNotifications/core');
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-operation-audit-'));
  try {
    const logger = createAuditLogger({directory, now: () => 1000});
    assert.equal(logger.record('verification.detected', {traceId: 'trace', taskId: 'task', accountName: '13812345678', code: 'secret-code', cookie: 'secret-cookie', recipient: 'secret@example.test', errorCode: 'password=secret'}), true);
    const reopened = createAuditLogger({directory});
    reopened.record('verification.cleared', {traceId: 'trace', taskId: 'task'});
    const rows = fs.readFileSync(logger.file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].accountName, '138****5678');
    assert.equal(rows[0].errorCode, 'UNCLASSIFIED_ERROR');
    assert.equal(rows[0].traceId, rows[1].traceId);
    assert.ok(!JSON.stringify(rows).includes('secret'));
    const notifier = createVerificationNotifier({audit: reopened.record, transports: {desktop: {send: async () => true}}});
    const event = {traceId: 'notification-trace', taskId: 'task', source: 'outreach_search', account: {phone: '测试', pt: '抖音'}, challengeType: 'sms'};
    await notifier.notify(event); await notifier.notify(event);
    const auditRows = fs.readFileSync(logger.file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(auditRows.some(row => row.event === 'notification.attempt'));
    assert.ok(auditRows.some(row => row.event === 'notification.result' && row.status === 'accepted'));
    assert.ok(auditRows.some(row => row.event === 'notification.result' && row.status === 'suppressed'));
    const rotateDir = path.join(directory, 'rotation');
    const rotation = createAuditLogger({directory: rotateDir, maxBytes: 512, backups: 2});
    for (let index = 0; index < 30; index++) assert.equal(rotation.record('read.started', {taskId: `task-${index}`, source: 'outreach_search'}), true);
    const files = fs.readdirSync(rotateDir);
    assert.deepEqual(files.sort(), ['operations.jsonl', 'operations.jsonl.1', 'operations.jsonl.2']);
    for (const file of files) fs.readFileSync(path.join(rotateDir, file), 'utf8').trim().split('\n').forEach(line => JSON.parse(line));
    const blockedDir = path.join(directory, 'not-a-directory'); fs.writeFileSync(blockedDir, 'file');
    let errors = 0;
    const broken = createAuditLogger({directory: blockedDir, onError: () => {errors++;}});
    assert.equal(broken.record('read.started'), false); assert.equal(errors, 1);
    console.log('PASS: persistent JSONL, trace correlation, notification outcomes, redaction, rotation and observable write failure');
  } finally {fs.rmSync(directory, {recursive: true, force: true});}
}
main().catch(error => {console.error(error); process.exitCode = 1;});
