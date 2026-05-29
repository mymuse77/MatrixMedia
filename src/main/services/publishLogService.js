import path from "path";
import { changeData } from "../server/utils";

function now() {
  return Date.now();
}

function dayText(ts = now()) {
  return new Date(ts).toISOString().split("T")[0];
}

function cleanValue(value) {
  return String(value || "").trim();
}

function baseRunFromData(data, runId, startedAt) {
  return {
    id: runId,
    taskId: cleanValue(data.taskId),
    pushDataId: cleanValue(data.id),
    taskName: cleanValue(data.textOtherName || data.bookName || data.taskName),
    platform: cleanValue(data.pt),
    phone: cleanValue(data.phone).split("-")[0],
    partition: cleanValue(data.partition),
    textType: cleanValue(data.textType || "local"),
    videoFile: cleanValue(data.selectedFile || (data.filePath ? path.basename(data.filePath) : "")),
    filePath: cleanValue(data.filePath || data.articleFilePath),
    status: "running",
    startedAt,
    endedAt: null,
    lastMessage: "发布任务已创建",
    screenshotPath: "",
    date: dayText(startedAt),
  };
}

function createRunId(data) {
  return `run-${data.id || data.taskId || "publish"}-${now()}-${Math.floor(Math.random() * 1000)}`;
}

export function createPublishRun(data = {}) {
  const startedAt = now();
  const runId = cleanValue(data.publishRunId) || createRunId(data);
  const run = baseRunFromData(data, runId, startedAt);

  changeData({
    fileName: "publishRuns",
    type: "add",
    item: run,
  });

  appendPublishRunLog(runId, {
    date: run.date,
    level: "info",
    stage: "created",
    message: "发布任务已创建",
    data,
  });

  return run;
}

export function appendPublishRunLog(runId, input = {}) {
  if (!runId) return null;
  const ts = now();
  const item = {
    id: `${runId}-${ts}-${Math.floor(Math.random() * 1000)}`,
    runId,
    time: ts,
    level: input.level || "info",
    stage: input.stage || "general",
    message: input.message || "",
    detail: input.detail || "",
    date: input.date || dayText(ts),
  };

  changeData({
    fileName: "publishRunLogs",
    type: "add",
    item,
  });

  return item;
}

export function updatePublishRun(run, patch = {}) {
  if (!run?.id || !run?.date) return;
  changeData({
    fileName: "publishRuns",
    type: "update",
    item: {
      id: run.id,
      date: run.date,
      ...patch,
      lastMessage: patch.lastMessage || patch.message || run.lastMessage,
    },
  });
}

export function finishPublishRun(run, payload = {}) {
  if (!run?.id) return;
  const skipped = Boolean(payload.skipped);
  const interrupted = Boolean(payload.interrupted);
  const success = payload.status === true;
  const status = success ? "success" : skipped ? "skipped" : interrupted ? "interrupted" : "failed";
  const message =
    payload.message ||
    (success ? "发布成功" : skipped ? "用户关闭窗口，已跳过发布" : interrupted ? "发布已中断" : "发布失败");

  appendPublishRunLog(run.id, {
    date: run.date,
    level: success ? "success" : skipped ? "warn" : "error",
    stage: "finished",
    message,
  });
  updatePublishRun(run, {
    status,
    endedAt: now(),
    lastMessage: message,
    screenshotPath: payload.screenshotPath || run.screenshotPath || "",
  });
}
