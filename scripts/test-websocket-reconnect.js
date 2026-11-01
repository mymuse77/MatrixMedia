"use strict";

const assert = require("assert");
const Module = require("module");
const fs = require("fs");
const os = require("os");
const path = require("path");
const durableDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-result-durability-"));

const socketHandlers = new Map();
const managerHandlers = new Map();
const emittedEvents = [];
let capturedOptions = null;
let resultAck = true;
let resultOutcome = 'persisted';

const fakeSocket = {
  id: "socket-test",
  connectCount: 0,
  disconnectCount: 0,
  io: {
    on(eventName, handler) {
      managerHandlers.set(eventName, handler);
    },
  },
  on(eventName, handler) {
    socketHandlers.set(eventName, handler);
  },
  emit(eventName, payload, callback) {
    emittedEvents.push({ eventName, payload });
    if (typeof callback === "function") callback(null, eventName === "result" ? (resultAck === null ? undefined : { success: resultAck, outcome: resultAck ? resultOutcome : 'retry' }) : { success: true });
  },
  timeout() {
    return this;
  },
  connect() {
    this.connectCount += 1;
  },
  disconnect() {
    this.disconnectCount += 1;
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { app: { getPath: () => durableDir } };
  if (request === "socket.io-client") {
    return {
      io(_url, options) {
        capturedOptions = options;
        return fakeSocket;
      },
    };
  }
  if (request === "./clientIdentity") {
    return { getClientId: () => "client-test" };
  }
  if (request === "./websocketHandlers") {
    return { sendAccountSnapshot: async () => ({ success: true }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const { WebSocketClient } = require("../src/main/services/websocketClient");
  let storedResults = [];
  const resultStore = { load: () => storedResults, save: (records) => { storedResults = JSON.parse(JSON.stringify(records)); } };
  const client = new WebSocketClient({ resultStore });

  const { createPublishResultStore } = require("../src/main/services/publishResultOutbox");
  const diskStore = createPublishResultStore("https://test.invalid", "durable-client");
  const offline = new WebSocketClient({ resultStore: diskStore });
  await offline.sendTaskResult("retry-request", "success", {
    action: "publish_video", matrixTaskId: "parent-task", executionToken: "current-token",
    itemId: "durable-item", success: true, publishedAt: Date.now(),
  });
  const afterRestart = new WebSocketClient({ resultStore: diskStore });
  assert.strictEqual(afterRestart.resultOutbox.size, 1, "真实文件恢复已确认但未同步的发布结果");
  const [diskKey, diskEntry] = [...afterRestart.resultOutbox.entries()][0];
  assert.strictEqual(diskEntry.result.data.matrixTaskId, "parent-task");
  afterRestart.socket = fakeSocket;
  afterRestart.isConnected = true;
  resultAck = false;
  await afterRestart.deliverTaskResult(diskKey, diskEntry);
  assert.strictEqual(diskStore.load().length, 1, "服务端未保存时不能删除磁盘队列");
  resultAck = true;
  await afterRestart.deliverTaskResult(diskKey, diskEntry);
  assert.strictEqual(diskStore.load().length, 0, "服务端保存确认后才能移除结果");

  client.connect();
  assert.strictEqual(capturedOptions.reconnection, true);
  assert.strictEqual(capturedOptions.reconnectionAttempts, Infinity);
  assert.ok(capturedOptions.reconnectionDelayMax >= 30_000);
  assert.ok(capturedOptions.randomizationFactor > 0);

  socketHandlers.get("connect")();
  assert.strictEqual(client.getConnectionStatus().isConnected, true);
  assert.ok(client.getConnectionStatus().lastConnectedAt > 0);
  assert.ok(emittedEvents.some((event) => event.eventName === "auth"));
  client.executionTokenByTaskId.set("publish-task-1", "execution-token-1");
  client.sendAck("publish-task-1", { queueState: "queued", queueAhead: 1 });
  assert.ok(emittedEvents.some((event) =>
    event.eventName === "ack" &&
    event.payload.taskId === "publish-task-1" &&
    event.payload.executionToken === "execution-token-1"
  ));

  client.taskTypeById.set("terminal-task", "publish_video");
  client.taskDataById.set("terminal-task", {
    taskId: "terminal-task",
    type: "publish_video",
    data: { itemId: "terminal-item" },
  });
  await client.sendTaskResult("terminal-task", "success", {
    status: "completed",
    success: true,
  });
  assert.strictEqual(client.taskDataById.has("terminal-task"), false);

  for (const ack of [false, null, true]) {
    resultAck = ack;
    resultOutcome = ack === true ? undefined : 'persisted';
    assert.strictEqual(await client.sendTaskResult("retry-task", "success", { action: "publish_video", status: "completed", executionToken: "old" }), false);
    assert.strictEqual(storedResults.length, 1);
    const [key, entry] = [...client.resultOutbox.entries()][0];
    client.executionTokenByTaskId.set("retry-task", "new");
    client.taskDataById.set("retry-task", { data: { executionToken: "new" } });
    resultAck = true;
    resultOutcome = 'persisted';
    await client.deliverTaskResult(key, entry);
    assert.strictEqual(storedResults.length, 0);
    assert.strictEqual(client.executionTokenByTaskId.get("retry-task"), "new", "旧 ACK 不清新执行上下文");
  }

  socketHandlers.get("disconnect")("ping timeout");
  const beforeOffline = emittedEvents.length;
  assert.strictEqual(await client.sendTaskResult("offline-result", "success", { action: "publish_videos", status: "running", results: [{ itemId: "offline-item", success: true }] }), false);
  assert.strictEqual(emittedEvents.length, beforeOffline, "断线不依赖 Socket.IO 缓存");
  assert.strictEqual(storedResults.length, 1);
  const restored = new WebSocketClient({ resultStore });
  assert.strictEqual(restored.resultOutbox.size, 1, "重启后恢复未确认结果");
  const disconnectedStatus = client.getConnectionStatus();
  assert.strictEqual(disconnectedStatus.isConnected, false);
  assert.strictEqual(disconnectedStatus.lastDisconnectReason, "ping timeout");
  assert.ok(disconnectedStatus.lastDisconnectedAt > 0);

  socketHandlers.get("disconnect")("io server disconnect");
  assert.strictEqual(fakeSocket.connectCount, 1);

  socketHandlers.get("connect")();
  await Promise.all([...client.pendingTaskResultDeliveries]);
  assert.strictEqual(storedResults.length, 0, "重连后补发并清除已确认结果");
  client.taskTypeById.set("finished-batch", "publish_videos");
  client.taskDataById.set("finished-batch", { data: { executionToken: "batch-token" } });
  client.executionTokenByTaskId.set("finished-batch", "batch-token");
  client.registerPublishTaskItems("finished-batch", [{ itemId: "a" }, { itemId: "b" }]);
  client.updatePublishTaskItem("finished-batch", "b", "scheduled");
  await client.sendTaskResult("finished-batch", "success", { action: "publish_videos", status: "running", executionToken: "batch-token", results: [{ itemId: "a", success: true }] });
  assert.strictEqual(client.taskDataById.has("finished-batch"), true);
  await client.sendTaskResult("finished-batch", "success", { action: "publish_videos", status: "running", executionToken: "batch-token", results: [{ itemId: "b", success: true }] });
  assert.strictEqual(client.taskDataById.has("finished-batch"), false, "最后明细确认后清理整批追踪");
  client.taskTypeById.set("mixed-task", "publish_videos");
  client.taskStatusById.set("mixed-task", "running");
  client.taskDataById.set("mixed-task", {
    taskId: "mixed-task",
    type: "publish_videos",
    data: {
      matrixTaskId: "matrix-task-1",
      scheduleMixDistribution: true,
      executionToken: "execution-token-1",
    },
  });
  client.registerPublishTaskItems("mixed-task", [
    {
      itemId: "published-item",
      executionToken: "execution-token-1",
      phone: "13377889205",
      platform: "抖音",
    },
    {
      itemId: "active-item",
      executionToken: "execution-token-1",
      phone: "18800000000",
      platform: "抖音",
    },
    {
      itemId: "scheduled-item",
      executionToken: "execution-token-1",
      phone: "19900000000",
      platform: "抖音",
    },
  ]);
  client.updatePublishTaskItem("mixed-task", "published-item", "success");
  client.updatePublishTaskItem("mixed-task", "scheduled-item", "scheduled");

  await client.disconnect();
  assert.strictEqual(fakeSocket.disconnectCount, 1);
  const shutdownEvent = emittedEvents.find((event) => event.eventName === "client:shutdown");
  assert.ok(shutdownEvent);
  const shutdownTask = shutdownEvent.payload.tasks.find((task) => task.taskId === "mixed-task");
  assert.ok(shutdownTask);
  assert.strictEqual(shutdownTask.data.clientShutdown, true);
  assert.strictEqual(shutdownTask.data.onlyApplyListedItems, true);
  assert.deepStrictEqual(
    shutdownTask.data.results.map((item) => [item.itemId, item.status, item.success]),
    [
      ["published-item", "success", true],
      ["active-item", "failed", false],
    ],
  );
  console.log("test-websocket-reconnect passed");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
    for (const name of fs.readdirSync(durableDir)) fs.unlinkSync(path.join(durableDir, name));
    fs.rmdirSync(durableDir);
  });
