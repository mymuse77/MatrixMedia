"use strict";

import fs from "fs";
import path from "path";
import axios from "axios";
import { app } from "electron";
import crypto from "crypto";

const REMOTE_FILE_RE = /^https?:\/\//i;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const activeDownloads = new Map();

export function isRemotePublishFile(file) {
  return REMOTE_FILE_RE.test(String(file || "").trim());
}

export function guessFileNameFromUrl(url) {
  try {
    const parsed = new URL(String(url).trim());
    const base = path.basename(decodeURIComponent(parsed.pathname || ""));
    if (base && base !== "/" && base !== ".") {
      return base;
    }
  } catch (_) {
    /* ignore */
  }
  return `matrixmedia-${Date.now()}.mp4`;
}

function getPublishCacheDir() {
  return path.join(app.getPath("documents"), "MatrixMedia", "cache", "publish-media");
}

function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (e) {
    console.warn(
      "MatrixMedia: 清理临时视频失败:",
      filePath,
      e && e.message ? e.message : e
    );
  }
}

function safeRename(from, to) {
  try {
    if (fs.existsSync(to)) {
      safeUnlink(to);
    }
    fs.renameSync(from, to);
  } catch (error) {
    safeUnlink(from);
    throw error;
  }
}

function sanitizeCacheKey(value) {
  return String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 96);
}

function hashRemoteUrl(url) {
  return crypto
    .createHash("sha256")
    .update(String(url || ""))
    .digest("hex")
    .slice(0, 24);
}

function getCacheKey(raw, options = {}) {
  const explicitKey = sanitizeCacheKey(
    options.cacheKey ||
      options.serverId ||
      options.matrixItemId ||
      options.itemId ||
      ""
  );
  if (explicitKey) return explicitKey;
  return `url-${hashRemoteUrl(raw)}`;
}

function getCacheFilePath(raw, options = {}) {
  const cacheDir = getPublishCacheDir();
  const cacheKey = getCacheKey(raw, options);
  const guessedName = guessFileNameFromUrl(options.fileName || raw);
  const ext = path.extname(guessedName) || ".mp4";
  return path.join(cacheDir, `${cacheKey}${ext}`);
}

function isUsableLocalFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch (_) {
    return false;
  }
}

function getHostnameFromUrl(value) {
  try {
    return new URL(String(value || "").trim()).host.toLowerCase();
  } catch (_) {
    return "";
  }
}

function removeRedirectOnlyHeaders(headers) {
  if (!headers || typeof headers !== "object") return;
  delete headers.Authorization;
  delete headers.authorization;
  delete headers["X-Matrix-Client-Id"];
  delete headers["x-matrix-client-id"];
  delete headers["X-Matrix-Task-Id"];
  delete headers["x-matrix-task-id"];
}

function normalizeRequestHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return undefined;
  }

  const normalized = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = String(rawKey || "").trim();
    if (!key) continue;

    const value = Array.isArray(rawValue)
      ? rawValue.map((item) => String(item || "").trim()).filter(Boolean).join(", ")
      : String(rawValue || "").trim();

    if (value) {
      normalized[key] = value;
    }
  }

  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizeDownloadError(error) {
  const status = Number(error?.response?.status);
  const responseText = typeof error?.response?.data === "string"
    ? error.response.data.replace(/\s+/g, " ").trim().slice(0, 240)
    : "";
  const baseMessage = String(error?.message || "远程视频下载失败").trim() || "远程视频下载失败";
  const statusText = Number.isFinite(status) && status > 0 ? `（HTTP ${status}）` : "";
  const detailText = responseText ? `：${responseText}` : "";
  const safeError = new Error(`下载视频失败${statusText}${detailText || `：${baseMessage}`}`);
  if (error?.code) safeError.code = String(error.code);
  return safeError;
}

