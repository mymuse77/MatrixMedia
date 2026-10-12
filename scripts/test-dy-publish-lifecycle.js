"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { build } = require("esbuild");
const root = path.join(__dirname, "..");
const outfile = path.join(root, "test/.cache/dyPublishLifecycle.cjs");
const { EventEmitter } = require("events");

async function main() {
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  global.__publishWindows = [];
  global.__publishCaptures = [];
  global.__pollEvaluations = 0;
  const windows = global.__publishWindows;
  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.webContents = { setAudioMuted() {}, setWindowOpenHandler() {}, on() {} };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    async loadURL() {}
    close() { this.destroyed = true; this.emit("closed"); }
  }
  global.__FakePublishWindow = FakeWindow;
  const stubs = new Map([
    ["electron", "exports.ipcMain={on(){}}; exports.app={}; exports.dialog={}; exports.BrowserWindow=global.__FakePublishWindow;"],
    ["puppeteer-core", "module.exports={};"],
    ["puppeteer-extra", "exports.addExtra=()=>({use(){}});"],
    ["puppeteer-extra-plugin-stealth", "module.exports=function(){};"],
    ["puppeteer-in-electron", `module.exports={connect:async()=>({disconnect(){}}), getPage:async(browser,win)=>({
      isClosed:()=>win.isDestroyed(), evaluateOnNewDocument:async()=>{},
      url:()=>"https://creator.douyin.com/creator-micro/content/post/video",
      evaluate:async()=>{global.__pollEvaluations++;return false;},
      waitForTimeout:(ms)=>new Promise(resolve=>setTimeout(resolve,ms))
    })};`],
    ["./proxyConfig.js", "exports.applyAccountProxyForTask=async()=>({applied:false});"],
    ["./chromeConfig.js", "exports.resolveChromePath=()=>null;"],
    ["./upLoad/xhsChrome.js", "module.exports=async()=>{};"],
    ["./navigationGuard.js", "exports.guardExternalNavigation=()=>{};"],
    ["./publishWindowPresentation.js", "exports.hidePublishWindowMenu=()=>{};"],
    ["./upLoad/closeWindow.js", "exports.skipCloseConfirmation=()=>{};"],
    ["./upLoad/publishDiagnostics.js", `exports.capturePublishFailureDiagnostics=async(args)=>{
      global.__publishCaptures.push({closed:args.page.isClosed(),stage:args.stage,snapshot:args.pageSnapshot});
      return {metadataPath:"test-diagnostic.json"};
    };`],
    ["./Type", `import {pollPageUntil} from "./src/main/services/upLoad/uploadTimeouts.js";
      const action=async(page,data,win,event,finish,task)=>{
        if(data.mmPreflightOnly){event.reply("puppeteerFile-done",{...data,status:true,preflight:true});return;}
        if(data.scenario==="stall"||data.scenario==="submitted"){
          task.setSnapshot({progress:35});
          if(data.scenario==="submitted")task.markSubmitted();
          else task.setStage("等待视频上传完成");
          await pollPageUntil(page,()=>false,10800000);
          return;
        }
        await global.__publishAction(page,data,win,event,task);
      };
      export default {"抖音":action,"头条":action};`],
  ]);
  await build({ entryPoints: [path.join(root, "src/main/services/puppeteerFile.js")],
    bundle: true, platform: "node", format: "cjs", outfile,
    plugins: [{ name: "publish-lifecycle-stubs", setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path: name }) => stubs.has(name) ? { path: name, namespace: "stub" } : null);
      builder.onLoad({ filter: /.*/, namespace: "stub" }, ({ path: name }) => ({ contents: stubs.get(name), loader: "js", resolveDir: root }));
    } }],
  });

  const nativeTimeout = global.setTimeout;
  const sleep = (ms) => new Promise((resolve) => nativeTimeout(resolve, ms));
  // 缩短生产计时，执行真实队列、看门狗、取消和回执代码。
  global.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, Math.max(1, Math.round(ms / 1000)), ...args);
  try {
    const { runPuppeteerTask, runPuppeteerPreflight, hasActivePublishTasks } = require(outfile);
    global.__publishAction = async (page, data, win, event, task) => {
      if (data.scenario === "progress") {
        task.setStage("等待视频上传完成");
        for (const value of [10, 30, 60]) { await sleep(60); task.uploadProgress(value); }
      }
      event.reply("puppeteerFile-done", { ...data, status: true });
      win.close();
    };
    const start = (scenario, pt = "抖音") => {
      const replies = [];
      let control;
      const result = new Promise((resolve) => {
        control = runPuppeteerTask({ scenario, taskId: scenario, pt, phone: scenario,
          partition: `persist:${scenario}`, publishTimeoutMs: 100000,
          url: "https://creator.douyin.com/creator-micro/content/post/video" }, {
          reply(channel, payload) { if (channel === "puppeteerFile-done") { replies.push(payload); resolve(payload); } },
        });
      });
      return { result, replies, control };
    };
    const progressing = start("progress");
    assert.strictEqual((await progressing.result).status, true);
    assert.strictEqual(progressing.replies.length, 1);
    const stalled = start("stall");
    const next = start("normal");
    assert.strictEqual((await stalled.result).timeout, true);
    assert.strictEqual((await next.result).status, true, "超时后必须继续下一个账号");
    const evaluations = global.__pollEvaluations;
    await sleep(10);
    assert.strictEqual(global.__pollEvaluations, evaluations, "超时后旧轮询不得继续访问页面");
    assert.strictEqual(stalled.replies.length, 1);
    assert.strictEqual(global.__publishCaptures[0].closed, false, "诊断必须在关窗前采集");
    assert.strictEqual(global.__publishCaptures[0].snapshot.progress, 35);

    const submitted = start("submitted");
    const unknown = await submitted.result;
    assert.strictEqual(unknown.nonRetryable, true);
    assert.strictEqual(unknown.confirmationUnknown, true);
    assert.match(unknown.message, /勿重复发布/);
    assert.strictEqual(submitted.replies.length, 1);

    const canceled = start("stall");
    await sleep(20);
    canceled.control.cancel("用户取消发布");
    assert.strictEqual((await canceled.result).interrupted, true);
    const afterCancel = start("normal");
    assert.strictEqual((await afterCancel.result).status, true);
    assert.strictEqual((await start("normal", "头条").result).status, true);
    await runPuppeteerPreflight({ pt: "抖音", partition: "persist:preflight", publishTimeoutMs: 100000,
      url: "https://creator.douyin.com/creator-micro/content/post/video" });
    await sleep(10);
    assert.ok(windows.every((win) => win.isDestroyed()));
    assert.strictEqual(hasActivePublishTasks(), false);
    console.log("test-dy-publish-lifecycle passed");
  } finally {
    global.setTimeout = nativeTimeout;
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
