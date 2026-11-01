"use strict";

const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildSync } = require("esbuild");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "test/.cache");
fs.mkdirSync(outDir, { recursive: true });

const logFileBundle = path.join(outDir, "mainProcessLogFile.cjs");

buildSync({
  entryPoints: [path.join(root, "src/main/services/mainProcessLogFile.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: logFileBundle,
});

const {
  clearMainProcessLogFile,
  getMainProcessLogDir,
  getMainProcessLogFilePath,
} = require(logFileBundle);

function todayLogName() {
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}.log`;
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrixmedia-log-test-"));
const app = {
  getPath(name) {
    assert.strictEqual(name, "logs");
    return tempDir;
  },
};

try {
  assert.strictEqual(getMainProcessLogDir(app), tempDir);
  assert.strictEqual(
    getMainProcessLogFilePath(app),
    path.join(tempDir, todayLogName())
  );

  fs.writeFileSync(path.join(tempDir, "2026-05-15.log"), "old");
  fs.writeFileSync(path.join(tempDir, todayLogName()), "today");
  fs.writeFileSync(path.join(tempDir, "keep.txt"), "keep");

  clearMainProcessLogFile(app);

  assert.strictEqual(
    fs.existsSync(path.join(tempDir, "2026-05-15.log")),
    false
  );
  assert.strictEqual(fs.existsSync(path.join(tempDir, todayLogName())), false);
  assert.strictEqual(
    fs.readFileSync(path.join(tempDir, "keep.txt"), "utf8"),
    "keep"
  );

  const epipeTempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "matrixmedia-epipe-test-")
  );
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
const { installMainProcessLogFile } = require(${JSON.stringify(logFileBundle)});
const app = { getPath(name) { if (name !== "logs") throw new Error(name); return ${JSON.stringify(
        epipeTempDir
      )}; } };
const err = new Error("write EPIPE");
err.code = "EPIPE";
console.log = function () { throw err; };
installMainProcessLogFile(app);
console.log("closed stdout pipe");
`,
    ],
    { encoding: "utf8" }
  );
  fs.rmSync(epipeTempDir, { recursive: true, force: true });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);

  const faultDir = path.join(tempDir, "faults");
  const appSetup = `const {EventEmitter}=require('events'); const app=new EventEmitter();
    app.getPath=()=>${JSON.stringify(faultDir)};
    require(${JSON.stringify(logFileBundle)}).installMainProcessLogFile(app);`;
  const crashed = spawnSync(process.execPath, ["-e", `${appSetup}
    app.emit('render-process-gone', {}, {id:42}, {reason:'crashed',exitCode:7});
    Promise.reject(new Error('publish-test-unhandled'));`], { encoding: "utf8" });
  assert.notStrictEqual(crashed.status, 0, "不能吞掉未处理的致命异常");
  const faultLog = path.join(faultDir, todayLogName());
  const faultText = fs.readFileSync(faultLog, "utf8");
  assert.ok(faultText.includes('render_process_gone'));
  assert.ok(faultText.includes('unhandled_rejection'));
  assert.ok(faultText.includes('publish-test-unhandled'));
  assert.strictEqual(fs.readdirSync(path.join(faultDir, "sessions")).length, 1, "异常退出保留标记");
  const restarted = spawnSync(process.execPath, ["-e", appSetup], { encoding: "utf8" });
  assert.strictEqual(restarted.status, 0, restarted.stderr);
  assert.ok(fs.readFileSync(faultLog, "utf8").includes('previous_session_unclean'));
  assert.strictEqual(fs.readdirSync(path.join(faultDir, "sessions")).length, 0, "正常退出移除标记");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("test:main-process-log-file 全部通过");
