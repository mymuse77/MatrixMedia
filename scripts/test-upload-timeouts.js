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

  console.log("test-upload-timeouts passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
