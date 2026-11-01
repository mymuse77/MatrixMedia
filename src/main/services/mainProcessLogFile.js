"use strict";

import fs from "fs";
import path from "path";
import util from "util";

const LOG_FILE_NAME_RE = /^\d{4}-\d{2}-\d{2}\.log$/;

let installed = false;
let logFilePath = "";
const sink = { stream: null };

function isBrokenPipeError(err) {
  return (
    err &&
    (err.code === "EPIPE" || /write EPIPE/.test(String(err.message || err)))
  );
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatLogDate(date = new Date()) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatLogTimestamp(date = new Date()) {
  const yyyy = String(date.getFullYear());
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${ms}`;
}

function getLogFilePath(app) {
  return path.join(getMainProcessLogDir(app), `${formatLogDate()}.log`);
}

function closeLogStream() {
  try {
    if (sink.stream) {
      sink.stream.end();
      sink.stream = null;
    }
  } catch (_) {
    /* ignore */
  }
}

function openLogStream(app) {
  const p = getLogFilePath(app);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (sink.stream && !sink.stream.destroyed && logFilePath === p) return sink.stream;
  closeLogStream();
  logFilePath = p;
  sink.stream = fs.createWriteStream(logFilePath, { flags: "a" });
  sink.stream.on("error", (error) => {
    try { process.stderr.write(`[main-log] 日志写入失败: ${error.message}\n`); } catch (_) { }
  });
  return sink.stream;
}

/**
 * 将主进程 console 输出追加写入应用日志目录下的文件（GUI / CLI 均可用）。
 */
export function installMainProcessLogFile(app) {
  if (installed) return;
  installed = true;
  openLogStream(app).write(
    `[${formatLogTimestamp()}] [LOG] MatrixMedia 主进程日志文件已就绪。\n`
  );
  const writeCritical = (event, details) => {
    try {
      fs.appendFileSync(getLogFilePath(app), `[${formatLogTimestamp()}] [FATAL] ${JSON.stringify({ event, pid: process.pid, ...details })}\n`);
    } catch (error) {
      try { process.stderr.write(`[main-log] 致命异常日志写入失败: ${error.message}\n`); } catch (_) { }
    }
  };
  const sessionDir = path.join(getMainProcessLogDir(app), "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  for (const name of fs.readdirSync(sessionDir)) {
    if (!/^\d+\.json$/.test(name)) continue;
    const previousPid = Number(name.split(".")[0]);
    try { process.kill(previousPid, 0); continue; } catch (error) { if (error.code !== "ESRCH") continue; }
    const previousPath = path.join(sessionDir, name);
    try {
      writeCritical("previous_session_unclean", { previousSession: JSON.parse(fs.readFileSync(previousPath, "utf8")) });
      fs.unlinkSync(previousPath);
    } catch (error) { writeCritical("session_marker_read_failed", { message: error.message }); }
  }
  const sessionPath = path.join(sessionDir, `${process.pid}.json`);
  fs.writeFileSync(sessionPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  let fatal = false;
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    fatal = true;
    writeCritical("uncaught_exception", { origin, error: error.stack || String(error) });
  });
  process.on("unhandledRejection", (reason) => {
    fatal = true;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    writeCritical("unhandled_rejection", { error: error.stack });
    // 留下同步日志后保留致命错误语义，不带着未知状态继续发布。
    process.nextTick(() => { throw error; });
  });
  process.on("exit", (code) => {
    if (code === 0 && !fatal) {
      try { fs.unlinkSync(sessionPath); } catch (_) { }
    } else writeCritical("main_process_exit", { code });
  });
  if (typeof app.on === "function") {
    app.on("render-process-gone", (_event, contents, details) => {
      writeCritical("render_process_gone", { webContentsId: contents?.id, reason: details?.reason, exitCode: details?.exitCode });
    });
    app.on("child-process-gone", (_event, details) => {
      writeCritical("child_process_gone", { type: details?.type, reason: details?.reason, exitCode: details?.exitCode, name: details?.name });
    });
  }

  const stamp = () => formatLogTimestamp();
  const line = (level, args) =>
    `[${stamp()}] [${level}] ${util.format(...args)}\n`;

  const wrap = (level, orig) =>
    function (...args) {
      try {
        openLogStream(app).write(line(level, args));
      } catch (_) {
        /* ignore disk errors so console still works */
      }
      try {
        return orig.apply(console, args);
      } catch (err) {
        if (isBrokenPipeError(err)) return undefined;
        throw err;
      }
    };

  console.log = wrap("LOG", console.log);
  console.info = wrap("INFO", console.info);
  console.warn = wrap("WARN", console.warn);
  console.error = wrap("ERROR", console.error);
  console.debug = wrap("DEBUG", console.debug);
}

export function getMainProcessLogDir(app) {
  return app.getPath("logs");
}

export function getMainProcessLogFilePath(app) {
  return getLogFilePath(app);
}

/**
 * 清空主进程日志目录下所有按天保存的日志，并在已安装时重新打开今日日志。
 */
export function clearMainProcessLogFile(app) {
  const logDir = getMainProcessLogDir(app);
  fs.mkdirSync(logDir, { recursive: true });
  closeLogStream();
  fs.readdirSync(logDir).forEach((name) => {
    if (!LOG_FILE_NAME_RE.test(name)) return;
    fs.rmSync(path.join(logDir, name), { force: true });
  });
  if (!installed) {
    logFilePath = "";
    return;
  }
  openLogStream(app).write(
    `[${formatLogTimestamp()}] [LOG] MatrixMedia 主进程日志已清空。\n`
  );
}
