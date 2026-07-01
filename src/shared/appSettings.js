"use strict";

export const DEFAULT_APP_SETTINGS = {
  // 自动更新检查的目标地址，支持直接指向 release JSON 接口。
  autoUpdateUrl: "https://gitee.com/api/v5/repos/gzlingyi_0/pubtw/releases/latest",
  // 是否跳过应用启动时的自动更新检查。
  skipStartupUpdateCheck: true,
  // 是否在应用启动时隐藏主界面。
  hideMainWindowOnStartup: false,
  // WebSocket 服务器地址，用于客户端启动后连接矩阵生产服务。
  webSocketServerUrl: "http://8.148.27.94:3000",
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
  };
}
