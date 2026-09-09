"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { build } = require("esbuild");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "test/.cache");
fs.mkdirSync(outDir, { recursive: true });

const bundlePath = path.join(outDir, "puppeteerFile.cjs");

const stubModules = new Map([
  ["electron", "module.exports = { ipcMain: { on() {} }, app: {}, BrowserWindow: function BrowserWindow() {}, dialog: {} };"],
  ["puppeteer-core", "module.exports = {};"],
  ["puppeteer-extra", "module.exports = { addExtra() { return { use() {} }; } };"],
  ["puppeteer-in-electron", "module.exports = {};"],
  ["puppeteer-extra-plugin-stealth", "module.exports = function StealthPlugin() { return {}; };"],
  ["./Type", "module.exports = {};"],
  ["./upLoad/uploadTimeouts.js", "exports.UPLOAD_WINDOW_AUTO_CLOSE_MS = 60000; exports.PUBLISH_TASK_TIMEOUT_MS = 60000; exports.PUBLISH_ATTEMPT_LIMIT = 2; exports.PUBLISH_ATTEMPT_TIMEOUT_MS = 30000; exports.resolvePublishTimeoutMs = (value, fallback) => Number(value) > 0 ? Number(value) : fallback;"],
  ["./upLoad/closeWindow.js", "exports.skipCloseConfirmation = function skipCloseConfirmation() {};"],
]);

async function main() {
  await build({
    entryPoints: [path.join(root, "src/main/services/puppeteerFile.js")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundlePath,
    plugins: [
      {
        name: "puppeteer-cancel-test-stubs",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (!stubModules.has(args.path)) return null;
            return { path: args.path, namespace: "stub" };
          });
          build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
            contents: stubModules.get(args.path),
            loader: "js",
          }));
        },
      },
    ],
  });

  const {
    createPuppeteerTaskRuntime,
    getPublishNavigationFailureMessage,
  } = require(bundlePath);

  assert.strictEqual(
    getPublishNavigationFailureMessage("抖音", {
      code: "ERR_NAME_NOT_RESOLVED",
    }),
    "抖音 发布页域名解析失败，请检查网络或 DNS 设置后重试",
  );
  assert.strictEqual(
    getPublishNavigationFailureMessage("抖音", {
      code: "ERR_CONNECTION_RESET",
    }),
    "抖音 发布页网络连接失败（ERR_CONNECTION_RESET），请检查网络后重试",
  );

  const started = [];
  const queueStatuses = new Map();
  let queuedHeartbeatCount = 0;
  const runtime = createPuppeteerTaskRuntime({
    queueHeartbeatMs: 10,
    runTask(task, done) {
      started.push(task.data.taskId);
      task.setCancelHandler(() => {
        done();
      });
    },
  });

  runtime.enqueueTask({ taskId: "active" }, { reply() {} });
  runtime.enqueueTask({ taskId: "queued-1" }, { reply() {} }, undefined, (status) => {
    queueStatuses.set("queued-1", status);
    queuedHeartbeatCount += 1;
  });
  runtime.enqueueTask({ taskId: "queued-2" }, { reply() {} }, undefined, (status) => {
    queueStatuses.set("queued-2", status);
  });

  assert.deepStrictEqual(started, ["active"]);
  assert.deepStrictEqual(queueStatuses.get("queued-1"), {
    queueState: "queued",
    queuePosition: 2,
    queueAhead: 1,
    queueSize: 3,
  });
  assert.deepStrictEqual(queueStatuses.get("queued-2"), {
    queueState: "queued",
    queuePosition: 3,
    queueAhead: 2,
    queueSize: 3,
  });
  const initialHeartbeatCount = queuedHeartbeatCount;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(queuedHeartbeatCount > initialHeartbeatCount);

  const result = runtime.cancelPuppeteerTasks("获取状态已中断上传");

  assert.deepStrictEqual(result, { active: 1, queued: 2, total: 3 });
  assert.deepStrictEqual(started, ["active"]);
  assert.strictEqual(runtime.getQueueSize(), 0);
  assert.strictEqual(runtime.isBusy(), false);

  runtime.enqueueTask({ taskId: "after-cancel" }, { reply() {} });

  assert.deepStrictEqual(started, ["active", "after-cancel"]);

  const targeted = runtime.enqueueTask({ taskId: "targeted" }, { reply() {} });
  assert.strictEqual(targeted.cancel("单项超时"), true);
  assert.strictEqual(runtime.getQueueSize(), 0);
  assert.deepStrictEqual(started, ["active", "after-cancel"]);

  runtime.dispose();

  console.log("test-puppeteer-cancel passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
