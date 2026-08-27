import {
  ipcMain,
  dialog,
  BrowserWindow,
  screen,
  app as electronApp,
  shell,
} from "electron";
import Server from "../server/index";

import { winURL } from "../config/StaticPath";
import downloadFile from "./downloadFile";
import { hasActivePublishTasks, registerPuppeteerIpc } from "./puppeteerFile";
import { registerScheduledPublishIpc } from "./scheduledPublish";
import { registerSphWindowProductsIpc } from "./sphWindowProducts";
import { createLaunchInstallerHandler } from "./launchInstaller";
import { applyAccountProxyForTask } from "./proxyConfig";
import {
  isAccountLoginPartitionBlocked,
  openAccountLoginWindow,
} from "./accountLoginWindow";
import { guardExternalNavigation } from "./navigationGuard";
import { getAppSettings, updateAppSettings } from "./appSettings";
import { quitForUpdate } from "./updateQuitCoordinator";

const https = require("https");
const version = require("../../../package.json").version;
console.log(version, "-------");
import fs from "fs";
import path from "path";
import xlsx from "xlsx";
function requestJsonUrl(url, fallback) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(String(url || ""));
    } catch (error) {
      console.warn("更新地址无效，跳过:", url);
      resolve(fallback);
      return;
    }
    const requestImpl = parsed.protocol === "http:" ? require("http") : https;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "matrix-video",
      },
    };

    const req = requestImpl.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        if (res.statusCode !== 200) {
          console.warn(`更新地址 ${url} 返回 ${res.statusCode}，跳过解析`);
          resolve(fallback);
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          console.warn("更新地址响应非 JSON，跳过:", data.slice(0, 80));
          resolve(fallback);
        }
      });
    });

    req.on("error", (error) => {
      console.error("Error fetching update metadata:", error);
      resolve(fallback);
    });

    req.end();
  });
}

// Cache Gitee release result for 1 hour to avoid rate-limit (403) on repeated calls
let _releaseCache = null;
let _releaseCacheAt = 0;
let _releaseCacheUrl = "";
const RELEASE_CACHE_TTL_MS = 60 * 60 * 1000;

function looksLikeReleasePayload(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value.tag_name || value.name || Array.isArray(value.assets))
  );
}

async function getLatestRelease(updateUrl) {
  if (
    _releaseCache !== null &&
    _releaseCacheUrl === updateUrl &&
    Date.now() - _releaseCacheAt < RELEASE_CACHE_TTL_MS
  ) {
    return _releaseCache;
  }
  const latest = await requestJsonUrl(updateUrl, null);
  if (looksLikeReleasePayload(latest)) {
    _releaseCache = latest;
    _releaseCacheAt = Date.now();
    _releaseCacheUrl = updateUrl;
    return latest;
  }
  if (Array.isArray(latest) && latest.length > 0) {
    _releaseCache = latest[0];
    _releaseCacheAt = Date.now();
    _releaseCacheUrl = updateUrl;
    return latest[0];
  }

  return null;
}

/** 解析 v0.9.7 / 0.9.7 为可比较的数字（按段比较，避免 0.9.10 与 parseInt 拼接错误） */
function compareSemver(remoteRaw, localRaw) {
  const norm = (s) =>
    String(s || "")
      .replace(/^v/i, "")
      .trim()
      .split(".")
      .map((x) => parseInt(x, 10) || 0);
  const a = norm(remoteRaw);
  const b = norm(localRaw);
  const len = Math.max(a.length, b.length, 3);
  for (let i = 0; i < len; i++) {
    const da = a[i] || 0;
    const db = b[i] || 0;
    if (da !== db) {
      return da > db ? 1 : -1;
    }
  }
  return 0;
}

/**
 * 与 CI 产物命名规则一致（v0.6.1 起 artifactName 统一为 MatrixMedia-${version}-${os}-${arch}.${ext}）：
 *   Win x64:      MatrixMedia-0.6.1-win-x64.exe
 *   Mac (x64):    MatrixMedia-0.6.1-mac-x64.dmg（Apple Silicon 通过 Rosetta 运行）
 *   Linux x64:    MatrixMedia-0.6.1-linux-x64.AppImage（不发 Gitee）
 *
 * 兼容历史命名（旧 Release 包仍可正常升级）：
 *   旧 Win: Setup-0.6.0-win-x64.exe
 *   旧 Mac: 视媒助手-0.6.0-arm64.dmg / 视媒助手-0.6.0.dmg
 */
function pickReleaseInstaller(assets) {
  const list = assets || [];
  const platform = process.platform;
  if (platform === "win32") {
    return (
      list.find((a) => /-win-x64\.exe$/i.test(a.name)) || // 新命名 + 旧 Setup-*-win-x64.exe 都能命中
      list.find((a) => /\.exe$/i.test(a.name))
    );
  }
  if (platform === "darwin") {
    const dmgs = list.filter((a) => /\.dmg$/i.test(a.name));
    const x64Dmg = dmgs.find((a) => /-(mac-)?x64\.dmg$/i.test(a.name));
    const universalDmg = dmgs.find((a) => /-universal\.dmg$/i.test(a.name));
    // 旧版裸命名(如 视媒助手-0.6.0.dmg)做兜底；历史 arm64 包仅兼容旧 Release
    const plainDmg = dmgs.find(
      (a) =>
        !/-arm64\.dmg$/i.test(a.name) &&
        !/-(mac-)?x64\.dmg$/i.test(a.name) &&
        !/-universal\.dmg$/i.test(a.name)
    );
    const armDmg = dmgs.find((a) => /-arm64\.dmg$/i.test(a.name));

    return x64Dmg || universalDmg || plainDmg || armDmg || null;
  }
  return null;
}

