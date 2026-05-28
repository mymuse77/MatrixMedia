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
const changeDataCalls = [];

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
      runPuppeteerTask(data, transport, onFinish) {
        capturedPublishPayloads.push(data);
        setImmediate(() => {
          transport.reply("puppeteerFile-done", {
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

  if (request === "./accountLoginWindow") {
    return {
      openAccountLoginWindow: async () => ({ ok: true }),
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const { handlePublishVideos } = require("../src/main/services/websocketHandlers");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrixmedia-publish-"));
  const firstVideoPath = path.join(tempDir, "video-a.mp4");
  const secondVideoPath = path.join(tempDir, "video-b.mp4");
  fs.writeFileSync(firstVideoPath, "fake video a");
  fs.writeFileSync(secondVideoPath, "fake video b");

  const wsClient = {
    sendProgress(taskId, progress, message) {
      progressEvents.push({ taskId, progress, message });
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
  assert.strictEqual(changeDataCalls.filter((call) => call.type === "update").length, 6);

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
  assert.strictEqual(capturedPublishPayloads[0].bt2, "Caption one\n#tag1");
  assert.strictEqual(capturedPublishPayloads[0].bq, "#web-tag #shared #caption-one");
  assert.strictEqual(capturedPublishPayloads[0].data.textOtherName, "Web publish test");
  assert.strictEqual(capturedPublishPayloads[0].data.bt1, "Caption one");
  assert.strictEqual(capturedPublishPayloads[0].data.bt2, "Caption one\n#tag1");
  assert.strictEqual(capturedPublishPayloads[0].data.bq, "#web-tag #shared #caption-one");

  assert.strictEqual(capturedPublishPayloads[1].textOtherName, "Web publish test");
  assert.strictEqual(capturedPublishPayloads[1].filePath, secondVideoPath);
  assert.strictEqual(capturedPublishPayloads[1].data.bt1, "Caption two");
  assert.strictEqual(capturedPublishPayloads[1].data.bt2, "Caption two\n#tag2");
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

  const successUpdates = changeDataCalls.filter((call) => call.type === "update");
  assert.strictEqual(successUpdates[0].item.id, capturedPublishPayloads[0].id);
  assert.strictEqual(successUpdates[0].item.date, capturedPublishPayloads[0].date);
  assert.strictEqual(successUpdates[0].item.publishStatus, "success");
  assert.strictEqual(successUpdates[0].item.publishSuccessCount, 1);

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
