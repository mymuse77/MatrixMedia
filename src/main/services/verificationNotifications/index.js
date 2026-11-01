import { Notification } from 'electron';
const {createVerificationNotifier} = require('./core');
const {auditOperation} = require('../operationAudit');

const desktop = {send: ({message}) => {
  if (!Notification?.isSupported?.()) return false;
  new Notification({title: message.subject, body: message.text, silent: false}).show();
  return true;
}};
let notifier = createVerificationNotifier({transports: {desktop}, audit: auditOperation});

// Main-process configuration only; never expose recipient/provider settings to
// platform pages or accept them from an outreach task. External channels stay
// disabled unless trusted configuration explicitly enables them.
export function configureVerificationNotifications({transports = {}, ...options} = {}) {
  notifier = createVerificationNotifier({...options, transports: {...transports, desktop}, audit: auditOperation});
  auditOperation('notification.configured', {status: 'updated'});
}

export function notifyVerificationRequired(event) {
  // Fire-and-forget callers must not turn provider failures into task failures.
  return notifier.notify(event).catch(() => ({status: 'failed', deliveries: []}));
}
