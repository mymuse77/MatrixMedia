"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

function createPublishRecord(overrides = {}) {
  return {
    id: overrides.id,
    date: "2026-08-26",
    taskId: "matrix-task-repeated-video",
    textOtherName: "重复视频定时发布",
    textType: "local",
    pt: "抖音",
    phone: "厂区人事乐迪",
    partition: "persist:厂区人事乐迪抖音",
    selectedFile: overrides.selectedFile,
    matrixItemId: overrides.matrixItemId,
    idempotencyKey: overrides.idempotencyKey,
    publishStatus: "publishing",
  };
}

async function main() {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "matrixmedia-push-data-identity-"),
  );
  const originalLoad = Module._load;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          getPath(name) {
            if (name === "documents") return tempRoot;
            if (name === "userData") return path.join(tempRoot, "user-data");
            throw new Error(`未支持的 Electron 路径: ${name}`);
          },
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { changeData } = require("../src/main/server/utils");
    const records = [
      createPublishRecord({
        id: "local-1",
        selectedFile: "A17.mp4",
        matrixItemId: "item-1",
        idempotencyKey: "key-1",
      }),
      createPublishRecord({
        id: "local-2",
        selectedFile: "A13.mp4",
        matrixItemId: "item-2",
        idempotencyKey: "key-2",
      }),
      createPublishRecord({
        id: "local-3",
        selectedFile: "A17.mp4",
        matrixItemId: "item-3",
        idempotencyKey: "key-3",
      }),
      createPublishRecord({
        id: "local-4",
        selectedFile: "A13.mp4",
        matrixItemId: "item-4",
        idempotencyKey: "key-4",
      }),
    ];

    for (const record of records) {
      const result = changeData({
        type: "add",
        fileName: "pushData",
        item: record,
      });
      assert.strictEqual(result.success, true);
    }

    const queryResult = changeData({
      type: "get",
      fileName: "pushData",
      item: { page: 1, pageSize: 100 },
    });
    const savedRecords = Object.values(queryResult.data).flat();
    assert.strictEqual(savedRecords.length, 4);
    assert.deepStrictEqual(
      savedRecords.map((record) => record.matrixItemId).sort(),
      ["item-1", "item-2", "item-3", "item-4"],
    );

    changeData({
      type: "add",
      fileName: "pushData",
      item: { ...records[0], id: "replayed-local-1" },
    });
    const replayQueryResult = changeData({
      type: "get",
      fileName: "pushData",
      item: { page: 1, pageSize: 100 },
    });
    const recordsAfterReplay = Object.values(replayQueryResult.data).flat();
    assert.strictEqual(recordsAfterReplay.length, 4);
    assert.strictEqual(
      recordsAfterReplay.find((record) => record.matrixItemId === "item-1")
        .publishAttemptCount,
      2,
    );

    console.log("test-push-data-identity passed");
  } finally {
    Module._load = originalLoad;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
