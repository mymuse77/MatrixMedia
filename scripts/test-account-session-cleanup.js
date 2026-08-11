"use strict";

require("@babel/register")({
  extensions: [".js"],
  ignore: [/node_modules/],
  babelrc: false,
  configFile: false,
  presets: [["@babel/preset-env", { modules: "commonjs", targets: { node: "current" } }]],
});

const assert = require("assert");
const { purgeAccountSession } = require("../src/main/services/accountSessionCleanup");

async function main() {
  const calls = [];
  const fakeSession = {
    async closeAllConnections() { calls.push("close-connections"); },
    async clearStorageData() { calls.push("clear-storage"); },
    async clearCache() { calls.push("clear-cache"); },
    async clearAuthCache() { calls.push("clear-auth-cache"); },
  };
  const dependencies = {
    sessionFromPartition(partition) {
      calls.push(`session:${partition}`);
      return fakeSession;
    },
    blockPartition(partition, accountId) { calls.push(`block:${partition}:${accountId}`); },
    unblockPartition(partition, accountId) { calls.push(`unblock:${partition}:${accountId}`); },
    destroyLoginWindow(partition) { calls.push(`destroy-window:${partition}`); },
    async clearProxySession({ partition }) { calls.push(`clear-proxy:${partition}`); },
  };

  const account = {
    id: "account-1",
    phone: "小甜甜在工厂",
    platform: "视频号",
    partition: "persist:小甜甜在工厂视频号",
  };
  const result = await purgeAccountSession(account, dependencies);
  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(calls, [
    "block:persist:小甜甜在工厂视频号:account-1",
    "destroy-window:persist:小甜甜在工厂视频号",
    "session:persist:小甜甜在工厂视频号",
    "close-connections",
    "clear-proxy:persist:小甜甜在工厂视频号",
    "clear-storage",
    "clear-cache",
    "clear-auth-cache",
    "close-connections",
  ]);

  calls.length = 0;
  await assert.rejects(
    () => purgeAccountSession(account, {
      ...dependencies,
      async clearProxySession() {
        calls.push("clear-proxy-failed");
        throw new Error("proxy cleanup failed");
      },
    }),
    /proxy cleanup failed/,
  );
  assert.strictEqual(calls.at(-1), "unblock:persist:小甜甜在工厂视频号:account-1");

  await assert.rejects(() => purgeAccountSession({}, dependencies), /缺少账号会话 partition/);
  console.log("test-account-session-cleanup passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
