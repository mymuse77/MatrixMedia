"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");
const { buildSync } = require("esbuild");

const root = path.join(__dirname, "..");
const cacheDir = path.join(root, "test/.cache");
const presentationBundle = path.join(
  cacheDir,
  "publishWindowPresentation.preview.cjs"
);

function loadProductionWindowPresentation() {
  fs.mkdirSync(cacheDir, { recursive: true });
  buildSync({
    entryPoints: [
      path.join(root, "src/main/services/publishWindowPresentation.js"),
    ],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: presentationBundle,
  });
  delete require.cache[require.resolve(presentationBundle)];
  return require(presentationBundle);
}

function createPreviewHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>抖音短信验证预览</title>
  <style>
    * { box-sizing: border-box; }
    html, body { width: 100%; height: 100%; margin: 0; }
    body {
      overflow: hidden;
      color: #1f2329;
      background: #f5f6f7;
      font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif;
    }
    button, input { font: inherit; }
    .app-shell { display: flex; width: 100%; height: 100%; }
    .sidebar {
      width: 176px;
      padding: 22px 14px;
      color: #4e5969;
      background: #fff;
      border-right: 1px solid #eaedf1;
    }
    .brand { display: flex; align-items: center; gap: 9px; margin: 0 8px 28px; color: #111827; font-size: 17px; font-weight: 700; }
    .brand-mark { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px; color: #fff; background: #111827; }
    .publish-entry { margin-bottom: 20px; padding: 11px 14px; color: #fff; background: #111827; border-radius: 8px; font-size: 14px; }
    .nav-item { margin: 5px 0; padding: 10px 12px; border-radius: 7px; font-size: 13px; }
    .nav-item.active { color: #111827; background: #f2f3f5; font-weight: 600; }
    .main { flex: 1; min-width: 0; }
    .topbar { display: flex; align-items: center; justify-content: space-between; height: 58px; padding: 0 28px; background: #fff; border-bottom: 1px solid #eaedf1; }
    .top-links { display: flex; gap: 34px; color: #4e5969; font-size: 13px; }
    .avatar { width: 30px; height: 30px; border-radius: 50%; background: linear-gradient(135deg, #172033, #65758b); }
    .workspace { display: grid; grid-template-columns: minmax(460px, 1fr) 270px; gap: 24px; padding: 28px 34px; }
    .form-card, .assistant-card { padding: 24px; background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(15, 23, 42, .05); }
    .section-title { margin-bottom: 20px; font-size: 18px; font-weight: 700; }
    .field { display: grid; grid-template-columns: 110px 1fr; align-items: center; margin: 20px 0; color: #4e5969; font-size: 13px; }
    .fake-input { height: 36px; border: 1px solid #e5e6eb; border-radius: 5px; background: #fafafa; }
    .radio-line { display: flex; gap: 28px; color: #1f2329; }
    .radio::before { content: ""; display: inline-block; width: 14px; height: 14px; margin-right: 7px; vertical-align: -2px; border: 4px solid #111827; border-radius: 50%; }
    .publish-button { width: 106px; margin-top: 20px; padding: 10px; color: #fff; background: #111827; border: 0; border-radius: 5px; }
    .assistant-card { color: #4e5969; font-size: 13px; line-height: 1.7; }
    .assistant-title { margin-bottom: 18px; color: #1f2329; font-size: 16px; font-weight: 700; }
    .score { margin: 14px 0; color: #3370ff; font-size: 18px; font-weight: 700; }
    .mask { position: fixed; inset: 0; display: grid; place-items: center; padding: 28px; background: rgba(15, 23, 42, .66); }
    .verification-dialog {
      width: 440px;
      padding: 28px 28px 24px;
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 24px 70px rgba(0, 0, 0, .30);
    }
    .back { margin-bottom: 14px; color: #8a9099; font-size: 13px; }
    .dialog-title { margin: 0 0 18px; text-align: center; color: #1f2329; font-size: 19px; font-weight: 700; }
    .dialog-desc { margin-bottom: 22px; color: #6b7280; font-size: 13px; line-height: 1.65; }
    .code-row { display: grid; grid-template-columns: 1fr 120px; height: 44px; overflow: hidden; border-radius: 6px; background: #f3f4f6; }
    .code-input { min-width: 0; padding: 0 15px; border: 0; outline: 0; background: transparent; }
    .get-code { border: 0; border-left: 1px solid #d9dde3; color: #374151; background: transparent; cursor: pointer; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 74px; }
    .action { height: 40px; border: 0; border-radius: 7px; cursor: pointer; }
    .cancel { color: #374151; background: #f1f2f4; }
    .verify { color: #fff; background: #ff8eaa; }
    .other-way { margin-top: 16px; color: #ff4d73; font-size: 12px; }
    .preview-note { position: fixed; right: 18px; bottom: 16px; z-index: 2; padding: 7px 11px; color: #fff; background: rgba(17, 24, 39, .78); border-radius: 999px; font-size: 11px; }
  </style>
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">♪</span>抖音创作者中心</div>
      <div class="publish-entry">＋ 作品发布</div>
      <div class="nav-item">首页</div>
      <div class="nav-item active">内容管理</div>
      <div class="nav-item">数据中心</div>
      <div class="nav-item">收入变现</div>
      <div class="nav-item">创作服务</div>
    </aside>
    <main class="main">
      <header class="topbar"><div class="top-links"><span>首页</span><span>AI分身</span><span>AI工坊</span></div><div class="avatar"></div></header>
      <div class="workspace">
        <section class="form-card">
          <div class="section-title">发布设置</div>
          <div class="field"><span>添加标签</span><div class="fake-input"></div></div>
          <div class="field"><span>关联热点</span><div class="fake-input"></div></div>
          <div class="field"><span>同步发布</span><div class="radio-line"><span class="radio">不同步</span><span>同步</span></div></div>
          <div class="field"><span>谁可以看</span><div class="radio-line"><span class="radio">公开</span><span>好友可见</span></div></div>
          <div class="field"><span>发布时间</span><div class="radio-line"><span class="radio">立即发布</span><span>定时发布</span></div></div>
          <button class="publish-button">发布</button>
        </section>
        <aside class="assistant-card"><div class="assistant-title">发文助手</div><div>快速检测</div><div class="score">检测中 24%</div><div>为增加作品流量，建议同时设置标题和封面。</div></aside>
      </div>
    </main>
  </div>
  <div class="mask">
    <section class="verification-dialog" role="dialog" aria-modal="true" aria-label="接收短信验证码">
      <div class="back">‹ 返回</div>
      <h1 class="dialog-title">接收短信验证码</h1>
      <div class="dialog-desc">为确保是本人操作抖音账号，请输入当前手机号 137****775 收到的短信验证码</div>
      <div class="code-row"><input class="code-input" placeholder="请输入验证码" /><button class="get-code">获取验证码</button></div>
      <div class="actions"><button class="action cancel">取消</button><button class="action verify">验证</button></div>
      <div class="other-way">选择其他验证方式</div>
    </section>
  </div>
  <div class="preview-note">本地模拟 · 关闭请使用窗口右上角 ×</div>
  <script>
    const button = document.querySelector('.get-code');
    button.addEventListener('click', () => {
      let seconds = 60;
      button.disabled = true;
      button.textContent = seconds + ' 秒后重试';
      const timer = setInterval(() => {
        seconds -= 1;
        button.textContent = seconds + ' 秒后重试';
        if (seconds <= 0) {
          clearInterval(timer);
          button.disabled = false;
          button.textContent = '获取验证码';
        }
      }, 1000);
    });
  </script>
</body>
</html>`;
}

let previewWindow = null;

app.whenReady().then(async () => {
  const {
    hidePublishWindowMenu,
    revealPublishVerificationWindow,
  } = loadProductionWindowPresentation();

  previewWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 900,
    minHeight: 620,
    show: false,
    frame: true,
    closable: true,
    autoHideMenuBar: true,
    title: "抖音创作者中心 - 短信验证预览",
    backgroundColor: "#f5f6f7",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: false,
    },
  });

  hidePublishWindowMenu(previewWindow);
  await previewWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(createPreviewHtml())}`
  );

  setTimeout(() => {
    if (previewWindow && !previewWindow.isDestroyed()) {
      revealPublishVerificationWindow(previewWindow);
    }
  }, 600);

  previewWindow.on("closed", () => {
    previewWindow = null;
  });
});

app.on("window-all-closed", () => app.quit());
