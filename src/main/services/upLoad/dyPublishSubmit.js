"use strict";

import {
  WAIT_SELECTOR_APPEAR_MS,
  throwIfPublishCanceled,
  waitForPublishPoll,
} from "./uploadTimeouts.js";

// 在浏览器内执行，供上传就绪判定和最终提交共用。
export function isDyPublishButtonReady(target = "#popover-tip-container") {
  const button = typeof target === "string" ? document.querySelector(target) : target;
  if (!button || !button.isConnected || button.disabled || button.matches(":disabled") ||
    button.getAttribute("aria-disabled") === "true" ||
    button.closest('[inert], [aria-disabled="true"]')) return false;
  const rect = button.getBoundingClientRect();
  const style = getComputedStyle(button);
  return rect.width > 0 && rect.height > 0 &&
    style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none";
}

export async function clickDyPublish(page, isDraftMode, beforeSubmit) {
  const selector = isDraftMode ? "#popover-tip-container+button" : "#popover-tip-container";
  const deadline = Date.now() + WAIT_SELECTOR_APPEAR_MS;
  while (Date.now() < deadline) {
    throwIfPublishCanceled(page);
    const ready = await page.evaluate(isDyPublishButtonReady, selector);
    throwIfPublishCanceled(page);
    if (ready) {
      const button = await page.$(selector);
      if (button && await button.evaluate(isDyPublishButtonReady)) {
        throwIfPublishCanceled(page);
        // 控件可用后再进入提交状态；点击调用后的异常仍按结果未知处理，避免重复发布。
        beforeSubmit?.();
        await button.click({ delay: 200 });
        console.log(`[dy] 已点击${isDraftMode ? "存草稿按钮" : "发布入口"} (${selector})`);
        return;
      }
    }
    await waitForPublishPoll(page, 500);
  }
  throw new Error(`抖音${isDraftMode ? "存草稿" : "发布"}按钮尚未可用`);
}