let updateDownloadInProgress = false;
let updatePromptShownThisRun = false;
let activeUpdatePromptWindow = null;
let launchInstallerHandler = null;

async function resolveAvailableUpdate(updateUrl) {
  const lastData = await getLatestRelease(updateUrl);
  if (!lastData) return { hasUpdate: false };

  const remoteVersion =
    (lastData.tag_name && String(lastData.tag_name).replace(/^v/i, "")) ||
    (lastData.name && String(lastData.name).replace(/^v/i, ""));
  const installer = pickReleaseInstaller(lastData.assets || []);
  const downloadURL = installer && installer.browser_download_url;
  const hasUpdate = Boolean(downloadURL && compareSemver(remoteVersion, version) > 0);

  return {
    hasUpdate,
    remoteVersion,
    releaseName: lastData.name || lastData.tag_name || "",
    downloadURL,
    downloadName: (installer && installer.name) || "MatrixMedia-update.exe",
  };
}

function closeUpdatePromptWindow() {
  if (activeUpdatePromptWindow && !activeUpdatePromptWindow.isDestroyed()) {
    activeUpdatePromptWindow.close();
  }
  activeUpdatePromptWindow = null;
}

function setUpdatePromptState(promptWindow, state, progress = 0) {
  if (
    !promptWindow ||
    promptWindow.isDestroyed() ||
    !promptWindow.webContents ||
    promptWindow.webContents.isDestroyed()
  ) {
    return;
  }

  const normalizedProgress = Math.max(
    0,
    Math.min(100, Math.round(Number(progress) || 0))
  );
  const script = `window.setUpdateDownloadState && window.setUpdateDownloadState(${JSON.stringify(
    String(state || "downloading")
  )}, ${normalizedProgress})`;
  promptWindow.webContents.executeJavaScript(script, true).catch((error) => {
    console.warn("[更新] 更新下载进度窗口失败:", error?.message || error);
  });
}

function invokeUpdateLifecycle(callback, ...args) {
  if (typeof callback !== "function") return;
  try {
    callback(...args);
  } catch (error) {
    console.warn("[更新] 更新生命周期回调失败:", error?.message || error);
  }
}

