"use strict";

const assert = require("assert");
const Module = require("module");

const socketHandlers = new Map();
const managerHandlers = new Map();
const emittedEvents = [];
let capturedOptions = null;

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
    if (typeof callback === "function") callback(null, { success: true });
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
  const client = new WebSocketClient();

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

  socketHandlers.get("disconnect")("ping timeout");
  const disconnectedStatus = client.getConnectionStatus();
  assert.strictEqual(disconnectedStatus.isConnected, false);
  assert.strictEqual(disconnectedStatus.lastDisconnectReason, "ping timeout");
  assert.ok(disconnectedStatus.lastDisconnectedAt > 0);

  socketHandlers.get("disconnect")("io server disconnect");
  assert.strictEqual(fakeSocket.connectCount, 1);

  socketHandlers.get("connect")();
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

  await client.disconnect();
  assert.strictEqual(fakeSocket.disconnectCount, 1);
  assert.ok(emittedEvents.some((event) =>
    event.eventName === "client:shutdown" &&
    event.payload.tasks.some((task) => task.taskId === "mixed-task")
  ));
  console.log("test-websocket-reconnect passed");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
  });
