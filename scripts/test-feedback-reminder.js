"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { buildSync } = require("esbuild");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "test/.cache");
fs.mkdirSync(outDir, { recursive: true });

const bundlePath = path.join(outDir, "feedbackReminder.cjs");

buildSync({
  entryPoints: [path.join(root, "src/renderer/layout/feedbackReminder.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: bundlePath,
});

const {
  DAY_MS,
  buildFeedbackReminderRecord,
  buildFeedbackReminderShownPatch,
  getFeedbackReminderKey,
  resolveFeedbackReminderState,
} = require(bundlePath);

const version = "0.7.1";
const nowMs = new Date("2026-05-22T00:00:00.000Z").getTime();

const createState = resolveFeedbackReminderState({
  pushDataResult: { success: true, data: {} },
  version,
  nowMs,
});
assert.strictEqual(createState.action, "create");

const newRecord = buildFeedbackReminderRecord({
  version,
  nowMs,
  date: "2026-05-22",
});
assert.strictEqual(newRecord.feedbackReminderKey, getFeedbackReminderKey(version));
assert.strictEqual(newRecord.feedbackFirstOpenAt, nowMs);
assert.strictEqual(newRecord.feedbackDialogShown, false);
assert.strictEqual(newRecord.date, "2026-05-22");

const twoDaysRecord = {
  ...newRecord,
  id: "reminder-1",
  date: "2026-05-22",
  feedbackFirstOpenAt: nowMs - DAY_MS * 2,
};
const waitState = resolveFeedbackReminderState({
  pushDataResult: {
    success: true,
    data: {
      "2026-05-22": [twoDaysRecord],
    },
  },
  version,
  nowMs,
});
assert.strictEqual(waitState.action, "wait");

const threeDaysRecord = {
  ...twoDaysRecord,
  feedbackFirstOpenAt: nowMs - DAY_MS * 3,
};
const showState = resolveFeedbackReminderState({
  pushDataResult: {
    success: true,
    data: {
      "2026-05-19": [{ ...threeDaysRecord, date: undefined }],
    },
  },
  version,
  nowMs,
});
assert.strictEqual(showState.action, "show");
assert.strictEqual(showState.record.date, "2026-05-19");

const shownState = resolveFeedbackReminderState({
  pushDataResult: {
    success: true,
    data: {
      "2026-05-17": [
        {
          ...threeDaysRecord,
          feedbackDialogShown: true,
          feedbackDialogShownAt: nowMs - DAY_MS,
        },
      ],
    },
  },
  version,
  nowMs,
});
assert.strictEqual(shownState.action, "none");

const shownPatch = buildFeedbackReminderShownPatch(showState.record, nowMs);
assert.deepStrictEqual(shownPatch, {
  id: "reminder-1",
  date: "2026-05-19",
  feedbackDialogShown: true,
  feedbackDialogShownAt: nowMs,
  publishStatus: "feedback_reminder_shown",
  lastPublishMessage: "反馈弹窗已显示",
  lastPublishAt: nowMs,
});

console.log("test:feedback-reminder 全部通过");
