"use strict";

import {
  WAIT_UPLOAD_PROCESSING_MS,
  throwIfPublishCanceled,
  isPublishPageClosedError,
  waitForPublishPoll,
} from "./uploadTimeouts.js";

export function classifyDyUploadSnapshot(snapshot) {
  if (snapshot.failure) return "failed";
  if (snapshot.processing) return "processing";
  if (snapshot.uploading) return "uploading";
  // 预览与编辑控件都已就绪才继续，视频地址不限定 CDN 域名。
  if (snapshot.videos?.some((video) =>
    video.visible && video.hasSource &&
    (video.hasSlider || (video.readyState >= 2 && video.duration > 0 && snapshot.hasSavePermission)),
  )) return "ready";
  return "processing";
}

export async function inspectDyUploadState(page) {
  const snapshot = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const text = String(document.body?.innerText || "");
    const progressValues = [];
    for (const element of document.querySelectorAll('[role="progressbar"], .semi-progress')) {
      if (!visible(element)) continue;
      const ariaValue = element.getAttribute("aria-valuenow");
      const raw = ariaValue ?? element.innerText?.match(/(\d+(?:\.\d+)?)\s*%/)?.[1];
      const maximum = ariaValue == null ? 100 : Number(element.getAttribute("aria-valuemax")) || 100;
      const value = raw == null ? NaN : Number(raw) * 100 / maximum;
      if (Number.isFinite(value) && value >= 0 && value <= 100) progressValues.push(value);
    }
    const uploadText = text.match(/(?:上传中|上传进度|正在上传)[^\n%]{0,40}?(\d+(?:\.\d+)?)\s*%/);
    if (uploadText) progressValues.push(Number(uploadText[1]));
    const progress = progressValues.length ? Math.max(...progressValues) : null;
    const errorText = [...document.querySelectorAll('[role="alert"], .semi-toast-content, .semi-message-content, [class*="upload"] [class*="error"]')]
      .filter(visible).map((element) => element.innerText || "").join(" ");
    const videos = [...document.querySelectorAll("video")].slice(0, 10).map((video) => {
      const src = video.currentSrc || video.getAttribute("src") || "";
      let parent = video.parentElement;
      let hasSlider = false;
      // 只检查预览附近的容器，允许平台在 video 外增加包装层。
      for (let depth = 0; parent && parent !== document.body && depth < 4; depth++, parent = parent.parentElement) {
        if (parent.querySelector(".rc-slider.rc-slider-horizontal")) {
          hasSlider = true;
          break;
        }
      }
      let source = "";
      try {
        const url = new URL(src, location.href);
        source = `${url.origin}${url.pathname}`; // 诊断不记录 CDN 查询参数中的签名。
      } catch (_) { }
      return {
        visible: visible(video), hasSource: Boolean(src), source, hasSlider,
        readyState: video.readyState, duration: Number.isFinite(video.duration) ? video.duration : 0,
      };
    });
    return {
      progress,
      uploading: progress != null && progress < 100,
      processing: /转码中|正在转码|视频处理中|正在处理视频/.test(text),
      failure: errorText.match(/视频上传失败|上传失败，请重试|视频处理失败|视频转码失败|不支持该视频格式|视频格式不支持/)?.[0] || "",
      hasSavePermission: text.includes("保存权限"),
      videos,
      bodyText: text.replace(/\s+/g, " ").slice(0, 1000),
    };
  });
  return { ...snapshot, state: classifyDyUploadSnapshot(snapshot) };
}

export async function waitForDyUploadProcessing(page, {
  timeoutMs = WAIT_UPLOAD_PROCESSING_MS,
  intervalMs = 2000,
  onSnapshot,
  onProgress,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const progressByPhase = new Map();
  let lastSnapshot = null;
  let failures = 0;
  while (Date.now() < deadline) {
    throwIfPublishCanceled(page);
    try {
      lastSnapshot = await inspectDyUploadState(page);
    } catch (error) {
      throwIfPublishCanceled(page);
      if (isPublishPageClosedError(error)) throw error;
      if (!/execution context.*destroyed|cannot find context/i.test(error?.message || "")) throw error;
      await waitForPublishPoll(page, intervalMs);
      continue;
    }
    throwIfPublishCanceled(page);
    onSnapshot?.(lastSnapshot);
    const previousProgress = progressByPhase.get(lastSnapshot.state) ?? -1;
    if (lastSnapshot.state !== "ready" && lastSnapshot.progress != null && lastSnapshot.progress > previousProgress) {
      progressByPhase.set(lastSnapshot.state, lastSnapshot.progress);
      onProgress?.(lastSnapshot.progress);
    }
    if (lastSnapshot.state === "ready") return lastSnapshot;
    failures = lastSnapshot.state === "failed" ? failures + 1 : 0;
    if (failures >= 2) {
      const error = new Error(lastSnapshot.failure);
      error.dyPageSnapshot = lastSnapshot;
      throw error;
    }
    await waitForPublishPoll(page, intervalMs);
  }
  const error = new Error("等待抖音视频上传或预览就绪超时");
  error.dyPageSnapshot = lastSnapshot;
  throw error;
}
