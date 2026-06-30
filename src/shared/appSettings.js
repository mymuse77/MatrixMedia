"use strict";

export const DEFAULT_APP_SETTINGS = {
  autoUpdateUrl: "https://gitee.com/api/v5/repos/gzlingyi_0/pubtw/releases/latest",//目标更新地址
  skipStartupUpdateCheck: true,//是否跳过启动时检查更新
  hideMainWindowOnStartup: true,//是否不显示主页面
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
