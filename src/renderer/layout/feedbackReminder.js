export const DAY_MS = 24 * 60 * 60 * 1000;
export const FEEDBACK_REMINDER_DELAY_DAYS = 3;
export const FEEDBACK_REMINDER_TEXT_TYPE = "feedback_reminder";

export function getFeedbackReminderKey(version) {
  return `matrixmedia-feedback-reminder:${version}`;
}

export function buildFeedbackReminderRecord({ version, nowMs, date }) {
  return {
    feedbackReminderKey: getFeedbackReminderKey(version),
    feedbackFirstOpenAt: nowMs,
    feedbackDialogShown: false,
    date,
    textType: FEEDBACK_REMINDER_TEXT_TYPE,
    textOtherName: "MatrixMedia 使用反馈",
    pt: "system",
    selectedFile: `feedback-reminder:${version}`,
    publishStatus: "feedback_reminder_waiting",
    lastPublishMessage: "反馈弹窗等待触发",
    lastPublishAt: nowMs,
  };
}

export function buildFeedbackReminderShownPatch(record, nowMs) {
  return {
    id: record.id,
    date: record.date,
    feedbackDialogShown: true,
    feedbackDialogShownAt: nowMs,
    publishStatus: "feedback_reminder_shown",
    lastPublishMessage: "反馈弹窗已显示",
    lastPublishAt: nowMs,
  };
}

function flattenFeedbackReminderRecords(pushDataResult, version) {
  const data = pushDataResult && pushDataResult.data;
  if (!data || typeof data !== "object") return [];

  return Object.keys(data).reduce((records, date) => {
    const list = Array.isArray(data[date]) ? data[date] : [];
    list.forEach(item => {
      if (item && item.feedbackReminderKey === getFeedbackReminderKey(version)) {
        records.push({
          ...item,
          date: item.date || date,
        });
      }
    });
    return records;
  }, []);
}

export function resolveFeedbackReminderState({ pushDataResult, version, nowMs }) {
  const records = flattenFeedbackReminderRecords(pushDataResult, version).sort(
    (a, b) => Number(a.feedbackFirstOpenAt || 0) - Number(b.feedbackFirstOpenAt || 0)
  );
  const record = records[0];

  if (!record) {
    return { action: "create" };
  }

  if (record.feedbackDialogShown) {
    return { action: "none", record };
  }

  const firstOpenAt = Number(record.feedbackFirstOpenAt);
  if (!Number.isFinite(firstOpenAt)) {
    return { action: "none", record };
  }

  const shouldShow = nowMs - firstOpenAt >= FEEDBACK_REMINDER_DELAY_DAYS * DAY_MS;
  return {
    action: shouldShow ? "show" : "wait",
    record,
  };
}
