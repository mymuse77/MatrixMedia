"use strict";

/**
 * 弱网 / 大文件场景：等待页面出现「上传完成、可继续编辑/发布」等状态的上限。
 * 例如约 2GB @ ~700KB/s 传输约 50 分钟，另预留转码与接口耗时，故用 3 小时档。
 */
export const WAIT_UPLOAD_PROCESSING_MS = 3 * 60 * 60 * 1000;

/** 弱网或页面资源加载慢时，等待必需 DOM 节点出现的统一上限。 */
export const WAIT_SELECTOR_APPEAR_MS = 5 * 60 * 1000;

/**
 * 发布用 BrowserWindow 兜底自动关闭：必须大于弱网下大文件上传所需时间，
 * 否则定时关窗会中断仍在进行的浏览器上传。
 */
export const UPLOAD_WINDOW_AUTO_CLOSE_MS = 4 * 60 * 60 * 1000;

/** CLI `publish` 等待 puppeteerFile-done 的上限，需覆盖弱网下大文件上传 */
export const CLI_PUBLISH_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/** 通用发布看门狗期限；抖音按阶段无进展时间计时，下载和排队独立计时。 */
export const PUBLISH_TASK_TIMEOUT_MS = 6 * 60 * 1000;

/** 单次浏览器发布的看门狗期限；抖音有上传进展时续期。 */
export const PUBLISH_ATTEMPT_TIMEOUT_MS = 3 * 60 * 1000;

/** 单个账号最多执行两次：首次执行加一次自动重试。 */
export const PUBLISH_ATTEMPT_LIMIT = 2;

/** 远程视频单次下载的最大等待时间。 */
export const PUBLISH_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;

/** 防止调用方传入一个无限等待或异常大的单账号超时时间。 */
export const PUBLISH_TASK_TIMEOUT_MAX_MS = 4 * 60 * 60 * 1000;

export function resolvePublishTimeoutMs(value, fallback = PUBLISH_TASK_TIMEOUT_MS) {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(requested), PUBLISH_TASK_TIMEOUT_MAX_MS);
}

const pageSignals = new WeakMap();

export function bindPublishPageSignal(page, signal) {
  pageSignals.set(page, signal);
}

export function throwIfPublishCanceled(page) {
  if (pageSignals.get(page)?.aborted || page.isClosed?.()) {
    const error = new Error("发布任务已结束或页面已关闭");
    error.name = "AbortError";
    error.nonRetryable = true;
    throw error;
  }
}

export function isPublishPageClosedError(error) {
  return /(?:session|target|connection|page).*closed|browser.*disconnected/i.test(
    String(error?.message || error),
  );
}

export async function waitForPublishPoll(page, delayMs) {
  throwIfPublishCanceled(page);
  const signal = pageSignals.get(page);
  if (!signal) return page.waitForTimeout(delayMs);
  let onAbort;
  try {
    await Promise.race([
      page.waitForTimeout(delayMs),
      new Promise((_, reject) => {
        onAbort = () => {
          const error = new Error("发布任务已取消");
          error.name = "AbortError";
          error.nonRetryable = true;
          reject(error);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  throwIfPublishCanceled(page);
}

/**
 * 用短周期 evaluate 轮询替代长时间 waitForFunction，避免 Puppeteer 默认
 * protocolTimeout（约 180s）下单次 CDP Runtime.callFunctionOn 超时。
 *
 * @param {import("puppeteer-core").Page} page
 * @param {() => boolean} pageFn 在浏览器端执行，须可序列化、勿依赖外部闭包
 * @param {number} totalMs
 * @param {number} [stepMs=2000]
 * @param {string} [timeoutMessage] 超时时的 Error.message
 */
export async function pollPageUntil(page, pageFn, totalMs, stepMs = 2000, timeoutMessage) {
  const deadline = Date.now() + totalMs;
  let lastEvaluationError = null;
  while (Date.now() < deadline) {
    throwIfPublishCanceled(page);
    lastEvaluationError = null;
    const ok = await page.evaluate(pageFn).catch((error) => {
      throwIfPublishCanceled(page);
      if (isPublishPageClosedError(error)) throw error;
      // 页面初始化、切页时控件可能尚未挂载；保留条件轮询，记录最后一次异常。
      lastEvaluationError = error;
      return false;
    });
    throwIfPublishCanceled(page);
    if (ok) return;
    await waitForPublishPoll(page, stepMs);
  }
  const err = new Error(timeoutMessage || "等待页面条件超时");
  err.name = "TimeoutError";
  if (lastEvaluationError) err.cause = lastEvaluationError;
  throw err;
}
