"use strict";

export const DEFAULT_APP_SETTINGS = {
  // 自动更新检查的目标地址，支持直接指向 release JSON 接口。
  autoUpdateUrl: "https://gitee.com/api/v5/repos/loveteam/local-matrix/releases/latest",
  // 是否跳过应用启动时的自动更新检查。
  skipStartupUpdateCheck: false,
  // 是否在应用启动时隐藏主界面。
  hideMainWindowOnStartup: true,
  // 发布时是否默认显示自动化过程。
  showAutomationProcess: false,
  // 矩阵服务根地址：同时用于 WebSocket 连接、远程下载地址归一化等所有服务端访问场景。
  // webSocketServerUrl: "https://v.ljcsfw.com",
  webSocketServerUrl: "http://127.0.0.1:3000",
};

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeAppSettings(raw = {}) {
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    autoUpdateUrl:
      typeof data.autoUpdateUrl === "string" && data.autoUpdateUrl.trim()
        ? data.autoUpdateUrl.trim()
        : DEFAULT_APP_SETTINGS.autoUpdateUrl,
    webSocketServerUrl:
      typeof data.webSocketServerUrl === "string" &&
        data.webSocketServerUrl.trim()
        ? data.webSocketServerUrl.trim()
        : DEFAULT_APP_SETTINGS.webSocketServerUrl,
    skipStartupUpdateCheck: normalizeBoolean(
      data.skipStartupUpdateCheck,
      DEFAULT_APP_SETTINGS.skipStartupUpdateCheck
    ),
    hideMainWindowOnStartup: normalizeBoolean(
      data.hideMainWindowOnStartup,
      DEFAULT_APP_SETTINGS.hideMainWindowOnStartup
    ),
    showAutomationProcess: normalizeBoolean(
      data.showAutomationProcess,
      DEFAULT_APP_SETTINGS.showAutomationProcess
    ),
  };
}
