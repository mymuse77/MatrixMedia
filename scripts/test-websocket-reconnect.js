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
  emit(eventName, payload) {
    emittedEvents.push({ eventName, payload });
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

  socketHandlers.get("disconnect")("ping timeout");
  const disconnectedStatus = client.getConnectionStatus();
  assert.strictEqual(disconnectedStatus.isConnected, false);
  assert.strictEqual(disconnectedStatus.lastDisconnectReason, "ping timeout");
  assert.ok(disconnectedStatus.lastDisconnectedAt > 0);

  socketHandlers.get("disconnect")("io server disconnect");
  assert.strictEqual(fakeSocket.connectCount, 1);

  client.disconnect();
  assert.strictEqual(fakeSocket.disconnectCount, 1);
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
