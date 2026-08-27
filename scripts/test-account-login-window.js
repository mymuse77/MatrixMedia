"use strict";

require("@babel/register")({
  extensions: [".js"],
  ignore: [/node_modules/],
  babelrc: false,
  configFile: false,
  presets: [["@babel/preset-env", { modules: "commonjs", targets: { node: "current" } }]],
});

const assert = require("assert");
const Module = require("module");

const windows = [];
const loadErrors = [];

class FakeBrowserWindow {
  static getAllWindows() {
    return windows.filter((win) => !win.destroyed);
  }

  constructor(options) {
    this.options = options;
    this.destroyed = false;
    this.minimized = false;
    this.loadURLCallCount = 0;
    this.currentUrl = "";
    this.handlers = new Map();
    this.webContents = {
      setUserAgent: (value) => {
        this.useragent = value;
      },
      setWindowOpenHandler: (handler) => {
        this.windowOpenHandler = handler;
      },
      getURL: () => this.currentUrl,
    };
    windows.push(this);
  }

  async loadURL(url) {
    this.loadURLCallCount += 1;
    this.url = url;
    if (loadErrors.length > 0) {
      const error = loadErrors.shift();
      if (error.navigationUrl) this.currentUrl = error.navigationUrl;
      throw error;
    }
    this.currentUrl = url;
  }

  on(eventName, handler) {
    this.handlers.set(eventName, handler);
  }

  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.handlers.get("closed")?.();
  }

  isDestroyed() {
    return this.destroyed;
  }

  isMinimized() {
    return this.minimized;
  }

  restore() {
    this.minimized = false;
  }

  focus() {
    this.focused = true;
  }
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return { BrowserWindow: FakeBrowserWindow };
  }
  if (request === "./navigationGuard") {
    return { guardExternalNavigation() {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const {
    blockAccountLoginPartition,
    openAccountLoginWindow,
  } = require("../src/main/services/accountLoginWindow");

  blockAccountLoginPartition("persist:deleting抖音", "deleted-account");
  const blocked = await openAccountLoginWindow({
    accountId: "deleted-account",
    partition: "persist:deleting抖音",
    url: "https://creator.douyin.com/creator-micro/home",
  });
  assert.deepStrictEqual(blocked, { ok: false, message: "账号登录数据正在清理，请稍后重试" });

  const recreated = await openAccountLoginWindow({
    accountId: "recreated-account",
    partition: "persist:deleting抖音",
    url: "https://creator.douyin.com/creator-micro/home",
  });
  assert.deepStrictEqual(recreated, { ok: true });

  loadErrors.push(new Error("ERR_FAILED (-2) loading login page"));
  const recovered = await openAccountLoginWindow({
    partition: "persist:recovered抖音",
    url: "https://creator.douyin.com/creator-micro/home",
    useragent: "MatrixMediaTest/1.0",
    title: "重试账号 抖音",
  });
  assert.deepStrictEqual(recovered, { ok: true });
  assert.strictEqual(windows[1].destroyed, false);

  const navigationAborted = new Error(
    "ERR_ABORTED (-3) loading https://channels.weixin.qq.com/login.html",
  );
  navigationAborted.code = -3;
  navigationAborted.navigationUrl =
    "https://channels.weixin.qq.com/platform/login-for-iframe";
  loadErrors.push(navigationAborted);
  const redirected = await openAccountLoginWindow({
    partition: "persist:redirected视频号",
    url: "https://channels.weixin.qq.com/login.html",
    useragent: "MatrixMediaTest/1.0",
    title: "重定向账号 视频号",
  });
  assert.deepStrictEqual(redirected, { ok: true });
  assert.strictEqual(windows[2].destroyed, false);
  assert.strictEqual(windows[2].loadURLCallCount, 1);

  loadErrors.push(
    new Error("ERR_FAILED (-2) loading login page"),
    new Error("ERR_FAILED (-2) loading login page"),
  );
  const failed = await openAccountLoginWindow({
    partition: "persist:failed抖音",
    url: "https://creator.douyin.com/creator-micro/home",
    useragent: "MatrixMediaTest/1.0",
    title: "失败账号 抖音",
  });
  assert.strictEqual(failed.ok, false);
  assert.match(failed.message, /ERR_FAILED/);
  assert.strictEqual(windows[3].destroyed, true);

  const opened = await openAccountLoginWindow({
    partition: "persist:ready抖音",
    url: "https://creator.douyin.com/creator-micro/home",
    useragent: "MatrixMediaTest/1.0",
    title: "正常账号 抖音",
  });
  assert.deepStrictEqual(opened, { ok: true });
  assert.strictEqual(windows[4].destroyed, false);
  assert.strictEqual(windows[4].useragent, "MatrixMediaTest/1.0");

  const reused = await openAccountLoginWindow({
    partition: "persist:ready抖音",
    url: "https://creator.douyin.com/creator-micro/home",
  });
  assert.deepStrictEqual(reused, { ok: true, reused: true });
  assert.strictEqual(windows.length, 5);
  assert.strictEqual(windows[4].focused, true);

  console.log("test-account-login-window passed");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
  });
