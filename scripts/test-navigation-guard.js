"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { build } = require("esbuild");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "test/.cache");
const bundlePath = path.join(outDir, "navigationGuard.cjs");

async function loadModule() {
  fs.mkdirSync(outDir, { recursive: true });
  await build({
    entryPoints: [path.join(root, "src/main/services/navigationGuard.js")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: bundlePath,
  });
  return require(bundlePath);
}

async function main() {
  const { guardExternalNavigation, isAllowedNavigationUrl } =
    await loadModule();
  const handlers = new Map();
  let registerCount = 0;
  let permissionHandler = null;
  const protocol = {
    isProtocolRegistered(scheme) {
      return handlers.has(scheme);
    },
    registerStringProtocol(scheme, handler) {
      registerCount += 1;
      handlers.set(scheme, handler);
      return true;
    },
  };
  const webContents = new EventEmitter();
  webContents.session = {
    protocol,
    setPermissionRequestHandler(handler) {
      permissionHandler = handler;
    },
  };
  webContents.isDestroyed = () => false;

  guardExternalNavigation(webContents);
  guardExternalNavigation(webContents);

  assert.strictEqual(registerCount, 1);
  assert.strictEqual(webContents.listenerCount("will-navigate"), 1);
  assert.strictEqual(webContents.listenerCount("will-redirect"), 1);
  assert.strictEqual(typeof permissionHandler, "function");
  assert.strictEqual(isAllowedNavigationUrl("https://creator.douyin.com/"), true);
  assert.strictEqual(isAllowedNavigationUrl("bitbitbrowser://open/test"), false);

  let response = null;
  handlers.get("bitbitbrowser")(
    { url: "bitbitbrowser://open/test" },
    (value) => {
      response = value;
    },
  );
  assert.deepStrictEqual(response, { error: -3 });

  let permissionGranted = null;
  permissionHandler(
    webContents,
    "openExternal",
    (granted) => {
      permissionGranted = granted;
    },
    { externalURL: "bitbitbrowser://open/test" },
  );
  assert.strictEqual(permissionGranted, false);

  permissionHandler(
    webContents,
    "openExternal",
    (granted) => {
      permissionGranted = granted;
    },
    { externalURL: "unknown-app://open/test" },
  );
  assert.strictEqual(permissionGranted, false);

  permissionHandler(
    webContents,
    "media",
    (granted) => {
      permissionGranted = granted;
    },
    {},
  );
  assert.strictEqual(permissionGranted, true);

  let prevented = false;
  webContents.emit(
    "will-navigate",
    { preventDefault: () => (prevented = true) },
    "bitbitbrowser://open/test",
  );
  assert.strictEqual(prevented, true);

  console.log("test-navigation-guard passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
