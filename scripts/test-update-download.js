"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { buildSync } = require("esbuild");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "test/.cache");
fs.mkdirSync(outDir, { recursive: true });
const bundlePath = path.join(outDir, "downloadFile.cjs");

buildSync({
  entryPoints: [path.join(root, "src/main/services/downloadFile.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: bundlePath,
});

const downloadFile = require(bundlePath).default;
const targetPath = path.join(os.tmpdir(), `matrixmedia-update-test-${Date.now()}.exe`);

const server = http.createServer((_request, response) => {
  response.writeHead(200, {
    "Content-Length": "15",
    "Content-Type": "application/octet-stream",
  });
  response.end("test-installer\n");
});

server.listen(0, "127.0.0.1", async () => {
  try {
    const port = server.address().port;
    const states = [];
    const started = downloadFile.downloadToPath(
      null,
      `http://127.0.0.1:${port}/MatrixMedia.exe`,
      targetPath,
      {
        onCompleted: async filePath => {
          states.push(`completed:${path.basename(filePath)}`);
        },
        onTerminated: state => states.push(`terminated:${state}`),
      }
    );

    assert.strictEqual(started, true);
    await new Promise(resolve => {
      const timer = setInterval(() => {
        if (states.length === 2) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });

    assert.strictEqual(fs.readFileSync(targetPath, "utf8"), "test-installer\n");
    assert.deepStrictEqual(states, [
      `completed:${path.basename(targetPath)}`,
      "terminated:completed",
    ]);
    console.log("update download tests passed");
  } finally {
    server.close();
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
  }
});
