"use strict";

const PUBLISH_SUCCESS_PATTERNS = [
  "发布成功",
  "作品发布成功",
  "投稿成功",
  "发布完成",
  "已提交审核",
];
const DRAFT_SUCCESS_PATTERNS = [
  "草稿保存成功",
  "保存草稿成功",
  "已保存至草稿",
  "保存成功",
];
const FAILURE_PATTERNS = [
  "发布失败",
  "投稿失败",
  "保存失败",
  "操作过于频繁",
  "网络异常",
  "系统繁忙",
  "请稍后重试",
];

function includesAny(text, patterns) {
  return patterns.some((pattern) => text.includes(pattern));
}

export function classifyDyPublishConfirmationSnapshot(
  snapshot = {},
  { isDraftMode = false } = {},
) {
  const messages = Array.isArray(snapshot.messages)
    ? snapshot.messages.join(" ")
    : "";
  const normalized = messages.replace(/\s+/g, "");

  const successPatterns = isDraftMode
    ? DRAFT_SUCCESS_PATTERNS
    : PUBLISH_SUCCESS_PATTERNS;
  if (includesAny(normalized, FAILURE_PATTERNS)) return "failed";
  if (includesAny(normalized, successPatterns)) return "confirmed";
  return "pending";
}

export async function inspectDyPublishConfirmation(page, options = {}) {
  const snapshot = await page.evaluate(() => {
    const isVisible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const selectors = [
      "[role='alert']",
      ".semi-toast-content",
      ".semi-notification-content",
      ".semi-modal-body",
      "[class*='toast']",
      "[class*='Toast']",
      "[class*='notification']",
      "[class*='Notification']",
    ];
    const messages = [
      ...new Set(
        [...document.querySelectorAll(selectors.join(","))]
          .filter(isVisible)
          .map((element) =>
            String(element.textContent || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 300),
          )
          .filter(Boolean),
      ),
    ].slice(0, 20);

    return {
      url: location.href,
      title: document.title || "",
      messages,
    };
  });

  return {
    ...snapshot,
    state: classifyDyPublishConfirmationSnapshot(snapshot, options),
  };
}

export async function waitForDyPublishConfirmation(
  page,
  {
    isDraftMode = false,
    timeoutMs = 45 * 1000,
    intervalMs = 500,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = null;

  while (Date.now() < deadline) {
    try {
      lastSnapshot = await inspectDyPublishConfirmation(page, {
        isDraftMode,
      });
    } catch (_) {
      lastSnapshot = null;
    }

    if (lastSnapshot?.state === "confirmed") return lastSnapshot;
    if (lastSnapshot?.state === "failed") {
      const message = lastSnapshot.messages?.[0] || "抖音返回发布失败";
      const error = new Error(message);
      error.name = "DyPublishConfirmationError";
      error.code = "publish_rejected";
      error.dyPublishConfirmation = lastSnapshot;
      throw error;
    }

    await page.waitForTimeout(intervalMs);
  }

  const error = new Error(
    isDraftMode
      ? "保存草稿后未收到抖音成功确认"
      : "点击发布后未收到抖音成功确认",
  );
  error.name = "DyPublishConfirmationError";
  error.code = "publish_confirmation_timeout";
  error.nonRetryable = true;
  error.dyPublishConfirmation = lastSnapshot;
  throw error;
}
