"use strict";

require("@babel/register")({
  extensions: [".js"],
  ignore: [/node_modules/],
  babelrc: false,
  configFile: false,
  presets: [["@babel/preset-env", { modules: "commonjs", targets: { node: "current" } }]],
});

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const records = [];
const changeDataCalls = [];
const downloadCalls = [];
const publishPayloads = [];
const notifications = [];
const queuedPublishReplies = [];
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrixmedia-scheduled-execution-"));

function cloneRecord(record) {
  return record && typeof record === "object" ? { ...record } : record;
}

function getRecordsByDate() {
  return records.reduce((result, record) => {
    const date = record.date || "2026-08-03";
    result[date] = result[date] || [];
    result[date].push(cloneRecord(record));
    return result;
  }, {});
}

function changeData(payload) {
  changeDataCalls.push(payload);
  const item = payload?.item || {};
  if (payload?.type === "add") {
    records.push(cloneRecord(item));
    return { success: true };
  }
  if (payload?.type === "update") {
    const target = records.find((record) => record.id === item.id && record.date === item.date);
    if (target) Object.assign(target, item);
    return { success: true };
  }
  if (payload?.type === "delete") {
    const index = records.findIndex((record) => record.id === item.id && record.date === item.date);
    if (index >= 0) records.splice(index, 1);
    return { success: true };
  }
  if (payload?.type === "get") {
    return { success: true, data: getRecordsByDate() };
  }
  return { success: true };
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => path.join(tempDir, "documents") },
      ipcMain: { on() {} },
    };
  }

  if (request === "../server/utils") {
    return { changeData };
  }

  if (request === "../config/ptConfig") {
    return {
      __esModule: true,
      default: {
        ["抖音"]: {
          upload: "https://creator.douyin.com/creator-micro/content/post/video",
          useragent: "MatrixMediaScheduledTest/1.0",
        },
      },
    };
  }

  if (request === "../../shared/creativeStatement.js") {
    return { normalizeCreativeStatement: (value) => value || null };
  }

  if (request === "./publishNotification") {
    return { notifyPublishSuccess: (payload) => notifications.push(payload) };
  }

  if (request === "./appSettings") {
    return { getAppSettings: () => ({ webSocketServerUrl: "https://matrix.example.com" }) };
  }

  if (request === "./resolvePublishFile") {
    return {
      isRemotePublishFile: (file) => /^https?:\/\//i.test(String(file || "").trim()),
      resolvePublishFile: async (file, options = {}) => {
        const remoteUrl = String(file || "").trim();
        downloadCalls.push({ file: remoteUrl, options });
        const localPath = path.join(tempDir, `preloaded-${downloadCalls.length}.mp4`);
        fs.writeFileSync(localPath, "preloaded video");
        return { localPath, remoteUrl, cleanup: null };
      },
    };
  }

  if (request === "./puppeteerFile") {
    return {
      runPuppeteerTask(taskPayload, transport, onFinish) {
        publishPayloads.push(taskPayload);
        setImmediate(() => {
          const queuedReply = queuedPublishReplies.shift();
          if (queuedReply) {
            transport.reply(queuedReply.channel, {
              taskId: taskPayload.taskId,
              ...queuedReply.payload,
            });
          } else {
            transport.reply("puppeteerFile-done", {
              taskId: taskPayload.taskId,
              status: true,
              message: "published",
            });
          }
          if (typeof onFinish === "function") onFinish();
        });
      },
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

function formatLocalDateTime(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function waitFor(predicate, timeoutMs = 6_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("等待定时发布执行超时"));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

async function main() {
  const {
    createScheduledRecord,
    refreshScheduledPublishScheduler,
    schedulePublishRecord,
    stopScheduledPublishScheduler,
  } = require("../src/main/services/scheduledPublish");

  try {
    const localVideoPath = path.join(tempDir, "created-local.mp4");
    fs.writeFileSync(localVideoPath, "created local video");
    const localRecord = createScheduledRecord({
      id: "local-record",
      date: "2026-08-03",
      textType: "local",
      pt: "抖音",
      phone: "13800138000",
      partition: "persist:13800138000抖音",
      filePath: localVideoPath,
      selectedFile: "created-local.mp4",
      bt: "本地预下载执行测试",
    }, formatLocalDateTime(Date.now() + 1_200));

    records.push(cloneRecord(localRecord));
    schedulePublishRecord(localRecord);
    await waitFor(() => records.find((record) => record.id === "local-record")?.publishStatus === "success");

    assert.strictEqual(downloadCalls.length, 0, "本地缓存任务到点不应再次下载视频");
    assert.strictEqual(publishPayloads.length, 1);
    assert.strictEqual(publishPayloads[0].filePath, localVideoPath);

    const remoteUrl = "http://127.0.0.1:3000/api/matrix/publish/download/job-1/0";
    const remoteRecord = createScheduledRecord({
      id: "restart-record",
      date: "2026-08-03",
      textType: "local",
      pt: "抖音",
      phone: "13800138000",
      partition: "persist:13800138000抖音",
      matrixItemId: "restart-item",
      filePath: remoteUrl,
      sourceVideoUrl: remoteUrl,
      selectedFile: "0",
      bt: "重启恢复预下载测试",
    }, formatLocalDateTime(Date.now() + 2_500));

    records.push(cloneRecord(remoteRecord));
    refreshScheduledPublishScheduler();
    await waitFor(() => records.find((record) => record.id === "restart-record")?.publishStatus === "success");

    assert.strictEqual(downloadCalls.length, 1, "重启恢复任务应先下载一次远程视频");
    assert.strictEqual(downloadCalls[0].file, "https://matrix.example.com/api/matrix/publish/download/job-1/0");
    assert.strictEqual(publishPayloads.length, 2);
    assert.notStrictEqual(publishPayloads[1].filePath, remoteUrl);
    assert.ok(fs.existsSync(publishPayloads[1].filePath));
    assert.strictEqual(records.find((record) => record.id === "restart-record")?.filePath, publishPayloads[1].filePath);
    assert.strictEqual(notifications.length, 2);

    const loginFailureVideoPath = path.join(tempDir, "login-failure.mp4");
    fs.writeFileSync(loginFailureVideoPath, "login failure video");
    const loginFailureRecord = createScheduledRecord({
      id: "login-failure-record",
      date: "2026-08-03",
      textType: "local",
      pt: "抖音",
      phone: "13900139000",
      partition: "persist:13900139000抖音",
      filePath: loginFailureVideoPath,
      selectedFile: "login-failure.mp4",
      bt: "登录失效停止重试测试",
    }, formatLocalDateTime(Date.now() + 1_200));
    queuedPublishReplies.push({
      channel: "puppeteer-noLogin",
      payload: {
        status: false,
        message: "抖音登录状态已失效，请重新登录后再试",
        nonRetryable: true,
      },
    });
    const publishCountBeforeLoginFailure = publishPayloads.length;
    records.push(cloneRecord(loginFailureRecord));
    schedulePublishRecord(loginFailureRecord);
    await waitFor(
      () => records.find((record) => record.id === "login-failure-record")?.publishStatus === "failed",
    );

    const failedRecord = records.find((record) => record.id === "login-failure-record");
    assert.strictEqual(
      publishPayloads.length,
      publishCountBeforeLoginFailure + 1,
      "登录失效属于不可重试错误，定时发布只能执行一次",
    );
    assert.strictEqual(failedRecord.publishAttemptCount, 1);
    assert.match(failedRecord.lastPublishMessage, /登录状态已失效/);
    assert.strictEqual(notifications.length, 2);

    const statusUpdates = changeDataCalls
      .filter((call) => call.type === "update")
      .map((call) => call.item?.publishStatus)
      .filter(Boolean);
    assert.ok(statusUpdates.includes("publishing"));
    assert.ok(statusUpdates.includes("success"));

    console.log("test:scheduled-publish-execution 全部通过");
  } finally {
    stopScheduledPublishScheduler();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
