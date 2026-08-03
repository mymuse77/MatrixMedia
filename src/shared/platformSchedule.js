"use strict";

export const PLATFORM_SCHEDULE_MODE = "platform";
export const PLATFORM_SCHEDULE_MIN_DELAY_MS = 2 * 60 * 60 * 1000;
export const PLATFORM_SCHEDULE_MAX_DELAY_MS = 14 * 24 * 60 * 60 * 1000;

export function validatePlatformScheduledAt(value, nowMs = Date.now()) {
  const scheduledAt = Number(value);
  if (!Number.isFinite(scheduledAt)) {
    return { ok: false, error: "平台定时缺少有效的 scheduledPublishAt" };
  }
  const delay = scheduledAt - nowMs;
  if (delay < PLATFORM_SCHEDULE_MIN_DELAY_MS) {
    return { ok: false, error: "平台定时发布时间必须至少在 2 小时后" };
  }
  if (delay > PLATFORM_SCHEDULE_MAX_DELAY_MS) {
    return { ok: false, error: "平台定时发布时间不能超过 14 天" };
  }
  return { ok: true, value: scheduledAt };
}
