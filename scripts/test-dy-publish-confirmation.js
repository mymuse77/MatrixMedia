"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { build } = require("esbuild");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "test/.cache");
const bundlePath = path.join(outDir, "dyPublishConfirmation.cjs");

async function loadModule() {
  fs.mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [
      path.join(
        root,
        "src/main/services/upLoad/dyPublishConfirmation.js",
      ),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundlePath,
  });
  return require(bundlePath);
}

async function main() {
  const {
    classifyDyPublishConfirmationSnapshot,
    resolveDyPublishConfirmationTimeoutMs,
    waitForDyPublishConfirmation,
  } = await loadModule();

  assert.strictEqual(
    resolveDyPublishConfirmationTimeoutMs({ publishTimeoutMs: 180000 }),
    150000,
  );
  assert.strictEqual(
    resolveDyPublishConfirmationTimeoutMs({ publishTimeoutMs: 360000 }),
    180000,
  );
  assert.ok(
    resolveDyPublishConfirmationTimeoutMs({ publishTimeoutMs: 1200 }) <= 1200,
  );

  assert.strictEqual(
    classifyDyPublishConfirmationSnapshot({
      url: "https://creator.douyin.com/creator-micro/content/manage",
      messages: [],
    }),
    "pending",
  );
  assert.strictEqual(
    classifyDyPublishConfirmationSnapshot({
      messages: ["作品发布成功"],
    }),
    "confirmed",
  );
  assert.strictEqual(
    classifyDyPublishConfirmationSnapshot(
      { messages: ["草稿保存成功"] },
      { isDraftMode: true },
    ),
    "confirmed",
  );
  assert.strictEqual(
    classifyDyPublishConfirmationSnapshot({
      messages: ["系统繁忙，请稍后重试"],
    }),
    "failed",
  );
  assert.strictEqual(
    classifyDyPublishConfirmationSnapshot({
      messages: ["作品发布成功", "发布失败，请稍后重试"],
    }),
    "failed",
  );
  assert.strictEqual(
    classifyDyPublishConfirmationSnapshot({ messages: [] }),
    "pending",
  );
  assert.strictEqual(
    classifyDyPublishConfirmationSnapshot({
      url: "https://creator.douyin.com/creator-micro/content/manage?enter_from=publish",
      messages: [],
      bodyText: "作品发布成功",
    }),
    "confirmed",
  );
  assert.strictEqual(
    classifyDyPublishConfirmationSnapshot({
      url: "https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page",
      messages: [],
      bodyText: "点击发布后，如作品还在上传中，请勿关闭页面，等待上传发布完成。检测中3%",
    }),
    "pending",
  );
  assert.strictEqual(
    classifyDyPublishConfirmationSnapshot({
      url: "https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page",
      messages: ["上传成功"],
      bodyText: "点击发布后，如作品还在上传中，请勿关闭页面，等待上传发布完成。",
    }),
    "pending",
  );
  assert.strictEqual(
    classifyDyPublishConfirmationSnapshot({
      url: "https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page",
      messages: [],
      bodyText: "作品发布成功",
    }),
    "pending",
  );
  assert.strictEqual(
    classifyDyPublishConfirmationSnapshot({
      messages: [],
      bodyText: "发布页面提示：请稍后重试或查看帮助",
    }),
    "pending",
  );
  assert.strictEqual(
    classifyDyPublishConfirmationSnapshot({
      messages: [],
      bodyText: "正在发布 接收短信验证码 为确保是本人操作抖音账号，请输入当前手机号137******75收到的短信验证码",
    }),
    "verification_required",
  );

  const confirmed = await waitForDyPublishConfirmation(
    {
      evaluate: async () => ({
        url: "https://creator.douyin.com/creator-micro/content/manage",
        title: "内容管理",
        messages: ["作品发布成功"],
      }),
      waitForTimeout: async () => {},
    },
    { timeoutMs: 100 },
  );
  assert.strictEqual(confirmed.state, "confirmed");

  let pendingChecks = 0;
  const delayedConfirmed = await waitForDyPublishConfirmation(
    {
      evaluate: async () => {
        pendingChecks += 1;
        return pendingChecks < 2
          ? {
              url: "https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page",
              messages: ["上传成功"],
              bodyText: "等待上传发布完成",
            }
          : {
              url: "https://creator.douyin.com/creator-micro/content/manage?enter_from=publish",
              messages: ["发布成功"],
            };
      },
      waitForTimeout: async () => {},
    },
    { timeoutMs: 100 },
  );
  assert.strictEqual(delayedConfirmed.state, "confirmed");
  assert.ok(pendingChecks >= 2);

  await assert.rejects(
    waitForDyPublishConfirmation(
      {
        evaluate: async () => ({
          url: "https://creator.douyin.com/creator-micro/content/post/video",
          title: "发布视频",
          messages: ["发布失败，请稍后重试"],
        }),
        waitForTimeout: async () => {},
      },
      { timeoutMs: 100 },
    ),
    (error) =>
      error.name === "DyPublishConfirmationError" &&
      error.code === "publish_rejected",
  );

  await assert.rejects(
    waitForDyPublishConfirmation(
      {
        evaluate: async () => ({
          url: "https://creator.douyin.com/creator-micro/content/post/video",
          title: "发布视频",
          messages: [],
        }),
        waitForTimeout: async () => {},
      },
      { timeoutMs: 5, intervalMs: 1 },
    ),
    (error) =>
      error.code === "publish_confirmation_timeout" &&
      error.nonRetryable === true &&
      error.confirmationUnknown === true,
  );

  await assert.rejects(
    waitForDyPublishConfirmation(
      {
        evaluate: async () => ({
          messages: ["正在发布"],
          bodyText: "接收短信验证码 获取验证码",
        }),
        waitForTimeout: async () => {},
      },
      { timeoutMs: 5, intervalMs: 1 },
    ),
    (error) =>
      error.code === "publish_verification_timeout" &&
      error.verificationRequired === true &&
      error.confirmationUnknown === false &&
      error.nonRetryable === true,
  );

  console.log("test-dy-publish-confirmation passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
