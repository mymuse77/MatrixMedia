"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { build } = require("esbuild");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "test/.cache");
const bundlePath = path.join(outDir, "dyPageState.cjs");

async function loadModule() {
  fs.mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [
      path.join(root, "src/main/services/upLoad/dyPageState.js"),
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
    DY_UPLOAD_INPUT_LOCATORS,
    classifyDyPageSnapshot,
    findDyUploadInput,
    waitForDyUploadPageReady,
  } = await loadModule();

  assert.deepStrictEqual(
    DY_UPLOAD_INPUT_LOCATORS.map(({ id, selector }) => ({ id, selector })),
    [
      {
        id: "upload-btn-name",
        selector: 'input[name="upload-btn"]',
      },
    ],
  );

  assert.strictEqual(classifyDyPageSnapshot({ ready: true }), "ready");
  assert.strictEqual(
    classifyDyPageSnapshot({
      url: "https://creator.douyin.com/login",
      bodyText: "",
    }),
    "login_required",
  );
  assert.strictEqual(
    classifyDyPageSnapshot({
      url: "https://creator.douyin.com/creator-micro/content/post/video",
      bodyText: "请完成安全验证后继续",
    }),
    "verification_required",
  );
  assert.strictEqual(
    classifyDyPageSnapshot({
      bodyText: "",
      detectedTextSignals: ["访问过于频繁"],
    }),
    "verification_required",
  );
  assert.strictEqual(
    classifyDyPageSnapshot({
      url: "https://creator.douyin.com/creator-micro/content/post/video",
      bodyText: "页面加载失败，请刷新重试",
    }),
    "page_error",
  );
  assert.strictEqual(classifyDyPageSnapshot({}), "loading");

  const disabledHandle = {
    evaluate: async () => true,
  };
  const firstUsableHandle = {
    evaluate: async () => false,
  };
  const lastUsableHandle = {
    evaluate: async () => false,
  };
  const located = await findDyUploadInput({
    $$: async (selector) => {
      assert.strictEqual(selector, 'input[name="upload-btn"]');
      return [disabledHandle, firstUsableHandle, lastUsableHandle];
    },
  });
  assert.strictEqual(located.handle, lastUsableHandle);
  assert.strictEqual(located.locator.id, "upload-btn-name");

  const readySnapshot = {
    url: "https://creator.douyin.com/creator-micro/content/post/video",
    title: "发布视频",
    ready: true,
    matchedLocatorId: "upload-btn-name",
    bodyText: "",
    fileInputs: [],
  };
  const readyResult = await waitForDyUploadPageReady(
    {
      evaluate: async () => readySnapshot,
      waitForTimeout: async () => {},
    },
    { timeoutMs: 100 },
  );
  assert.strictEqual(readyResult.state, "ready");

  await assert.rejects(
    waitForDyUploadPageReady(
      {
        evaluate: async () => ({
          url: "https://creator.douyin.com/creator-micro/content/post/video",
          title: "安全验证",
          ready: false,
          matchedLocatorId: "",
          bodyText: "请完成安全验证后继续",
          fileInputs: [],
        }),
        waitForTimeout: async () => {},
      },
      { timeoutMs: 100, intervalMs: 1 },
    ),
    (error) =>
      error.name === "DyPublishPageError" &&
      error.code === "verification_required",
  );

  console.log("test-dy-page-state passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
