"use strict";

export const DY_UPLOAD_INPUT_LOCATORS = Object.freeze([
  Object.freeze({
    id: "upload-btn-name",
    selector: 'input[name="upload-btn"]',
  }),
]);

const TERMINAL_PAGE_STATES = new Set([
  "login_required",
  "verification_required",
  "page_error",
]);
const LOGIN_PATTERNS = ["登录后即可发布", "请先登录", "扫码登录"];
const VERIFICATION_PATTERNS = [
  "安全验证",
  "身份验证",
  "拖动滑块",
  "请输入验证码",
  "访问过于频繁",
  "操作过于频繁",
];
const PAGE_ERROR_PATTERNS = [
  "页面加载失败",
  "网络异常",
  "系统繁忙",
  "服务异常",
  "请刷新重试",
];
const PAGE_SIGNAL_PATTERNS = [
  ...LOGIN_PATTERNS,
  ...VERIFICATION_PATTERNS,
  ...PAGE_ERROR_PATTERNS,
];

function includesAny(text, patterns) {
  return patterns.some((pattern) => text.includes(pattern));
}

export function classifyDyPageSnapshot(snapshot = {}) {
  if (snapshot.ready) return "ready";

  const url = String(snapshot.url || "").toLowerCase();
  const text = [
    snapshot.bodyText,
    ...(Array.isArray(snapshot.detectedTextSignals)
      ? snapshot.detectedTextSignals
      : []),
  ]
    .join(" ")
    .replace(/\s+/g, "");

  if (
    url.includes("/login") ||
    includesAny(text, LOGIN_PATTERNS)
  ) {
    return "login_required";
  }

  if (includesAny(text, VERIFICATION_PATTERNS)) {
    return "verification_required";
  }

  if (includesAny(text, PAGE_ERROR_PATTERNS)) {
    return "page_error";
  }

  return "loading";
}

export async function inspectDyPublishPage(page) {
  const locators = DY_UPLOAD_INPUT_LOCATORS.map(({ id, selector }) => ({
    id,
    selector,
  }));
  const snapshot = await page.evaluate((configuredLocators, signalPatterns) => {
    const matchedLocator = configuredLocators.find(({ selector }) => {
      try {
        return [...document.querySelectorAll(selector)].some(
          (element) => !element.disabled,
        );
      } catch (_) {
        return false;
      }
    });
    const fileInputs = [...document.querySelectorAll('input[type="file"]')]
      .slice(0, 20)
      .map((input) => ({
        name: input.getAttribute("name") || "",
        id: input.id || "",
        className:
          typeof input.className === "string" ? input.className.slice(0, 200) : "",
        accept: input.getAttribute("accept") || "",
        disabled: Boolean(input.disabled),
      }));
    const fullBodyText = String(document.body?.innerText || "")
      .replace(/\s+/g, " ")
      .trim();

    return {
      url: location.href,
      title: document.title || "",
      ready: Boolean(matchedLocator),
      matchedLocatorId: matchedLocator ? matchedLocator.id : "",
      bodyText: fullBodyText.slice(0, 1000),
      detectedTextSignals: signalPatterns.filter((pattern) =>
        fullBodyText.includes(pattern),
      ),
      fileInputs,
    };
  }, locators, PAGE_SIGNAL_PATTERNS);

  return {
    ...snapshot,
    state: classifyDyPageSnapshot(snapshot),
  };
}

function describeDyPageState(snapshot, timeoutMessage) {
  if (!snapshot) return timeoutMessage;
  if (snapshot.state === "login_required") {
    return "抖音发布页要求重新登录";
  }
  if (snapshot.state === "verification_required") {
    return "抖音发布页触发安全验证或访问限制";
  }
  if (snapshot.state === "page_error") {
    return "抖音发布页加载异常";
  }
  return timeoutMessage;
}

function createDyPageStateError(snapshot, timeoutMessage) {
  const error = new Error(describeDyPageState(snapshot, timeoutMessage));
  error.name = "DyPublishPageError";
  error.code = snapshot?.state || "loading";
  error.dyPageSnapshot = snapshot || null;
  error.nonRetryable =
    snapshot?.state === "login_required" ||
    snapshot?.state === "verification_required";
  return error;
}

export async function waitForDyUploadPageReady(
  page,
  {
    timeoutMs,
    intervalMs = 500,
    timeoutMessage = "未找到抖音视频上传输入框",
  },
) {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = null;
  let terminalState = "";
  let terminalStateCount = 0;

  while (Date.now() < deadline) {
    try {
      lastSnapshot = await inspectDyPublishPage(page);
    } catch (_) {
      lastSnapshot = null;
    }

    if (lastSnapshot?.state === "ready") {
      return lastSnapshot;
    }

    if (lastSnapshot && TERMINAL_PAGE_STATES.has(lastSnapshot.state)) {
      if (terminalState === lastSnapshot.state) {
        terminalStateCount += 1;
      } else {
        terminalState = lastSnapshot.state;
        terminalStateCount = 1;
      }
      // 连续两次识别到同一种异常才快速失败，避免 SPA 切页瞬间误判。
      if (terminalStateCount >= 2) {
        throw createDyPageStateError(lastSnapshot, timeoutMessage);
      }
    } else {
      terminalState = "";
      terminalStateCount = 0;
    }

    await page.waitForTimeout(intervalMs);
  }

  throw createDyPageStateError(lastSnapshot, timeoutMessage);
}

export async function findDyUploadInput(page) {
  for (const locator of DY_UPLOAD_INPUT_LOCATORS) {
    const handles = await page.$$(locator.selector);
    const usableHandles = [];
    for (const handle of handles) {
      const disabled = await handle
        .evaluate((element) => Boolean(element.disabled))
        .catch(() => true);
      if (!disabled) usableHandles.push(handle);
    }
    if (usableHandles.length) {
      return {
        handle: usableHandles[usableHandles.length - 1],
        locator,
      };
    }
  }

  return null;
}
