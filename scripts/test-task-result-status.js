"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { build } = require("esbuild");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "test/.cache");
const bundlePath = path.join(outDir, "taskResultStatus.cjs");

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [
      path.join(root, "src/main/services/taskResultStatus.js"),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundlePath,
  });
  const { resolveTaskTransportStatus } = require(bundlePath);

  assert.strictEqual(
    resolveTaskTransportStatus("publish_video", { success: true }),
    "success",
  );
  assert.strictEqual(
    resolveTaskTransportStatus("publish_videos", {
      success: true,
      status: "completed",
    }),
    "success",
  );
  assert.strictEqual(
    resolveTaskTransportStatus("publish_videos", {
      success: true,
      status: "running",
    }),
    "success",
  );
  assert.strictEqual(
    resolveTaskTransportStatus("publish_videos", {
      success: true,
      status: "partial",
    }),
    "failed",
  );
  assert.strictEqual(
    resolveTaskTransportStatus("publish_videos", {
      success: false,
      status: "failed",
    }),
    "failed",
  );

  console.log("test-task-result-status passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
