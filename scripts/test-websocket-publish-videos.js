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

const root = path.join(__dirname, "..");
const platform = "\u6296\u97f3";
const toutiaoPlatform = "\u5934\u6761";
const xhsPlatform = "\u5c0f\u7ea2\u4e66";
const uploadUrl = "https://creator.douyin.com/creator-micro/content/post/video";
const toutiaoUploadUrl = "https://mp.toutiao.com/profile_v4/xigua/upload-video";
const xhsUploadUrl = "https://creator.xiaohongshu.com/publish/publish?from=menu&target=video";
const capturedPublishPayloads = [];
const progressEvents = [];
const taskResultEvents = [];
const changeDataCalls = [];
const resolvePublishCalls = [];
const scheduledPublishRecords = [];
const preflightCalls = [];
const preflightFailuresByPhone = new Map();
const publishFailuresByPhone = new Map();
const verificationPhones = new Set();
let remoteDownloadIndex = 0;

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: { getPath: () => path.join(os.tmpdir(), "matrixmedia-test-documents") },
      BrowserWindow: { getAllWindows: () => [] },
    };
  }

  if (request === "../server/utils") {
    return {
      changeData: async (payload) => {
        changeDataCalls.push(payload);
        return { success: true };
      },
    };
  }

  if (request === "./puppeteerFile") {
    return {
      runPuppeteerPreflight: async (data) => {
        preflightCalls.push(data);
        const failure = preflightFailuresByPhone.get(data.phone);
        if (failure) {
          const error = new Error(failure.message);
          error.preflightPayload = failure;
          throw error;
        }
        return { success: true };
      },
      runPuppeteerTask(data, transport, onFinish) {
        capturedPublishPayloads.push(data);
        setImmediate(() => {
          if (verificationPhones.has(data.phone)) {
            transport.reply("puppeteerFile-reply", {
              ...data,
              status: "verification_required",
              message: `抖音账号 ${data.phone} 需要接收短信验证码，请在弹出的抖音窗口中完成验证`,
              verificationRequired: true,
            });
          }
          const failure = publishFailuresByPhone.get(data.phone);
          transport.reply("puppeteerFile-done", failure
            ? {
              ...data,
              status: false,
              nonRetryable: true,
              message: failure,
            }
            : {
              ...data,
              status: true,
              message: "published",
            });
          if (typeof onFinish === "function") onFinish();
        });
      },
      createIpcTransport() {
        return { reply() {} };
      },
    };
  }

  if (request === "./resolvePublishFile") {
    return {
      isRemotePublishFile: (file) => /^https?:\/\//i.test(String(file || "").trim()),
      resolvePublishFile: async (file, options = {}) => {
        resolvePublishCalls.push({ file, options });
        const raw = String(file || "").trim();

        if (/^https?:\/\//i.test(raw)) {
          const localPath = path.join(
            os.tmpdir(),
            `matrixmedia-remote-${Date.now()}-${remoteDownloadIndex++}.mp4`,
          );
          fs.writeFileSync(localPath, "downloaded remote video");
          return {
            localPath,
            remoteUrl: raw,
            cleanup: () => {
              if (fs.existsSync(localPath)) {
                fs.unlinkSync(localPath);
              }
            },
          };
        }

        return {
          localPath: path.resolve(raw),
          remoteUrl: null,
          cleanup: null,
        };
      },
    };
  }

  if (request === "../config/ptConfig") {
    return {
      __esModule: true,
      default: {
        [platform]: {
          index: "https://creator.douyin.com/",
          upload: uploadUrl,
          useragent: "MatrixMediaTest/1.0",
        },
        [toutiaoPlatform]: {
          index: "https://mp.toutiao.com/profile_v4/index",
          upload: toutiaoUploadUrl,
          useragent: "MatrixMediaTest/1.0",
        },
        [xhsPlatform]: {
          index: "https://creator.xiaohongshu.com/new/home",
          upload: xhsUploadUrl,
          useragent: "MatrixMediaTest/1.0",
        },
      },
    };
  }

  if (request === "./accountLoginStatus") {
    return {
      getAccountLoginStatus: async () => ({ isLoggedIn: true, loginStatus: "valid" }),
      getAccountPartition: (phone, accountPlatform) => `persist:${phone}${accountPlatform}`,
    };
  }

  if (request === "./scheduledPublish") {
    return {
      cancelScheduledPublishRecords: async () => 0,
      createScheduledRecord: (publishData, scheduledPublishAt) => ({
        ...publishData,
        id: `scheduled-${scheduledPublishRecords.length + 1}`,
        date: "2026-08-02",
        scheduledPublishAt,
        publishStatus: "scheduled",
      }),
      schedulePublishRecord: (record) => {
        scheduledPublishRecords.push(record);
      },
      subscribeScheduledPublishEvents: () => () => {},
    };
  }

  if (request === "./accountLoginWindow") {
    return {
      openAccountLoginWindow: async () => ({ ok: true }),
    };
  }

  if (request === "./appSettings") {
    return {
      getAppSettings: () => ({ webSocketServerUrl: "https://matrix.example.com" }),
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const { handlePublishVideos } = require("../src/main/services/websocketHandlers");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrixmedia-publish-"));
  const firstVideoPath = path.join(tempDir, "video-a.mp4");
  const secondVideoPath = path.join(tempDir, "video-b.mp4");
  const thirdVideoPath = path.join(tempDir, "video-c.mp4");
  fs.writeFileSync(firstVideoPath, "fake video a");
  fs.writeFileSync(secondVideoPath, "fake video b");
  fs.writeFileSync(thirdVideoPath, "fake video c");

  const wsClient = {
    sendProgress(taskId, progress, message) {
      progressEvents.push({ taskId, progress, message });
    },
    sendTaskResult(taskId, status, data) {
      taskResultEvents.push({ taskId, status, data });
    },
  };

  const result = await handlePublishVideos(
    {
      taskId: "matrix-task-test",
      type: "publish_videos",
      data: {
        taskName: "Web publish test",
        tags: ["web-tag", "#shared"],
        captionMode: "batch",
        platforms: [platform, toutiaoPlatform, xhsPlatform],
        accounts: [
          {
            id: "account-1",
            phone: "13800138000",
            platform,
            partition: `persist:13800138000${platform}`,
          },
          {
            id: "account-2",
            phone: "13900139000",
            platform: toutiaoPlatform,
            partition: `persist:13900139000${toutiaoPlatform}`,
          },
          {
            id: "account-3",
            phone: "13700137000",
            platform: xhsPlatform,
            partition: `persist:13700137000${xhsPlatform}`,
          },
        ],
        videos: [
          {
            id: "video-1",
            filePath: firstVideoPath,
            projectName: "Project A",
            versionName: "v1",
          },
          {
            id: "video-2",
            filePath: secondVideoPath,
            projectName: "Project B",
            versionName: "v2",
          },
        ],
        captions: [
          { id: "caption-1", textContent: "Caption one\n#tag1", tags: ["caption-one", "shared"] },
          { id: "caption-2", textContent: "Caption two\n#tag2", tags: ["caption-two"] },
        ],
      },
    },
    wsClient,
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.action, "publish_videos");
  assert.strictEqual(result.status, "completed");
  assert.strictEqual(result.total, 6);
  assert.strictEqual(result.successCount, 6);
  assert.strictEqual(result.failCount, 0);
  assert.strictEqual(capturedPublishPayloads.length, 6);
  assert.strictEqual(changeDataCalls.filter((call) => call.type === "add").length, 6);
  assert.strictEqual(
    changeDataCalls.filter(
      (call) => call.type === "update" && call.item && call.item.publishStatus === "success",
    ).length,
    6,
  );

  assert.strictEqual(capturedPublishPayloads[0].pt, platform);
  assert.ok(capturedPublishPayloads[0].id);
  assert.strictEqual(capturedPublishPayloads[0].phone, "13800138000");
  assert.strictEqual(capturedPublishPayloads[0].bookName, "Web publish test");
  assert.strictEqual(capturedPublishPayloads[0].textOtherName, "Web publish test");
  assert.strictEqual(capturedPublishPayloads[0].filePath, firstVideoPath);
  assert.strictEqual(capturedPublishPayloads[0].url, uploadUrl);
  assert.strictEqual(capturedPublishPayloads[0].mmCliSuppressWindow, true);
  assert.strictEqual(capturedPublishPayloads[0].closeWindowAfterPublish, true);
  assert.strictEqual(capturedPublishPayloads[0].bt, "Caption one");
  assert.strictEqual(capturedPublishPayloads[0].bt2, "#tag1");
  assert.strictEqual(capturedPublishPayloads[0].bq, "#web-tag #shared #caption-one");
  assert.strictEqual(capturedPublishPayloads[0].data.textOtherName, "Web publish test");
  assert.strictEqual(capturedPublishPayloads[0].data.bt1, "Caption one");
  assert.strictEqual(capturedPublishPayloads[0].data.bt2, "#tag1");
  assert.strictEqual(capturedPublishPayloads[0].data.bq, "#web-tag #shared #caption-one");

  assert.strictEqual(capturedPublishPayloads[1].textOtherName, "Web publish test");
  assert.strictEqual(capturedPublishPayloads[1].filePath, secondVideoPath);
  assert.strictEqual(capturedPublishPayloads[1].data.bt1, "Caption two");
  assert.strictEqual(capturedPublishPayloads[1].data.bt2, "#tag2");
  assert.strictEqual(capturedPublishPayloads[1].data.bq, "#web-tag #shared #caption-two");

  assert.strictEqual(capturedPublishPayloads[2].pt, toutiaoPlatform);
  assert.strictEqual(capturedPublishPayloads[2].phone, "13900139000");
  assert.strictEqual(capturedPublishPayloads[2].textOtherName, "Web publish test");
  assert.strictEqual(capturedPublishPayloads[2].filePath, firstVideoPath);
  assert.strictEqual(capturedPublishPayloads[2].url, toutiaoUploadUrl);
  assert.strictEqual(capturedPublishPayloads[2].data.bt1, "Caption one");
  assert.strictEqual(capturedPublishPayloads[2].data.bq, "web-tag shared caption-one");

  assert.strictEqual(capturedPublishPayloads[3].pt, toutiaoPlatform);
  assert.strictEqual(capturedPublishPayloads[3].textOtherName, "Web publish test");
  assert.strictEqual(capturedPublishPayloads[3].filePath, secondVideoPath);
  assert.strictEqual(capturedPublishPayloads[3].data.bt1, "Caption two");
  assert.strictEqual(capturedPublishPayloads[3].data.bq, "web-tag shared caption-two");

  assert.strictEqual(capturedPublishPayloads[4].pt, xhsPlatform);
  assert.strictEqual(capturedPublishPayloads[4].phone, "13700137000");
  assert.strictEqual(capturedPublishPayloads[4].textOtherName, "Web publish test");
  assert.strictEqual(capturedPublishPayloads[4].filePath, firstVideoPath);
  assert.strictEqual(capturedPublishPayloads[4].url, xhsUploadUrl);
  assert.strictEqual(capturedPublishPayloads[4].data.bt1, "Caption one");
  assert.strictEqual(capturedPublishPayloads[4].data.bq, "web-tag shared caption-one");

  assert.strictEqual(capturedPublishPayloads[5].pt, xhsPlatform);
  assert.strictEqual(capturedPublishPayloads[5].textOtherName, "Web publish test");
  assert.strictEqual(capturedPublishPayloads[5].filePath, secondVideoPath);
  assert.strictEqual(capturedPublishPayloads[5].data.bt1, "Caption two");
  assert.strictEqual(capturedPublishPayloads[5].data.bq, "web-tag shared caption-two");

  assert.ok(progressEvents.some((event) => event.progress === 100));
  assert.deepStrictEqual(
    result.results.map((item) => ({ success: item.success, phone: item.phone, platform: item.platform })),
    [
      { success: true, phone: "13800138000", platform },
      { success: true, phone: "13800138000", platform },
      { success: true, phone: "13900139000", platform: toutiaoPlatform },
      { success: true, phone: "13900139000", platform: toutiaoPlatform },
      { success: true, phone: "13700137000", platform: xhsPlatform },
      { success: true, phone: "13700137000", platform: xhsPlatform },
    ],
  );

  const successUpdates = changeDataCalls.filter(
    (call) => call.type === "update" && call.item && call.item.publishStatus === "success",
  );
  assert.strictEqual(successUpdates[0].item.id, capturedPublishPayloads[0].id);
  assert.strictEqual(successUpdates[0].item.date, capturedPublishPayloads[0].date);
  assert.strictEqual(successUpdates[0].item.publishStatus, "success");
  assert.strictEqual(successUpdates[0].item.publishSuccessCount, 1);

  const assignedPublishCountBefore = capturedPublishPayloads.length;
  const assignedTaskEventCountBefore = taskResultEvents.length;
  const assignedResult = await handlePublishVideos(
    {
      taskId: "matrix-task-assignment-test",
      type: "publish_videos",
      data: {
        taskName: "Assigned publish test",
        captionMode: "batch",
        platforms: [platform, toutiaoPlatform, xhsPlatform],
        publishItemIds: ["publish-item-1", "publish-item-2", "publish-item-3"],
        accounts: [
          { id: "account-1", phone: "13800138000", platform },
          { id: "account-2", phone: "13900139000", platform: toutiaoPlatform },
          { id: "account-3", phone: "13700137000", platform: xhsPlatform },
        ],
        videos: [
          { id: "video-1", filePath: firstVideoPath },
          { id: "video-2", filePath: secondVideoPath },
          { id: "video-3", filePath: thirdVideoPath },
        ],
        captions: [{ id: "caption-1", textContent: "Assigned caption" }],
      },
    },
    wsClient,
  );

  assert.strictEqual(assignedResult.total, 3);
  assert.strictEqual(assignedResult.successCount, 3);
  assert.deepStrictEqual(assignedResult.results.map((item) => item.itemId), [
    "publish-item-1",
    "publish-item-2",
    "publish-item-3",
  ]);
  assert.deepStrictEqual(
    capturedPublishPayloads.slice(assignedPublishCountBefore).map((item) => item.filePath),
    [firstVideoPath, secondVideoPath, thirdVideoPath],
  );
  const assignedTaskEvents = taskResultEvents.slice(assignedTaskEventCountBefore);
  assert.strictEqual(
    assignedTaskEvents.length,
    2,
    "最后一项完成后应由 WebSocket 外层统一发送唯一终态",
  );
  assert.deepStrictEqual(
    assignedTaskEvents.map((event) => event.data.results[0].itemId),
    ["publish-item-1", "publish-item-2"],
  );

  const failedResult = await handlePublishVideos(
    {
      taskId: "matrix-task-failure-test",
      type: "publish_videos",
      data: {
        taskName: "Missing file test",
        captionMode: "batch",
        platforms: [platform],
        accounts: [{ id: "account-1", phone: "13800138000", platform }],
        videos: [{ id: "missing-video", filePath: path.join(tempDir, "missing.mp4") }],
        captions: [{ id: "caption-1", textContent: "Caption one" }],
      },
    },
    wsClient,
  );

  assert.strictEqual(failedResult.success, false);
  assert.strictEqual(failedResult.status, "failed");
  assert.strictEqual(failedResult.total, 1);
  assert.strictEqual(failedResult.successCount, 0);
  assert.strictEqual(failedResult.failCount, 1);
  assert.match(failedResult.results[0].error, /视频文件不存在/);

  const isolatedPublishCountBefore = capturedPublishPayloads.length;
  const isolatedTaskEventCountBefore = taskResultEvents.length;
  const isolatedChangeCallCountBefore = changeDataCalls.length;
  preflightFailuresByPhone.set("13900139000", {
    status: false,
    message: "抖音发布页要求重新登录",
    nonRetryable: true,
    diagnostic: { metadataPath: "login-required.json" },
  });
  const isolatedResult = await handlePublishVideos(
    {
      taskId: "matrix-task-isolated-login-failure-test",
      type: "publish_videos",
      data: {
        taskName: "Isolated login failure test",
        captionMode: "batch",
        platforms: [platform],
        accounts: [
          { id: "account-1", phone: "13800138000", platform },
          { id: "account-2", phone: "13900139000", platform },
        ],
        videos: [{ id: "video-1", filePath: firstVideoPath }],
        captions: [{ id: "caption-1", textContent: "Caption one" }],
      },
    },
    wsClient,
  );
  preflightFailuresByPhone.clear();

  assert.strictEqual(isolatedResult.success, false);
  assert.strictEqual(isolatedResult.status, "partial");
  assert.strictEqual(isolatedResult.total, 2);
  assert.strictEqual(isolatedResult.successCount, 1);
  assert.strictEqual(isolatedResult.failCount, 1);
  assert.strictEqual(capturedPublishPayloads.length, isolatedPublishCountBefore + 1);
  assert.deepStrictEqual(
    preflightCalls.slice(-2).map((item) => item.phone),
    ["13800138000", "13900139000"],
  );
  assert.strictEqual(isolatedResult.results[0].phone, "13800138000");
  assert.strictEqual(isolatedResult.results[0].success, true);
  assert.strictEqual(isolatedResult.results[1].phone, "13900139000");
  assert.strictEqual(isolatedResult.results[1].success, false);
  assert.strictEqual(isolatedResult.results[1].attemptCount, 0);
  assert.strictEqual(isolatedResult.results[1].nonRetryable, true);
  assert.match(isolatedResult.results[1].error, /要求重新登录/);
  assert.ok(
    changeDataCalls
      .slice(isolatedChangeCallCountBefore)
      .some((call) =>
        call.type === "update" &&
        call.item?.publishStatus === "failed" &&
        /要求重新登录/.test(call.item?.lastPublishMessage || ""),
      ),
    "登录失效的发布项应写入本地失败记录",
  );
  assert.strictEqual(
    taskResultEvents.slice(isolatedTaskEventCountBefore).length,
    1,
    "批量终态应由 WebSocket 外层在 handler 返回后发送",
  );

  const singleFailurePreflightCountBefore = preflightCalls.length;
  const singleFailurePublishCountBefore = capturedPublishPayloads.length;
  preflightFailuresByPhone.set("13900139000", {
    status: false,
    message: "抖音发布页要求重新登录",
    nonRetryable: true,
  });
  const singleFailureResult = await handlePublishVideos(
    {
      taskId: "matrix-task-single-login-failure-test",
      type: "publish_videos",
      data: {
        taskName: "Single login failure test",
        platforms: [platform],
        accounts: [{ id: "account-2", phone: "13900139000", platform }],
        videos: [{ id: "video-1", filePath: firstVideoPath }],
        captions: [{ id: "caption-1", textContent: "Caption one" }],
      },
    },
    wsClient,
  );
  preflightFailuresByPhone.clear();

  assert.strictEqual(singleFailureResult.status, "failed");
  assert.strictEqual(singleFailureResult.successCount, 0);
  assert.strictEqual(singleFailureResult.failCount, 1);
  assert.strictEqual(singleFailureResult.results[0].attemptCount, 1);
  assert.strictEqual(
    preflightCalls.length,
    singleFailurePreflightCountBefore + 1,
    "单账号登录失效不应触发批量外层重复预检",
  );
  assert.strictEqual(capturedPublishPayloads.length, singleFailurePublishCountBefore);

  const continueAfterFailurePublishCountBefore = capturedPublishPayloads.length;
  publishFailuresByPhone.set("13900139000", "单账号上传超时");
  const continueAfterFailureResult = await handlePublishVideos(
    {
      taskId: "matrix-task-continue-after-failure-test",
      type: "publish_videos",
      data: {
        taskName: "Continue after single account failure test",
        publishTimeoutMs: 1200,
        platforms: [platform],
        accounts: [
          { id: "account-1", phone: "13800138000", platform },
          { id: "account-2", phone: "13900139000", platform },
          { id: "account-3", phone: "13700137000", platform },
        ],
        videos: [{ id: "video-1", filePath: firstVideoPath }],
        captions: [{ id: "caption-1", textContent: "Continue caption" }],
      },
    },
    wsClient,
  );
  publishFailuresByPhone.clear();

  assert.strictEqual(continueAfterFailureResult.success, false);
  assert.strictEqual(continueAfterFailureResult.status, "partial");
  assert.strictEqual(continueAfterFailureResult.total, 3);
  assert.strictEqual(continueAfterFailureResult.successCount, 2);
  assert.strictEqual(continueAfterFailureResult.failCount, 1);
  assert.strictEqual(
    capturedPublishPayloads.length,
    continueAfterFailurePublishCountBefore + 3,
    "单个账号异常后仍应继续调用后续账号",
  );
  assert.strictEqual(capturedPublishPayloads.at(-3).publishTimeoutMs, 1200);
  assert.strictEqual(capturedPublishPayloads.at(-2).phone, "13900139000");
  assert.strictEqual(capturedPublishPayloads.at(-1).phone, "13700137000");
  assert.strictEqual(continueAfterFailureResult.results[1].success, false);
  assert.match(continueAfterFailureResult.results[1].error, /上传超时/);

  const verificationProgressCountBefore = progressEvents.length;
  verificationPhones.add("13800138000");
  const verificationResult = await handlePublishVideos(
    {
      taskId: "matrix-task-verification-test",
      type: "publish_videos",
      data: {
        taskName: "Douyin verification test",
        platforms: [platform],
        accounts: [{ id: "account-1", phone: "13800138000", platform }],
        videos: [{ id: "video-1", filePath: firstVideoPath }],
        captions: [{ id: "caption-1", textContent: "Verification caption" }],
      },
    },
    wsClient,
  );
  verificationPhones.clear();

  assert.strictEqual(verificationResult.success, true);
  assert.strictEqual(verificationResult.status, "completed");
  assert.ok(
    progressEvents
      .slice(verificationProgressCountBefore)
      .some((event) => event.message.includes("需要接收短信验证码")),
  );

  const remoteChangeCallCountBefore = changeDataCalls.length;
  const remotePublishCountBefore = capturedPublishPayloads.length;
  const remoteUrl = "https://matrix.example.com/api/matrix/publish/download/job-1/0";
  const remoteResult = await handlePublishVideos(
    {
      taskId: "matrix-task-remote-test",
      type: "publish_videos",
      data: {
        taskName: "Authorized download test",
        captionMode: "batch",
        platforms: [platform],
        accounts: [{ id: "account-1", phone: "13800138000", platform }],
        videos: [
          {
            id: "remote-video",
            videoUrl: remoteUrl,
            download: {
              url: remoteUrl,
              headers: {
                Authorization: "Bearer secure-token",
                "X-Matrix-Client-Id": "client-1",
                "X-Matrix-Task-Id": "task-1",
              },
              expiresAt: "2026-06-25T10:00:00.000Z",
            },
          },
        ],
        captions: [{ id: "caption-1", textContent: "Remote caption" }],
      },
    },
    wsClient,
  );

  assert.strictEqual(remoteResult.success, true);
  assert.strictEqual(remoteResult.status, "completed");
  assert.strictEqual(capturedPublishPayloads.length, remotePublishCountBefore + 1);
  assert.strictEqual(resolvePublishCalls.at(-1).file, remoteUrl);
  assert.deepStrictEqual(resolvePublishCalls.at(-1).options.headers, {
    Authorization: "Bearer secure-token",
    "X-Matrix-Client-Id": "client-1",
    "X-Matrix-Task-Id": "task-1",
  });
  assert.notStrictEqual(capturedPublishPayloads.at(-1).filePath, remoteUrl);
  assert.strictEqual(capturedPublishPayloads.at(-1).bt2, undefined);
  assert.strictEqual(capturedPublishPayloads.at(-1).data.bt2, undefined);

  const remoteChangeCalls = changeDataCalls.slice(remoteChangeCallCountBefore);
  const remoteRecordUpdate = remoteChangeCalls.find(
    (call) => call.type === "update" && Object.prototype.hasOwnProperty.call(call.item || {}, "matrixSourceVideoUrl"),
  );
  assert(remoteRecordUpdate);
  assert.strictEqual(remoteRecordUpdate.item.matrixSourceVideoUrl, "");

  const scheduledResolveCountBefore = resolvePublishCalls.length;
  const scheduledResult = await handlePublishVideos(
    {
      taskId: "matrix-task-scheduled-preload-test",
      type: "publish_videos",
      data: {
        taskName: "Scheduled preload test",
        scheduleMode: "scheduled",
        platforms: [platform],
        accounts: [{ id: "account-1", phone: "13800138000", platform }],
        videos: [{ id: "scheduled-video", videoPath: "http://127.0.0.1:3000/api/matrix/publish/download/job-1/0" }],
        publishItems: [{
          itemId: "scheduled-item",
          accountId: "account-1",
          phone: "13800138000",
          platform,
          videoId: "scheduled-video",
          videoPath: "http://127.0.0.1:3000/api/matrix/publish/download/job-1/0",
          scheduledPublishAt: Date.now() + 60 * 60 * 1_000,
          captionText: "Scheduled caption",
        }],
        captions: [],
      },
    },
    wsClient,
  );

  assert.strictEqual(scheduledResult.status, "scheduled");
  assert.strictEqual(resolvePublishCalls.length, scheduledResolveCountBefore + 1);
  assert.strictEqual(resolvePublishCalls.at(-1).file, "https://matrix.example.com/api/matrix/publish/download/job-1/0");
  assert.notStrictEqual(scheduledPublishRecords.at(-1).filePath, "http://127.0.0.1:3000/api/matrix/publish/download/job-1/0");
  assert.strictEqual(scheduledPublishRecords.at(-1).matrixItemId, "scheduled-item");

  const mixedPublishCountBefore = capturedPublishPayloads.length;
  const mixedScheduledCountBefore = scheduledPublishRecords.length;
  const mixedResult = await handlePublishVideos(
    {
      taskId: "matrix-task-mixed-immediate-test",
      type: "publish_videos",
      data: {
        taskName: "Mixed immediate test",
        scheduleMode: "immediate",
        scheduleMixDistribution: true,
        platforms: [platform],
        accounts: [{ id: "account-1", phone: "13800138000", platform }],
        videos: [
          { id: "video-1", filePath: firstVideoPath },
          { id: "video-2", filePath: secondVideoPath },
        ],
        publishItems: [
          {
            itemId: "mixed-immediate-item",
            accountId: "account-1",
            phone: "13800138000",
            platform,
            videoId: "video-1",
            videoPath: firstVideoPath,
            scheduledPublishAt: Date.now() - 1_000,
            captionText: "Immediate item",
          },
          {
            itemId: "mixed-scheduled-item",
            accountId: "account-1",
            phone: "13800138000",
            platform,
            videoId: "video-2",
            videoPath: secondVideoPath,
            scheduledPublishAt: Date.now() + 60 * 60 * 1_000,
            captionText: "Scheduled item",
          },
        ],
      },
    },
    wsClient,
  );

  assert.strictEqual(mixedResult.success, true);
  assert.strictEqual(mixedResult.status, "running");
  assert.strictEqual(mixedResult.total, 2);
  assert.strictEqual(mixedResult.successCount, 1);
  assert.strictEqual(mixedResult.failCount, 0);
  assert.strictEqual(capturedPublishPayloads.length, mixedPublishCountBefore + 1);
  assert.strictEqual(scheduledPublishRecords.length, mixedScheduledCountBefore + 1);
  assert.strictEqual(scheduledPublishRecords.at(-1).matrixTaskId, "matrix-task-mixed-immediate-test");
  assert.strictEqual(scheduledPublishRecords.at(-1).matrixItemId, "mixed-scheduled-item");
  assert.deepStrictEqual(
    mixedResult.results.map((item) => ({ itemId: item.itemId, success: item.success, status: item.status })),
    [
      { itemId: "mixed-immediate-item", success: true, status: undefined },
      { itemId: "mixed-scheduled-item", success: undefined, status: "scheduled" },
    ],
  );
  const terminalBatchEvent = taskResultEvents.find(
    (event) => event.taskId === "matrix-task-test" && event.data.status === "completed",
  );
  assert.strictEqual(terminalBatchEvent, undefined);

  console.log("test-websocket-publish-videos passed");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
  });