/**
 * 将发布 file 解析为本地路径；若为 http(s) URL 则下载到可复用缓存目录。
 * @param {string} file 本地路径或 http(s) URL
 * @param {{ headers?: Record<string, string|string[]>, cacheKey?: string, serverId?: string, matrixItemId?: string, itemId?: string, fileName?: string, downloadTimeoutMs?: number }} [options]
 * @returns {Promise<{ localPath: string, remoteUrl: string|null, cleanup: (() => void)|null }>}
 */
export async function resolvePublishFile(file, options = {}) {
  const raw = String(file || "").trim();
  if (!raw) {
    throw new Error("file 不能为空");
  }

  if (!isRemotePublishFile(raw)) {
    return {
      localPath: path.resolve(raw),
      remoteUrl: null,
      cleanup: null,
    };
  }

  const localPath = getCacheFilePath(raw, options);
  const partPath = `${localPath}.download`;
  fs.mkdirSync(path.dirname(localPath), { recursive: true });

  if (isUsableLocalFile(localPath)) {
    const stat = fs.statSync(localPath);
    console.log(
      "[resolvePublishFile] 使用本地缓存视频:",
      JSON.stringify({
        remoteUrl: raw,
        localPath,
        sizeMB: Number((stat.size / 1024 / 1024).toFixed(2)),
      })
    );
    return {
      localPath,
      remoteUrl: raw,
      cleanup: null,
    };
  }

  const activeDownload = activeDownloads.get(localPath);
  if (activeDownload) {
    console.log(
      "[resolvePublishFile] 等待同一视频下载完成:",
      JSON.stringify({ remoteUrl: raw, localPath })
    );
    await activeDownload;
    if (!isUsableLocalFile(localPath)) {
      throw new Error(`视频缓存不可用: ${localPath}`);
    }
    return {
      localPath,
      remoteUrl: raw,
      cleanup: null,
    };
  }

  const headers = normalizeRequestHeaders(options?.headers);
  const originalHost = getHostnameFromUrl(raw);
  console.log(
    "[resolvePublishFile] 开始下载远程视频:",
    JSON.stringify({ remoteUrl: raw, localPath })
  );

  const downloadPromise = (async () => {
    safeUnlink(partPath);

    const response = await axios({
      method: "GET",
      url: raw,
      headers,
      responseType: "stream",
      timeout: Number(options.downloadTimeoutMs) > 0
        ? Number(options.downloadTimeoutMs)
        : DEFAULT_DOWNLOAD_TIMEOUT_MS,
      maxRedirects: 5,
      beforeRedirect: (options) => {
        const nextHost = String(options?.host || options?.hostname || "").toLowerCase();
        if (originalHost && nextHost && nextHost !== originalHost) {
          removeRedirectOnlyHeaders(options.headers);
        }
      },
      validateStatus: (status) => status >= 200 && status < 300,
    });

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(partPath);
      response.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", (err) => {
        safeUnlink(partPath);
        reject(err);
      });
      response.data.on("error", (err) => {
        safeUnlink(partPath);
        reject(err);
      });
    });

    const stat = fs.statSync(partPath);
    if (!stat.isFile() || stat.size <= 0) {
      safeUnlink(partPath);
      throw new Error("下载的视频文件为空");
    }

    safeRename(partPath, localPath);
    const finalStat = fs.statSync(localPath);

    console.log(
      "[resolvePublishFile] 下载完成:",
      JSON.stringify({
        remoteUrl: raw,
        localPath,
        sizeMB: Number((finalStat.size / 1024 / 1024).toFixed(2)),
      })
    );
  })();

  activeDownloads.set(localPath, downloadPromise);

  try {
    await downloadPromise;
    return {
      localPath,
      remoteUrl: raw,
      cleanup: null,
    };
  } catch (error) {
    const safeError = normalizeDownloadError(error);
    console.error(
      "[resolvePublishFile] 下载失败:",
      JSON.stringify({
        remoteUrl: raw,
        localPath,
        error: safeError.message,
        code: safeError.code || undefined,
      })
    );
    safeUnlink(partPath);
    throw safeError;
  } finally {
    if (activeDownloads.get(localPath) === downloadPromise) {
      activeDownloads.delete(localPath);
    }
  }
}
