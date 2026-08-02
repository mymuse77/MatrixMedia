"use strict";

import { Notification } from "electron";
import path from "path";

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function getVideoName(value) {
  const normalized = cleanText(value).split(/[?#]/, 1)[0];
  if (!normalized) return "视频";

  const basename = path.basename(normalized.replaceAll("\\", "/"));
  if (!basename) return "视频";
  return basename.length > 48 ? `${basename.slice(0, 45)}...` : basename;
}

export function notifyPublishSuccess({ phone, platform, videoName }) {
  try {
    if (!Notification || typeof Notification.isSupported !== "function" || !Notification.isSupported()) return false;

    const accountText = cleanText(phone) || "账号";
    const platformText = cleanText(platform) || "平台";
    const videoText = getVideoName(videoName);
    const notification = new Notification({
      title: "视频发布成功",
      body: `${accountText} · ${platformText} · ${videoText} 发布成功`,
      silent: false,
    });
    notification.show();
    return true;
  } catch (error) {
    console.warn("[Notification] 发布成功通知显示失败:", error?.message || error);
    return false;
  }
}

export function __test__() {
  return { getVideoName };
}
