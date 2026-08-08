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
    waitForDyPublishConfirmation,
  } = await loadModule();

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
      error.nonRetryable === true,
  );

  console.log("test-dy-publish-confirmation passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
