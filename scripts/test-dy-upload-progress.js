"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { build } = require("esbuild");
const root = path.join(__dirname, "..");
const outDir = path.join(root, "test/.cache");

async function load(name) {
  const outfile = path.join(outDir, `${name}.cjs`);
  await build({ entryPoints: [path.join(root, `src/main/services/upLoad/${name}.js`)],
    bundle: true, platform: "node", format: "cjs", outfile });
  return require(outfile);
}

function checkWatchdog(createPublishWatchdog) {
  const original = { now: Date.now, setTimeout, clearTimeout };
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  Date.now = () => now;
  global.setTimeout = (fn, ms) => { const id = ++nextId; timers.set(id, { fn, at: now + ms }); return id; };
  global.clearTimeout = (id) => timers.delete(id);
  const tick = (ms) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      timers.delete(next[0]);
      now = next[1].at;
      next[1].fn();
    }
    now = end;
  };
  try {
    const expired = [];
    const monitor = createPublishWatchdog({ idleMs: 100, maxMs: 400, onTimeout: (value) => expired.push(value) });
    tick(90);
    monitor.progress();
    tick(90);
    assert.strictEqual(expired.length, 0, "上传持续有进展时不应被原固定期限关闭");
    monitor.setStage("等待预览", { progress: false });
    tick(10);
    assert.strictEqual(expired.length, 1);
    assert.strictEqual(expired[0].kind, "idle");
    assert.strictEqual(expired[0].stage, "等待预览");
    tick(500);
    assert.strictEqual(expired.length, 1, "只能超时一次");

    const hard = [];
    const bounded = createPublishWatchdog({ idleMs: 100, maxMs: 250, onTimeout: (value) => hard.push(value) });
    tick(90); bounded.progress();
    tick(90); bounded.progress();
    tick(70);
    assert.strictEqual(hard[0].kind, "total", "持续进展仍受硬上限约束");

    const submitted = [];
    const submitting = createPublishWatchdog({ idleMs: 100, maxMs: 400, onTimeout: (value) => submitted.push(value) });
    tick(90); submitting.markSubmitted();
    tick(99);
    assert.strictEqual(submitted.length, 0, "发布确认应获得独立等待时间");
    tick(1);
    assert.strictEqual(submitted[0].submitted, true);
    const stopped = createPublishWatchdog({ idleMs: 100, maxMs: 400, onTimeout: () => { throw new Error("已停止任务不得再超时"); } });
    stopped.stop(); tick(500);
    assert.strictEqual(timers.size, 0);
  } finally {
    Date.now = original.now;
    global.setTimeout = original.setTimeout;
    global.clearTimeout = original.clearTimeout;
  }
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const { createPublishWatchdog } = await load("publishWatchdog");
  const { classifyDyUploadSnapshot, inspectDyUploadState, waitForDyUploadProcessing } = await load("dyUploadState");
  checkWatchdog(createPublishWatchdog);
  const preview = { visible: true, hasSource: true, hasSlider: true, readyState: 0, duration: 0 };
  assert.strictEqual(classifyDyUploadSnapshot({ videos: [preview] }), "ready");
  assert.strictEqual(classifyDyUploadSnapshot({ videos: [preview], uploading: true }), "uploading");
  assert.strictEqual(classifyDyUploadSnapshot({ videos: [preview], processing: true }), "processing");
  assert.strictEqual(classifyDyUploadSnapshot({ videos: [{ ...preview, visible: false }] }), "processing");
  assert.strictEqual(classifyDyUploadSnapshot({ videos: [{ ...preview, hasSlider: false }] }), "processing");
  assert.strictEqual(classifyDyUploadSnapshot({ videos: [{ ...preview, hasSlider: false, readyState: 2, duration: 10 }], hasSavePermission: true }), "ready");
  assert.strictEqual(classifyDyUploadSnapshot({ failure: "视频上传失败", videos: [preview] }), "failed");

  // 执行真正的页面采集函数：其他 CDN 和新增包装层不应阻塞识别。
  const saved = { document: global.document, location: global.location, getComputedStyle: global.getComputedStyle };
  try {
    const body = { innerText: "保存权限" };
    const container = { parentElement: body, querySelector: () => ({}) };
    const wrapper = { parentElement: container, querySelector: () => null };
    const video = { currentSrc: "https://video.example.net/preview.mp4?signature=secret", parentElement: wrapper,
      readyState: 2, duration: 10, getBoundingClientRect: () => ({ width: 100, height: 100 }) };
    let progressBar = null;
    global.document = { body, querySelectorAll: (selector) => selector === "video" ? [video]
      : selector.includes('role="progressbar"') && progressBar ? [progressBar] : [] };
    global.location = { href: "https://creator.douyin.com/" };
    global.getComputedStyle = () => ({ display: "block", visibility: "visible" });
    const snapshot = await inspectDyUploadState({ evaluate: async (fn) => fn() });
    assert.strictEqual(snapshot.state, "ready");
    assert.strictEqual(snapshot.videos[0].source, "https://video.example.net/preview.mp4");
    progressBar = { getBoundingClientRect: () => ({ width: 100, height: 10 }),
      getAttribute: (name) => name === "aria-valuenow" ? "0.2" : "1", innerText: "20%" };
    const uploading = await inspectDyUploadState({ evaluate: async (fn) => fn() });
    assert.strictEqual(uploading.progress, 20);
    assert.strictEqual(uploading.state, "uploading", "有未完成上传进度时不能因为预览存在而继续发布");
    progressBar = null;
    body.innerText = "保存权限 视频转码失败怎么办";
    const helpText = await inspectDyUploadState({ evaluate: async (fn) => fn() });
    assert.strictEqual(helpText.state, "ready", "说明文字不能误判为上传错误提示");
  } finally {
    Object.assign(global, saved);
  }

  const snapshots = [
    { progress: 10, uploading: true }, { progress: 10, uploading: true },
    { progress: 20, uploading: true }, { progress: 100, processing: true },
    { progress: 100, videos: [preview] },
  ];
  const progress = [];
  const ready = await waitForDyUploadProcessing({
    evaluate: async () => snapshots.shift(), waitForTimeout: async () => {},
  }, { timeoutMs: 1000, onProgress: (value) => progress.push(value) });
  assert.strictEqual(ready.state, "ready");
  assert.deepStrictEqual(progress, [10, 20, 100], "同一进度反复出现不能延长等待");
  const phaseProgress = [];
  const phaseSnapshots = [{ progress: 90, uploading: true }, { progress: 5, processing: true },
    { progress: 20, processing: true }, { videos: [preview] }];
  await waitForDyUploadProcessing({ evaluate: async () => phaseSnapshots.shift(), waitForTimeout: async () => {} },
    { timeoutMs: 1000, onProgress: (value) => phaseProgress.push(value) });
  assert.deepStrictEqual(phaseProgress, [90, 5, 20], "处理阶段重新计进度，不受上传阶段的百分比影响");
  await assert.rejects(waitForDyUploadProcessing({
    evaluate: async () => ({ failure: "视频上传失败" }), waitForTimeout: async () => {},
  }, { timeoutMs: 1000 }), /视频上传失败/);
  await assert.rejects(waitForDyUploadProcessing({
    evaluate: async () => { throw new Error("Session closed"); },
  }, { timeoutMs: 1000 }), /Session closed/);
  console.log("test-dy-upload-progress passed");
}

main().catch((error) => { console.error(error); process.exit(1); });
