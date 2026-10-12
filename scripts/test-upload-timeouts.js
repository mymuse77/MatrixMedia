"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { build } = require("esbuild");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "test/.cache");
const bundlePath = path.join(outDir, "uploadTimeouts.cjs");

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [path.join(root, "src/main/services/upLoad/uploadTimeouts.js")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundlePath,
  });

  const {
    PUBLISH_ATTEMPT_LIMIT,
    PUBLISH_ATTEMPT_TIMEOUT_MS,
    PUBLISH_DOWNLOAD_TIMEOUT_MS,
    PUBLISH_TASK_TIMEOUT_MS,
    PUBLISH_TASK_TIMEOUT_MAX_MS,
    resolvePublishTimeoutMs,
    pollPageUntil,
    bindPublishPageSignal,
    waitForPublishPoll,
  } = require(bundlePath);

  assert.strictEqual(PUBLISH_TASK_TIMEOUT_MS, 6 * 60 * 1000);
  assert.strictEqual(PUBLISH_ATTEMPT_TIMEOUT_MS, 3 * 60 * 1000);
  assert.strictEqual(PUBLISH_ATTEMPT_LIMIT, 2);
  assert.strictEqual(PUBLISH_DOWNLOAD_TIMEOUT_MS, 2 * 60 * 1000);
  assert.strictEqual(resolvePublishTimeoutMs(undefined), PUBLISH_TASK_TIMEOUT_MS);
  assert.strictEqual(resolvePublishTimeoutMs(25), 25);
  assert.strictEqual(
    resolvePublishTimeoutMs(PUBLISH_TASK_TIMEOUT_MAX_MS * 2),
    PUBLISH_TASK_TIMEOUT_MAX_MS,
  );
  assert.strictEqual(resolvePublishTimeoutMs(0, 1234), 1234);

  let calls = 0;
  const page = {
    evaluate: async () => ++calls >= 2,
    waitForTimeout: async () => {},
  };
  await pollPageUntil(page, () => true, 100);
  assert.strictEqual(calls, 2);
  await assert.rejects(pollPageUntil({
    evaluate: async () => { throw new Error("Session closed. Most likely the page has been closed."); },
  }, () => false, 100), /Session closed/);
  await assert.rejects(pollPageUntil({
    isClosed: () => true,
    evaluate: async () => { throw new Error("不应继续访问已关闭页面"); },
  }, () => false, 100), { name: "AbortError" });

  const controller = new AbortController();
  const cancelPage = { evaluate: async () => false, waitForTimeout: () => new Promise(() => {}) };
  bindPublishPageSignal(cancelPage, controller.signal);
  const polling = pollPageUntil(cancelPage, () => false, 10800000);
  setImmediate(() => controller.abort());
  await assert.rejects(polling, { name: "AbortError" });
  await assert.rejects(waitForPublishPoll(cancelPage, 100), { name: "AbortError" });

  let transientCalls = 0;
  await pollPageUntil({
    evaluate: async () => {
      if (++transientCalls === 1) throw new Error("Execution context was destroyed");
      return true;
    },
    waitForTimeout: async () => {},
  }, () => true, 100);
  assert.strictEqual(transientCalls, 2);
  let mountingCalls = 0;
  await pollPageUntil({
    evaluate: async () => {
      if (++mountingCalls === 1) throw new Error("Cannot read properties of null (reading 'src')");
      return true;
    },
    waitForTimeout: async () => {},
  }, () => true, 100);
  assert.strictEqual(mountingCalls, 2, "控件尚未挂载时应继续等待，不能中断正常页面初始化");

  console.log("test-upload-timeouts passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
