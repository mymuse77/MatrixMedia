"use strict";

export const APP_STARTUP_SUCCESS_MESSAGE = "程序启动成功";
export const APP_ALREADY_RUNNING_MESSAGE = "程序正在运行中";

export function createAppNotification({ Notification, logger = console } = {}) {
  return function notifyAppStatus(message) {
    try {
      if (
        !Notification ||
        typeof Notification.isSupported !== "function" ||
        !Notification.isSupported()
      ) {
        return false;
      }

      const notification = new Notification({
        title: "视媒助手",
        body: message,
        silent: false,
      });
      notification.show();
      return true;
    } catch (error) {
      logger.warn(
        "[Notification] 应用状态通知显示失败:",
        error && error.message ? error.message : error
      );
      return false;
    }
  };
}
