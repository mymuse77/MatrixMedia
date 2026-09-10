"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { buildSync } = require("esbuild");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "test/.cache");
fs.mkdirSync(outDir, { recursive: true });
const bundlePath = path.join(outDir, "appNotification.cjs");

buildSync({
  entryPoints: [path.join(root, "src/main/services/appNotification.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: bundlePath,
});

const {
  APP_ALREADY_RUNNING_MESSAGE,
  APP_STARTUP_SUCCESS_MESSAGE,
  createAppNotification,
} = require(bundlePath);

const shown = [];
class FakeNotification {
  static isSupported() {
    return true;
  }

  constructor(options) {
    this.options = options;
  }

  show() {
    shown.push(this.options);
  }
}

const notify = createAppNotification({ Notification: FakeNotification });
assert.strictEqual(notify(APP_STARTUP_SUCCESS_MESSAGE), true);
assert.strictEqual(notify(APP_ALREADY_RUNNING_MESSAGE), true);
assert.deepStrictEqual(shown, [
  { title: "视媒助手", body: "程序启动成功", silent: false },
  { title: "视媒助手", body: "程序正在运行中", silent: false },
]);

const unsupported = createAppNotification({
  Notification: { isSupported: () => false },
});
assert.strictEqual(unsupported("不会显示"), false);

const warnings = [];
const failing = createAppNotification({
  Notification: class {
    static isSupported() {
      return true;
    }

    show() {
      throw new Error("show failed");
    }
  },
  logger: { warn: (...args) => warnings.push(args) },
});
assert.strictEqual(failing("启动"), false);
assert.strictEqual(warnings.length, 1);

console.log("test-app-notification passed");