function showAvailableUpdatePrompt(event, update) {
  if (
    !update.hasUpdate ||
    !update.remoteVersion ||
    updatePromptShownThisRun ||
    (activeUpdatePromptWindow && !activeUpdatePromptWindow.isDestroyed())
  ) {
    return;
  }

  const mainWindow = BrowserWindow.fromWebContents(event.sender);
  if (!mainWindow || mainWindow.isDestroyed()) return;

  updatePromptShownThisRun = true;
  const { workArea } = screen.getPrimaryDisplay();
  const width = 420;
  const height = 210;
  const promptWindow = new BrowserWindow({
    width,
    height,
    x: Math.max(workArea.x, workArea.x + workArea.width - width - 20),
    y: Math.max(workArea.y, workArea.y + workArea.height - height - 20),
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#ffffff",
    title: "发现新版本",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
  });

  activeUpdatePromptWindow = promptWindow;
  promptWindow.setAlwaysOnTop(true, "floating");
  const remoteVersion = String(update.remoteVersion);
  const escapedRemoteVersion = remoteVersion.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]
  );
  const remoteVersionScriptValue = JSON.stringify(remoteVersion).replace(
    /</g,
    "\\u003c"
  );
  const promptHtml = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; }
    body {
      position: relative;
      overflow: hidden;
      color: #243447;
      background: #fff;
      border: 1px solid #dbe5ef;
      border-left: 4px solid #2563eb;
      border-radius: 10px;
      box-shadow: 0 12px 32px rgba(15, 23, 42, .2);
      font-family: "Microsoft YaHei", "Segoe UI", sans-serif;
      cursor: pointer;
    }
    .close {
      position: absolute;
      top: 8px;
      right: 10px;
      z-index: 2;
      width: 26px;
      height: 26px;
      padding: 0;
      border: 0;
      border-radius: 6px;
      color: #64748b;
      background: transparent;
      font-size: 22px;
      line-height: 24px;
      cursor: pointer;
    }
    .close:hover { color: #0f172a; background: #eef2f7; }
    .content { padding: 22px 26px 12px 24px; }
    .eyebrow { color: #2563eb; font-size: 12px; font-weight: 600; letter-spacing: .04em; }
    .title { margin-top: 7px; color: #0f172a; font-size: 19px; font-weight: 700; }
    .message { margin-top: 10px; color: #526173; font-size: 13px; line-height: 1.65; }
    .hint { margin-top: 5px; color: #64748b; font-size: 12px; line-height: 1.5; }
    .progress { display: none; margin-top: 14px; }
    .progress-meta { display: flex; justify-content: space-between; margin-bottom: 7px; color: #475569; font-size: 12px; }
    .progress-track { height: 7px; overflow: hidden; border-radius: 999px; background: #e2e8f0; }
    .progress-bar { width: 0; height: 100%; border-radius: inherit; background: #2563eb; transition: width .2s ease; }
    .progress-track.indeterminate .progress-bar { width: 35%; animation: downloading 1.2s ease-in-out infinite; }
    body.update-active .progress { display: block; }
    body.update-active .actions { display: none; }
    body.update-active .content { padding-bottom: 22px; }
    @keyframes downloading { from { transform: translateX(-110%); } to { transform: translateX(310%); } }
    .actions { display: flex; justify-content: flex-end; padding: 0 24px 18px; }
    .update { padding: 8px 17px; border: 0; border-radius: 5px; color: #fff; background: #2563eb; font-size: 13px; cursor: pointer; }
    .update:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <button class="close" type="button" aria-label="关闭本次更新提示">×</button>
  <div class="content">
    <div class="eyebrow">视媒助手-客户端更新</div>
    <div class="title">发现新版本 v${escapedRemoteVersion}</div>
    <div class="message">点击立即更新后，客户端将在后台下载更新。</div>
    <div class="hint">下载完成后会自动安装更新；点击右上角关闭则本次不更新。</div>
    <div class="progress" aria-live="polite">
      <div class="progress-meta"><span class="progress-label">准备下载</span><span class="progress-percent">0%</span></div>
      <div class="progress-track indeterminate"><div class="progress-bar"></div></div>
    </div>
  </div>
  <div class="actions"><button class="update" type="button">立即更新</button></div>
  <script>
    const remoteVersion = ${remoteVersionScriptValue};
    const send = (action) => { window.location.href = "matrixmedia-update://" + action; };
    const title = document.querySelector(".title");
    const message = document.querySelector(".message");
    const hint = document.querySelector(".hint");
    const progressLabel = document.querySelector(".progress-label");
    const progressPercent = document.querySelector(".progress-percent");
    const progressTrack = document.querySelector(".progress-track");
    const progressBar = document.querySelector(".progress-bar");
    let updateRequested = false;
    window.setUpdateDownloadState = (state, value) => {
      const progress = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
      document.body.classList.add("update-active");
      if (state === "failed") {
        title.textContent = "更新未完成";
        message.textContent = "新版本下载或安装程序启动失败，请稍后重新检查更新。";
        hint.textContent = "关闭此提示后，可从客户端重新检查更新。";
        progressLabel.textContent = "更新失败";
        progressTrack.classList.remove("indeterminate");
        progressBar.style.width = progress + "%";
        progressPercent.textContent = progress + "%";
        return;
      }
      if (state === "downloaded") {
        title.textContent = "新版本下载完成";
        message.textContent = "正在启动安装程序，请稍候。";
        hint.textContent = "安装程序启动后客户端将自动退出。";
        progressLabel.textContent = "下载完成";
        progressTrack.classList.remove("indeterminate");
        progressBar.style.width = "100%";
        progressPercent.textContent = "100%";
        return;
      }
      title.textContent = "正在下载 v" + remoteVersion;
      message.textContent = "新版本正在后台下载，请保持客户端运行。";
      hint.textContent = "下载完成后会自动启动安装程序；关闭此提示不影响更新。";
      progressLabel.textContent = "下载进度";
      progressPercent.textContent = progress + "%";
      progressTrack.classList.toggle("indeterminate", progress <= 0);
      if (progress > 0) progressBar.style.width = progress + "%";
    };
    const requestInstall = (event) => {
      if (event) event.stopPropagation();
      if (updateRequested) return;
      updateRequested = true;
      window.setUpdateDownloadState("downloading", 0);
      send("install");
    };
    document.querySelector(".close").addEventListener("click", (event) => { event.stopPropagation(); send("dismiss"); });
    document.querySelector(".update").addEventListener("click", requestInstall);
    document.querySelector(".content").addEventListener("click", requestInstall);
    document.body.addEventListener("click", (event) => {
      if (event.target === document.body) requestInstall(event);
    });
  </script>
</body>
</html>`;

  const handlePromptAction = (url) => {
    if (!String(url || "").startsWith("matrixmedia-update://")) return;
    const action = String(url).replace("matrixmedia-update://", "");
    if (action === "install") {
      setUpdatePromptState(promptWindow, "downloading", 0);
      const started = startUpdateDownload(mainWindow, update, true, {
        onProgress: (progress) =>
          setUpdatePromptState(promptWindow, "downloading", progress),
        onDownloadCompleted: () =>
          setUpdatePromptState(promptWindow, "downloaded", 100),
        onInstallerResult: (result) => {
          if (!result || !result.ok) {
            setUpdatePromptState(promptWindow, "failed", 100);
          }
        },
        onTerminated: (state) => {
          if (state !== "completed") {
            setUpdatePromptState(promptWindow, "failed", 0);
          }
        },
      });
      if (!started) setUpdatePromptState(promptWindow, "failed", 0);
    } else if (action === "dismiss") {
      closeUpdatePromptWindow();
    }
  };
  promptWindow.webContents.on("will-navigate", (navigationEvent, url) => {
    if (!String(url || "").startsWith("matrixmedia-update://")) return;
    navigationEvent.preventDefault();
    handlePromptAction(url);
  });
  promptWindow.webContents.setWindowOpenHandler(({ url }) => {
    handlePromptAction(url);
    return { action: "deny" };
  });
  promptWindow.on("closed", () => {
    if (activeUpdatePromptWindow === promptWindow) activeUpdatePromptWindow = null;
  });
  promptWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(promptHtml)}`);
  promptWindow.once("ready-to-show", () => {
    if (!promptWindow.isDestroyed()) promptWindow.showInactive();
  });
}

function startUpdateDownload(
  mainWindow,
  update,
  installAfterDownload = false,
  lifecycle = {}
) {
  if (updateDownloadInProgress || !launchInstallerHandler) {
    console.warn("[更新] 下载未启动：已有更新任务或安装器未初始化");
    return false;
  }

  updateDownloadInProgress = true;
  const tempInstallerPath = installAfterDownload
    ? path.join(
      electronApp.getPath("temp"),
      `matrixmedia-update-${Date.now()}-${String(
        update.downloadName || "MatrixMedia-update.exe"
      ).replace(/[\\/:*?"<>|]/g, "_")}`
    )
    : "";
  console.log(
    `[更新] 开始下载 v${update.remoteVersion}，下载完成后${installAfterDownload ? "自动启动安装程序" : "仅提示下载完成"
    }`
  );
  const downloadOptions = {
    notifyCompleted: !installAfterDownload,
    onProgress: (progress) =>
      invokeUpdateLifecycle(lifecycle.onProgress, progress),
    onCompleted: async (filePath) => {
      console.log(`[更新] 下载完成：${filePath}`);
      invokeUpdateLifecycle(lifecycle.onDownloadCompleted, filePath);
      if (!installAfterDownload) {
        return;
      }

      console.log(`[更新] 正在启动安装程序：${filePath}`);
      const result = await launchInstallerHandler(null, filePath);
      console.log("[更新] 安装程序启动结果：", result);
      invokeUpdateLifecycle(lifecycle.onInstallerResult, result);
      if (!result || !result.ok) {
        dialog.showErrorBox(
          "更新失败",
          result && result.reason === "active-tasks"
            ? "检测到发布任务正在运行，请任务结束后重试更新。"
            : "更新程序启动失败，请稍后重试。"
        );
      }
    },
    onTerminated: (state) => {
      updateDownloadInProgress = false;
      invokeUpdateLifecycle(lifecycle.onTerminated, state);
    },
  };
  const started = installAfterDownload
    ? downloadFile.downloadToPath(
      mainWindow,
      update.downloadURL,
      tempInstallerPath,
      downloadOptions
    )
    : downloadFile.download(mainWindow, update.downloadURL, downloadOptions);
  if (!started) {
    updateDownloadInProgress = false;
    console.warn("[更新] 下载任务创建失败");
  }
  return started;
}

export default {
  async Mainfunc(IsUseSysTitle) {
    const launchInstaller = createLaunchInstallerHandler({
      shell,
      electronApp,
      hasActiveTasks: hasActivePublishTasks,
      quitApp: () => quitForUpdate(electronApp),
    });
    launchInstallerHandler = launchInstaller;

    // Always register the check-for-updates handler first
    ipcMain.handle("check-for-updates", async (event) => {
      const settings = getAppSettings();
      const update = await resolveAvailableUpdate(settings.autoUpdateUrl);
      showAvailableUpdatePrompt(event, update);
      return {
        hasUpdate: update.hasUpdate,
        remoteVersion: update.remoteVersion || "",
        releaseName: update.releaseName || "",
      };
    });

    ipcMain.handle("download-update", async (event, options = {}) => {
      if (updateDownloadInProgress) {
        return { started: false, reason: "in-progress" };
      }

      const settings = getAppSettings();
      const update = await resolveAvailableUpdate(settings.autoUpdateUrl);
      if (!update.hasUpdate) {
        return { started: false, reason: "not-available" };
      }

      const started = startUpdateDownload(
        BrowserWindow.fromWebContents(event.sender),
        update,
        options.installAfterDownload === true
      );
      return { started, remoteVersion: update.remoteVersion };
    });

    ipcMain.handle("get-app-settings", async () => getAppSettings());
    ipcMain.handle("update-app-settings", async (_event, patch) =>
      updateAppSettings(patch || {})
    );

    // 安装由用户主动触发；存在发布任务时拒绝退出和安装。
    ipcMain.handle("launch-installer", launchInstaller);

    // puppeteerFile 上传文件发布，获取登录状态
    registerPuppeteerIpc();
    registerScheduledPublishIpc();
    registerSphWindowProductsIpc(ipcMain);

    // 通用的渲染进程 → 主进程日志透传通道，方便把 webview / Vue 里
    // 不开 DevTools 就看不到的输出，直接打到「主程序日志」那个终端面板。
    // 用法：ipcRenderer.send('mm-debug-log', { tag: 'xxx', payload: any })
    ipcMain.on("mm-debug-log", (_event, args) => {
      try {
        const tag = (args && args.tag) || "debug";
        const payload =
          args && Object.prototype.hasOwnProperty.call(args, "payload")
            ? args.payload
            : args;
        console.log(`[mm-debug-log][${tag}]`, payload);
      } catch (e) {
        console.log("[mm-debug-log] 打印失败:", e && e.message);
      }
    });

    // 账号登录用的独立 BrowserWindow：替代 <webview>，避免小红书等站点
    // 通过 GuestView 指纹 (websectiga / sec_poison_id / window.parent 等) 把会话标红。
    // partition 与视频管理的发布窗口完全一致 (persist:xxx<平台>)，cookie/localStorage
    // 在同一份 Electron session 里共享 —— 在这里扫码登录后，发布流程能直接复用。
    //
    // 互斥策略：同一时间只允许有一个'账号登录窗'。每次调用都会关掉其它
    // partition 的旧登录窗，避免用户切账号时桌面上堆一排登录窗口。
    ipcMain.handle("open-account-login-window", async (_event, args) => {
      const partition = args && args.partition;
      const accountId = args && args.accountId;
      const url = args && args.url;
      const useragent = args && args.useragent;
      const title = args && args.title;
      if (!partition || !url) {
        return { ok: false, message: "partition/url 必填" };
      }
      if (isAccountLoginPartitionBlocked(partition, accountId)) {
        return { ok: false, message: "账号登录数据正在清理，请稍后重试" };
      }

      try {
        await applyAccountProxyForTask({
          partition,
          phone: args && args.phone,
          pt: args && args.pt,
        });
      } catch (proxyErr) {
        console.warn(
          "[open-account-login-window] 应用代理失败:",
          proxyErr && proxyErr.message
        );
        return {
          ok: false,
          message: (proxyErr && proxyErr.message) || "代理配置错误",
        };
      }

      if (isAccountLoginPartitionBlocked(partition, accountId)) {
        return { ok: false, message: "账号登录数据正在清理，请稍后重试" };
      }

      return openAccountLoginWindow({
        accountId,
        partition,
        url,
        useragent,
        title,
      });
    });

    // 通用的弹独立 BrowserWindow 加载任意 URL（不绑定 partition），用于
    // 反馈问卷这种"不需要登录态共享"的场景，统一替代 <webview>。
    ipcMain.handle("open-external-window", async (_event, args) => {
      const url = args && args.url;
      if (!url) return { ok: false, message: "url 必填" };
      const win = new BrowserWindow({
        width: (args && args.width) || 1000,
        height: (args && args.height) || 720,
        title: (args && args.title) || "",
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          webviewTag: false,
          devTools: true,
        },
      });
      try {
        win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      } catch (_) {
        /* ignore */
      }
      guardExternalNavigation(win.webContents);
      try {
        await win.loadURL(url);
      } catch (e) {
        console.warn("[open-external-window] loadURL 失败:", e && e.message);
      }
      return { ok: true };
    });

    // 获取文件下面的文件
    ipcMain.handle("getFiles", (event, args) => {
      if (!fs.existsSync(args)) {
        return [];
      }
      console.log(args, "getFiles");
      return fs.readdirSync(args);
    });
    ipcMain.handle("IsUseSysTitle", async () => {
      return IsUseSysTitle;
    });
    ipcMain.handle("windows-mini", (event, args) => {
      BrowserWindow.fromWebContents(event.sender)?.minimize();
    });
    ipcMain.handle("window-max", async (event, args) => {
      if (BrowserWindow.fromWebContents(event.sender)?.isMaximized()) {
        BrowserWindow.fromWebContents(event.sender)?.unmaximize();
        return { status: false };
      } else {
        BrowserWindow.fromWebContents(event.sender)?.maximize();
        return { status: true };
      }
    });

    ipcMain.handle("window-close", (event, args) => {
      BrowserWindow.fromWebContents(event.sender)?.close();
    });
    ipcMain.handle("start-download", (event, msg) => {
      downloadFile.download(
        BrowserWindow.fromWebContents(event.sender),
        msg.downloadUrL
      );
    });

    ipcMain.handle("reset-app", () => {
      electronApp.relaunch();
      electronApp.exit();
    });
    ipcMain.handle("open-messagebox", async (event, arg) => {
      const res = await dialog.showMessageBox(
        BrowserWindow.fromWebContents(event.sender),
        {
          type: arg.type || "info",
          title: arg.title || "",
          buttons: arg.buttons || [],
          message: arg.message || "",
          noLink: arg.noLink || true,
        }
      );
      return res;
    });
    ipcMain.handle("open-errorbox", (event, arg) => {
      dialog.showErrorBox(arg.title, arg.message);
    });

    // 选择目录的函数
    ipcMain.handle("dialog:openDirectory", async (event) => {
      const result = await dialog.showOpenDialog(
        BrowserWindow.fromWebContents(event.sender),
        {
          properties: ["openDirectory"], // 选择目录
        }
      );
      return result.filePaths[0]; // 返回选中的目录路径
    });

    ipcMain.handle("fs:existsSync", async (_event, filePath) => {
      try {
        return fs.existsSync(filePath);
      } catch (_) {
        return false;
      }
    });

    ipcMain.handle("publish:downloadRemoteFile", async (_event, remoteUrl) => {
      const { resolvePublishFile } = await import("./resolvePublishFile.js");
      const resolved = await resolvePublishFile(remoteUrl);
      // 不调用 cleanup，文件留给重新发布使用
      return resolved.localPath;
    });

    // ── Chrome 浏览器路径配置 ──────────────────────────────────
    ipcMain.handle("chrome:getPath", async () => {
      const { getConfiguredChromePath, getChromeDisplayName } = await import(
        "./chromeConfig.js"
      );
      const chromePath = getConfiguredChromePath();
      return {
        path: chromePath,
        displayName: getChromeDisplayName(chromePath),
      };
    });

    ipcMain.handle("chrome:setPath", async (_event, chromePath) => {
      const { setConfiguredChromePath, getChromeDisplayName } = await import(
        "./chromeConfig.js"
      );
      setConfiguredChromePath(chromePath);
      return {
        path: chromePath,
        displayName: getChromeDisplayName(chromePath),
      };
    });

    ipcMain.handle("chrome:autoDetect", async () => {
      const { autoDetectChromePath, getChromeDisplayName } = await import(
        "./chromeConfig.js"
      );
      const detected = autoDetectChromePath() || "";
      return { path: detected, displayName: getChromeDisplayName(detected) };
    });

    ipcMain.handle("chrome:test", async (_event, chromePath) => {
      const { testChromePath } = await import("./chromeConfig.js");
      return await testChromePath(chromePath);
    });

    ipcMain.handle("chrome:browse", async (event) => {
      const isMac = process.platform === "darwin";
      const result = await dialog.showOpenDialog(
        BrowserWindow.fromWebContents(event.sender),
        {
          title: isMac ? "选择 Chrome 浏览器" : "选择 Chrome 浏览器可执行文件",
          // macOS 选 .app 目录；Windows/Linux 选可执行文件
          properties: isMac
            ? ["openFile", "treatPackageAsDirectory"]
            : ["openFile"],
          filters: isMac
            ? [{ name: "应用程序", extensions: ["app"] }]
            : process.platform === "win32"
              ? [{ name: "可执行文件", extensions: ["exe"] }]
              : [],
          defaultPath: isMac ? "/Applications" : undefined,
        }
      );
      if (result.canceled || !result.filePaths.length) return null;
      let selected = result.filePaths[0];
      // macOS: 用户选了 .app 包，自动解析出内部可执行文件路径
      if (isMac && selected.endsWith(".app")) {
        const { resolveAppBundleExecutable, getChromeDisplayName } =
          await import("./chromeConfig.js");
        const resolved = resolveAppBundleExecutable(selected);
        if (resolved)
          return {
            path: resolved,
            displayName: getChromeDisplayName(resolved),
          };
        return {
          path: selected,
          displayName: path.basename(selected, ".app"),
          error: "无法解析该应用的可执行文件",
        };
      }
      const { getChromeDisplayName } = await import("./chromeConfig.js");
      return { path: selected, displayName: getChromeDisplayName(selected) };
    });

    // 小红书 + 真实浏览器模式：用 puppeteer-core 启动本机 Chrome 打开登录页
    // 与发布流程共享同一个 chrome-xhs-profile userDataDir，登录态自动复用
    let _xhsRealChromeLoginBrowser = null;
    ipcMain.handle("open-xhs-real-chrome-login", async (_event, args) => {
      const url = args && args.url;
      if (!url) return { ok: false, message: "url 必填" };

      // 如果已有打开的 Chrome 实例，尝试 focus
      if (_xhsRealChromeLoginBrowser) {
        try {
          const pages = await _xhsRealChromeLoginBrowser.pages();
          if (pages && pages.length > 0) {
            await pages[0].bringToFront();
            return { ok: true, reused: true };
          }
        } catch (_) {
          // 连接已断开，清理引用
          _xhsRealChromeLoginBrowser = null;
        }
      }

      try {
        const { resolveChromePath } = await import("./chromeConfig.js");
        const chromePath = resolveChromePath();
        if (!chromePath) {
          return {
            ok: false,
            message: "未找到 Chrome 浏览器，请先在发布设置中配置 Chrome 路径",
          };
        }

        const path = await import("path");
        const chromeDataDir = path.default.join(
          electronApp.getPath("userData"),
          "chrome-xhs-profile"
        );

        const puppeteerCore = (await import("puppeteer-core")).default;
        const { addExtra } = await import("puppeteer-extra");
        const puppeteer = addExtra(puppeteerCore);

        const browser = await puppeteer.launch({
          executablePath: chromePath,
          headless: false,
          userDataDir: chromeDataDir,
          ignoreDefaultArgs: ["--enable-automation"],
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled",
            "--no-first-run",
            "--no-default-browser-check",
          ],
          defaultViewport: null,
        });

        _xhsRealChromeLoginBrowser = browser;

        // 浏览器关闭时清理引用
        browser.on("disconnected", () => {
          if (_xhsRealChromeLoginBrowser === browser) {
            _xhsRealChromeLoginBrowser = null;
          }
        });

        const page = (await browser.pages())[0] || (await browser.newPage());

        // 注入反自动化检测
        await page.evaluateOnNewDocument(() => {
          Object.defineProperty(navigator, "webdriver", { get: () => false });
          if (!window.chrome) window.chrome = {};
          window.chrome.runtime = window.chrome.runtime || {};
        });

        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });

        // 只断开 puppeteer 连接，Chrome 窗口保留给用户操作
        browser.disconnect();
        _xhsRealChromeLoginBrowser = null;

        return { ok: true };
      } catch (err) {
        _xhsRealChromeLoginBrowser = null;
        console.error("[xhs-chrome-login] 启动失败:", err?.message || err);
        return {
          ok: false,
          message: "启动真实浏览器失败: " + (err?.message || err),
        };
      }
    });

    ipcMain.handle("dialog:openVideoFile", async (event) => {
      const result = await dialog.showOpenDialog(
        BrowserWindow.fromWebContents(event.sender),
        {
          properties: ["openFile"],
          filters: [
            {
              name: "Video",
              extensions: ["mp4", "mov", "mkv", "avi", "webm", "m4v"],
            },
          ],
        }
      );
      if (
        result.canceled ||
        !result.filePaths ||
        result.filePaths.length === 0
      ) {
        return undefined;
      }
      return result.filePaths[0];
    });

    ipcMain.handle("dialog:openArticleFile", async (event) => {
      const result = await dialog.showOpenDialog(
        BrowserWindow.fromWebContents(event.sender),
        {
          properties: ["openFile"],
          filters: [
            {
              name: "Article",
              extensions: ["md", "txt"],
            },
          ],
        }
      );
      if (
        result.canceled ||
        !result.filePaths ||
        result.filePaths.length === 0
      ) {
        return undefined;
      }
      return result.filePaths[0];
    });

    ipcMain.handle("dialog:openImageFile", async (event) => {
      const result = await dialog.showOpenDialog(
        BrowserWindow.fromWebContents(event.sender),
        {
          properties: ["openFile"],
          filters: [
            {
              name: "Image",
              extensions: ["jpg", "jpeg", "png", "webp"],
            },
          ],
        }
      );
      if (
        result.canceled ||
        !result.filePaths ||
        result.filePaths.length === 0
      ) {
        return undefined;
      }
      return result.filePaths[0];
    });

    ipcMain.handle("dialog:openBatchDir", async (event) => {
      const result = await dialog.showOpenDialog(
        BrowserWindow.fromWebContents(event.sender),
        { properties: ["openDirectory"] }
      );
      if (result.canceled || !result.filePaths || result.filePaths.length === 0)
        return null;
      return result.filePaths[0];
    });

    ipcMain.handle("dialog:openBatchXlsx", async (event) => {
      const result = await dialog.showOpenDialog(
        BrowserWindow.fromWebContents(event.sender),
        {
          properties: ["openFile"],
          filters: [{ name: "Excel", extensions: ["xlsx", "xls"] }],
        }
      );
      if (result.canceled || !result.filePaths || result.filePaths.length === 0)
        return null;
      const filePath = result.filePaths[0];
      try {
        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });
        // 清洗 xlsx 单元格：去 BOM / 零宽 / NBSP / 换行 / 前后空白。
        // trim() 处理不了 ﻿ / ​ /  ，这些是从网页复制单元格最常踩的坑。
        const cleanCell = (v) =>
          String(v || "")
            .replace(/[﻿​‌‍ ]/g, "")
            .replace(/[\r\n\t]/g, "")
            .trim();
        // Normalize: support column headers "文件名"/"fileName", "标题"/"title", "标签"/"tags"
        // 列头本身也可能带不可见字符，做一份归一化映射。
        const normalizedRows = rows
          .map((row) => {
            const map = {};
            Object.keys(row).forEach((k) => {
              const key = cleanCell(k).toLowerCase();
              map[key] = row[k];
            });
            return {
              fileName: cleanCell(
                map["文件名"] != null
                  ? map["文件名"]
                  : map["filename"] != null
                    ? map["filename"]
                    : map["file"] || ""
              ),
              title: cleanCell(
                map["标题"] != null ? map["标题"] : map["title"] || ""
              ),
              tags: cleanCell(
                map["标签"] != null ? map["标签"] : map["tags"] || ""
              ),
            };
          })
          .filter((r) => r.fileName);
        return normalizedRows;
      } catch (e) {
        return { error: e && e.message ? e.message : String(e) };
      }
    });

    // 校验 + 解析批量发布的真实文件路径：
    // - 拼 dirPath + fileName
    // - 如果 fileName 没带后缀（或后缀对不上磁盘大小写），自动在目录里找匹配
    // - 返回每条 { fileName, resolvedPath, exists, matchedFileName }
    ipcMain.handle("resolveBatchFiles", async (event, payload) => {
      try {
        const dirPath = payload && payload.dirPath;
        const fileNames = (payload && payload.fileNames) || [];
        if (!dirPath) return { error: "缺少目录路径" };
        if (!fs.existsSync(dirPath)) return { error: "目录不存在: " + dirPath };
        const dirEntries = fs.readdirSync(dirPath);
        // 建立 normalize 后的索引：忽略大小写 + 去不可见字符 -> 实际文件名
        const norm = (s) =>
          String(s || "")
            .replace(/[﻿​‌‍ ]/g, "")
            .replace(/[\r\n\t]/g, "")
            .trim()
            .toLowerCase();
        const indexByName = new Map(); // 全名（含扩展名）
        const indexByStem = new Map(); // 仅文件名主干（不含扩展名）
        dirEntries.forEach((entry) => {
          indexByName.set(norm(entry), entry);
          const stem = entry.replace(/\.[^/.]+$/, "");
          if (!indexByStem.has(norm(stem))) {
            indexByStem.set(norm(stem), entry);
          }
        });
        const results = fileNames.map((rawName) => {
          const fileName = norm(rawName);
          let matched = null;
          if (indexByName.has(fileName)) {
            matched = indexByName.get(fileName);
          } else if (indexByStem.has(fileName)) {
            // 用户在 xlsx 里只写了文件名主干，自动补磁盘上的真实后缀
            matched = indexByStem.get(fileName);
          } else {
            // 退一步：xlsx 里写了 stem.mp4 但磁盘是 stem.MP4 / stem.mov 之类
            const stem = norm(String(rawName).replace(/\.[^/.]+$/, ""));
            if (indexByStem.has(stem)) {
              matched = indexByStem.get(stem);
            }
          }
          if (matched) {
            return {
              fileName: rawName,
              matchedFileName: matched,
              resolvedPath: path.join(dirPath, matched),
              exists: true,
            };
          }
          return {
            fileName: rawName,
            matchedFileName: "",
            resolvedPath: path.join(dirPath, rawName),
            exists: false,
          };
        });
        return { ok: true, results };
      } catch (e) {
        return { error: e && e.message ? e.message : String(e) };
      }
    });

    ipcMain.handle("dialog:downloadBatchTemplate", async () => {
      try {
        const workbook = xlsx.utils.book_new();
        const wsData = [
          ["文件名", "标题", "标签"],
          ["第01集.mp4", "精彩短剧第一集", "短剧,影视,追剧"],
          ["第02集.mp4", "精彩短剧第二集", "短剧,影视,追剧"],
        ];
        const ws = xlsx.utils.aoa_to_sheet(wsData);
        xlsx.utils.book_append_sheet(workbook, ws, "Sheet1");
        const downloadsDir = electronApp.getPath("downloads");
        const outPath = path.join(downloadsDir, "batch-publish-template.xlsx");
        xlsx.writeFile(workbook, outPath);
        shell.openPath(outPath);
        return { ok: true, path: outPath };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    });

    ipcMain.handle("statr-server", async () => {
      try {
        const serveStatus = await Server.StatrServer();
        return serveStatus;
      } catch (error) {
        dialog.showErrorBox("错误", error);
      }
    });
    ipcMain.handle("stop-server", async (event, arg) => {
      try {
        const serveStatus = await Server.StopServer();
        return serveStatus;
      } catch (error) {
        // dialog.showErrorBox("错误", error);
      }
    });
    let childWin = null;
    let cidArray = [];
    ipcMain.handle("open-win", (event, arg) => {
      let cidJson = { id: null, url: "" };
      let data = cidArray.filter((currentValue) => {
        if (currentValue.url === arg.url) {
          return currentValue;
        }
      });
      if (data.length > 0) {
        //获取当前窗口
        let currentWindow = BrowserWindow.fromId(data[0].id);
        //聚焦窗口
        currentWindow.focus();
      } else {
        //获取主窗口ID
        let parentID = event.sender.id;
        //创建窗口
        childWin = new BrowserWindow({
          width: arg?.width || 842,
          height: arg?.height || 595,
          //width 和 height 将设置为 web 页面的尺寸(译注: 不包含边框), 这意味着窗口的实际尺寸将包括窗口边框的大小，稍微会大一点。
          useContentSize: true,
          //自动隐藏菜单栏，除非按了Alt键。
          autoHideMenuBar: true,
          //窗口大小是否可调整
          resizable: arg?.resizable ?? false,
          //窗口的最小高度
          minWidth: arg?.minWidth || 842,
          show: arg?.show ?? false,
          //窗口透明度
          opacity: arg?.opacity || 1.0,
          //当前窗口的父窗口ID
          parent: parentID,
          frame: IsUseSysTitle,
          webPreferences: {
            nodeIntegration: true,
            webSecurity: false,
            allowRunningInsecureContent: true,
            //使用webview标签 必须开启
            webviewTag: arg?.webview ?? false,
            // 如果是开发模式可以使用devTools
            devTools: process.env.NODE_ENV === "development",
            // 在macos中启用橡皮动画
            scrollBounce: process.platform === "darwin",
            // 临时修复打开新窗口报错
            contextIsolation: false,
          },
        });

        childWin.loadURL(winURL + `#${arg.url}`);
        cidJson.id = childWin?.id;
        cidJson.url = arg.url;
        cidArray.push(cidJson);
        childWin.webContents.once("dom-ready", () => {
          childWin.show();
          childWin.webContents.send("send-data", arg.sendData);
          if (arg.IsPay) {
            // 检查支付时候自动关闭小窗口
            const testUrl = setInterval(() => {
              const Url = childWin.webContents.getURL();
              if (Url.includes(arg.PayUrl)) {
                childWin.close();
              }
            }, 1200);
            childWin.on("close", () => {
              clearInterval(testUrl);
            });
          }
        });
        childWin.on("closed", () => {
          childWin = null;
          let index = cidArray.indexOf(cidJson);
          if (index > -1) {
            cidArray.splice(index, 1);
          }
        });
      }
      childWin.on("maximize", () => {
        if (cidJson.id != null) {
          BrowserWindow.fromId(cidJson.id).webContents.send("w-max", true);
        }
      });
      childWin.on("unmaximize", () => {
        if (cidJson.id != null) {
          BrowserWindow.fromId(cidJson.id).webContents.send("w-max", false);
        }
      });
    });
  },
};
