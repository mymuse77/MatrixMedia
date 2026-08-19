"use strict";

const path = require("path");
const fs = require("fs");
const assert = require("assert");
const { buildSync } = require("esbuild");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "test/.cache");
fs.mkdirSync(outDir, { recursive: true });

const launchInstallerBundle = path.join(outDir, "launchInstaller.cjs");

buildSync({
  entryPoints: [path.join(root, "src/main/services/launchInstaller.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: launchInstallerBundle,
});

const { createLaunchInstallerHandler } = require(launchInstallerBundle);

(async () => {
  let openedPath = "";
  let quitCount = 0;

  const handler = createLaunchInstallerHandler({
    shell: {
      openPath: async installerPath => {
        openedPath = installerPath;
        return "";
      },
    },
    electronApp: {
      quit: () => {
        quitCount += 1;
      },
    },
  });

  const result = await handler(null, "/tmp/matrixmedia.dmg");

  assert.deepStrictEqual(result, { ok: true });
  assert.strictEqual(openedPath, "/tmp/matrixmedia.dmg");
  assert.strictEqual(quitCount, 1);
})();

(async () => {
  let openedPath = "";
  let quitCount = 0;

  const handler = createLaunchInstallerHandler({
    shell: {
      openPath: async installerPath => {
        openedPath = installerPath;
        return "";
      },
    },
    electronApp: {
      quit: () => {
        quitCount += 1;
      },
    },
  });

  const result = await handler(null, "C:\\Temp\\matrixmedia.exe");

  assert.deepStrictEqual(result, { ok: true });
  assert.strictEqual(openedPath, "C:\\Temp\\matrixmedia.exe");
  assert.strictEqual(quitCount, 1);
})();

(async () => {
  const handler = createLaunchInstallerHandler({
    shell: {
      openPath: async () => {
        throw new Error("openPath should not be called for invalid path");
      },
    },
    electronApp: {
      quit: () => {
        throw new Error("quit should not be called for invalid path");
      },
    },
  });

  const result = await handler(null, "");

  assert.deepStrictEqual(result, { ok: false, reason: "invalid-path" });
})();

(async () => {
  let quitCount = 0;
  const handler = createLaunchInstallerHandler({
    shell: { openPath: async () => "" },
    electronApp: { quit() {} },
    hasActiveTasks: () => true,
    quitApp: () => {
      quitCount += 1;
    },
  });

  const result = await handler(null, "C:\\Temp\\matrixmedia.exe");

  assert.deepStrictEqual(result, { ok: false, reason: "active-tasks" });
  assert.strictEqual(quitCount, 0);
})();

(async () => {
  let quitCount = 0;
  const handler = createLaunchInstallerHandler({
    shell: {
      openPath: async () => "Windows 无法打开安装程序",
    },
    electronApp: { quit() {} },
    quitApp: () => {
      quitCount += 1;
    },
  });

  const result = await handler(null, "C:\\Temp\\matrixmedia.exe");

  assert.deepStrictEqual(result, {
    ok: false,
    reason: "launch-failed",
    message: "Windows 无法打开安装程序",
  });
  assert.strictEqual(quitCount, 0);
})();

console.log("launch installer tests passed");
