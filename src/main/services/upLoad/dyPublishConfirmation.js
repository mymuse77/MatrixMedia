"use strict";

const PUBLISH_SUCCESS_PATTERNS = [
  "发布成功",
  "作品发布成功",
  "投稿成功",
  "发布完成",
  "提交成功",
  "内容已提交",
  "已提交审核",
];
const PUBLISH_BODY_SUCCESS_PATTERNS = [
  "发布成功",
  "作品发布成功",
  "投稿成功",
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
const VERIFICATION_REQUIRED_PATTERNS = [
  "接收短信验证码",
  "短信验证码",
  "获取验证码",
  "选择其他验证方式",
  "为确保是本人操作",
  "请输入当前手机号",
  "安全验证",
];
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 120 * 1000;
const MAX_CONFIRMATION_TIMEOUT_MS = 180 * 1000;
const MIN_CONFIRMATION_TIMEOUT_MS = 30 * 1000;

function includesAny(text, patterns) {
  return patterns.some((pattern) => text.includes(pattern));
}

function isDyContentManageUrl(value) {
  return /\/creator-micro\/content\/manage(?:[/?#]|$)/i.test(
    String(value || ""),
  );
}

export function resolveDyPublishConfirmationTimeoutMs({
  timeoutMs,
  publishTimeoutMs,
} = {}) {
  const explicitTimeout = Number(timeoutMs);
  if (Number.isFinite(explicitTimeout) && explicitTimeout > 0) {
    return explicitTimeout;
  }

  const totalTimeout = Number(publishTimeoutMs);
  if (Number.isFinite(totalTimeout) && totalTimeout > 0) {
    const safetyMargin =
      totalTimeout > MIN_CONFIRMATION_TIMEOUT_MS
        ? MIN_CONFIRMATION_TIMEOUT_MS
        : Math.floor(totalTimeout * 0.25);
    return Math.max(
      1,
      Math.min(
        totalTimeout,
        Math.min(totalTimeout - safetyMargin, MAX_CONFIRMATION_TIMEOUT_MS),
      ),
    );
  }

  return DEFAULT_CONFIRMATION_TIMEOUT_MS;
}

export function classifyDyPublishConfirmationSnapshot(
  snapshot = {},
  { isDraftMode = false } = {},
) {
  const messages = Array.isArray(snapshot.messages)
    ? snapshot.messages.join(" ")
    : "";
  const bodyText = String(snapshot.bodyText || "");
  const normalizedMessages = messages.replace(/\s+/g, "");
  const normalizedBody = bodyText.replace(/\s+/g, "");
  const successPatterns = isDraftMode
    ? DRAFT_SUCCESS_PATTERNS
    : PUBLISH_SUCCESS_PATTERNS;
  const bodyFailurePatterns = FAILURE_PATTERNS.filter(
    (pattern) => pattern !== "请稍后重试",
  );
  if (
    includesAny(normalizedMessages, FAILURE_PATTERNS) ||
    includesAny(normalizedBody, bodyFailurePatterns)
  ) {
    return "failed";
  }
  if (
    includesAny(normalizedMessages, VERIFICATION_REQUIRED_PATTERNS) ||
    includesAny(normalizedBody, VERIFICATION_REQUIRED_PATTERNS)
  ) {
    return "verification_required";
  }
  // Toast、通知和可见弹窗属于强信号，可以直接确认。整页正文包含大量
  // 固定说明文案（例如“等待上传发布完成”），不能在发布编辑页直接用于
  // 成功判断，否则会在点击发布后 0 秒误报并提前关窗，作品只留下草稿。
  if (includesAny(normalizedMessages, successPatterns)) return "confirmed";
  if (
    !isDraftMode &&
    isDyContentManageUrl(snapshot.url) &&
    includesAny(normalizedBody, PUBLISH_BODY_SUCCESS_PATTERNS)
  ) {
    return "confirmed";
  }
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
    const bodyText = String(document.body?.innerText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 3000);

    return {
      url: location.href,
      title: document.title || "",
      messages,
      bodyText,
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
    timeoutMs,
    publishTimeoutMs,
    intervalMs = 500,
    onSnapshot,
  } = {},
) {
  const confirmationTimeoutMs = resolveDyPublishConfirmationTimeoutMs({
    timeoutMs,
    publishTimeoutMs,
  });
  const startedAt = Date.now();
  const deadline = startedAt + confirmationTimeoutMs;
  let lastSnapshot = null;
  let lastState = "";

  while (Date.now() < deadline) {
    try {
      lastSnapshot = await inspectDyPublishConfirmation(page, {
        isDraftMode,
      });
    } catch (_) {
      lastSnapshot = null;
    }

    if (lastSnapshot?.state !== lastState) {
      lastState = lastSnapshot?.state || "unavailable";
      try {
        if (typeof onSnapshot === "function") {
          onSnapshot(lastSnapshot, {
            elapsedMs: Date.now() - startedAt,
            timeoutMs: confirmationTimeoutMs,
          });
        }
      } catch (_) {
        // 诊断回调失败不能中断平台确认。
      }
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
  const verificationRequired = lastSnapshot?.state === "verification_required";
  error.code = verificationRequired
    ? "publish_verification_timeout"
    : "publish_confirmation_timeout";
  error.verificationRequired = verificationRequired;
  error.confirmationUnknown = !verificationRequired;
  // 点击发布后可能已经被平台接受，未知状态禁止盲目重试，避免重复发布。
  error.nonRetryable = true;
  error.dyPublishConfirmation = lastSnapshot;
  error.waitedMs = Date.now() - startedAt;
  throw error;
}
