"use strict";

import { app } from "electron";
import fs from "fs";
import path from "path";

function safeFileSegment(value, fallback) {
  const safe = String(value || "")
    .trim()
    .replace(/[^\w\u4e00-\u9fff-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return safe || fallback;
}

function diagnosticTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function capturePublishFailureDiagnostics({
  page,
  data,
  stage,
  error,
  pageSnapshot,
}) {
  const result = {
    screenshotPath: "",
    metadataPath: "",
  };
  let diagnosticDir;
  try {
    diagnosticDir = path.join(app.getPath("logs"), "publish-diagnostics");
  } catch (pathError) {
    console.warn(
      "[publish-diagnostics] 获取诊断目录失败:",
      pathError?.message || pathError,
    );
    return result;
  }
  const baseName = [
    diagnosticTimestamp(),
    safeFileSegment(data?.pt, "platform"),
    safeFileSegment(data?.phone || data?.partition, "account"),
    safeFileSegment(stage, "failure"),
  ].join("_");
  const screenshotPath = path.join(diagnosticDir, `${baseName}.png`);
  const metadataPath = path.join(diagnosticDir, `${baseName}.json`);

  try {
    await fs.promises.mkdir(diagnosticDir, { recursive: true });
  } catch (mkdirError) {
    console.warn(
      "[publish-diagnostics] 创建诊断目录失败:",
      mkdirError?.message || mkdirError,
    );
    return result;
  }

  try {
    await page.screenshot({
      path: screenshotPath,
      type: "png",
      fullPage: false,
    });
    result.screenshotPath = screenshotPath;
  } catch (screenshotError) {
    console.warn(
      "[publish-diagnostics] 页面截图失败:",
      screenshotError?.message || screenshotError,
    );
  }

  try {
    const metadata = {
      capturedAt: new Date().toISOString(),
      platform: data?.pt || "",
      phone: data?.phone || "",
      partition: data?.partition || "",
      stage,
      attempt: data?.mmCurrentAttempt || null,
      error: error?.message || String(error || ""),
      page: pageSnapshot || null,
      screenshotPath: result.screenshotPath,
    };
    await fs.promises.writeFile(
      metadataPath,
      JSON.stringify(metadata, null, 2),
      "utf8",
    );
    result.metadataPath = metadataPath;
  } catch (metadataError) {
    console.warn(
      "[publish-diagnostics] 写入诊断信息失败:",
      metadataError?.message || metadataError,
    );
  }

  console.log("[publish-diagnostics] 已保存发布失败诊断:", result);
  return result;
}
