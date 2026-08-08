"use strict";

import path from "path";
import { normalizeCreativeStatement } from "../../shared/creativeStatement.js";
import { getAppSettings } from "./appSettings";
import ptConfig from "../config/ptConfig";
import { runPuppeteerTask } from "./puppeteerFile";
import { changeData } from "../server/utils";
import { createScheduledRecord } from "./scheduledPublish";
import { CLI_PUBLISH_TIMEOUT_MS } from "./upLoad/uploadTimeouts.js";
import {
  isRemotePublishFile,
  resolvePublishFile,
  guessFileNameFromUrl,
} from "./resolvePublishFile";
import { resolveAccountPublishMode } from "./accountPublishSettingsResolver.js";
import { getAccountLoginStatus } from "./accountLoginStatus.js";
import {
  PLATFORM_SCHEDULE_MODE,
  validatePlatformScheduledAt,
} from "../../shared/platformSchedule.js";

function fileStemFromSource(source) {
  const raw = String(source || "").trim();
  const base = isRemotePublishFile(raw)
    ? guessFileNameFromUrl(raw)
    : path.basename(path.resolve(raw));
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(0, i) : base;
}

function todayYmd() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatPublishAt(value) {
  const d = new Date(Number(value));
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function derivePhoneForRecord(v) {
  if (v.phone) return String(v.phone);
  if (!v.partition) return "";
  const stripped = String(v.partition).replace(/^persist:/, "");
  const idx = stripped.indexOf(v.platform);
  return idx > 0 ? stripped.slice(0, idx) : stripped;
}

function getRemoteCacheKey(v) {
  return String(
    v.serverId ||
      v.matrixItemId ||
      v.itemId ||
      v.videoId ||
      v.id ||
      ""
  ).trim();
}

/**
 * 写入一条 pushData 记录并回读其自增 id（changeData 只在返回的全量列表里带 id，
 * 需要按业务字段反查最新一条）。三处调用（定时记录 / 正常发布记录 / 登录失效
 * 短路记录）共用同一套查找逻辑，只是匹配条件略有差异，故用 predicate 抽象。
 */
function addPushDataRecord(item, matchPredicate) {
  let recordId = null;
  try {
    const addRes = changeData({ fileName: "pushData", type: "add", item });
    if (addRes && addRes.success && Array.isArray(addRes.data)) {
      const found = [...addRes.data].reverse().find(matchPredicate);
      if (found) recordId = found.id;
    }
  } catch (e) {
    console.error("MatrixMedia: 写入 pushData 记录失败:", e && e.message);
  }
  return recordId;
}

/**
 * 单文件发布（与 cli publish 单文件模式一致）
 * @param {object} v parsePublishArgs 解析后的参数
 * @param {{ sourceFile: string, resolvedFile: string } | null} fileContext 多平台复用已下载文件时传入
 * @returns {Promise<{ exitCode: number, status?: string, scheduled?: boolean, id?: string|null, publishAt?: string, message?: string }>}
 */
export async function runSingleFilePublish(
  v,
  fileContext = null,
  options = {}
) {
  const cfg = ptConfig[v.platform];
  if (!cfg) {
    return {
      exitCode: 2,
      status: "failed",
      message: `内部错误: 未找到平台配置 ${v.platform}`,
    };
  }

  const sourceFile = String(v.file || "").trim();
  const stem = fileStemFromSource(sourceFile);
  const bt1 = String(v.title).trim();
  const bt2 = (v.bt2 && String(v.bt2).trim()) || "";
  const bookName = (v.bookName && String(v.bookName).trim()) || stem;

  let cleanupDownload = null;
  let resolvedFile = sourceFile;
  const deferRemoteDownload =
    !fileContext && v.publishAt && isRemotePublishFile(sourceFile);

  if (fileContext) {
    resolvedFile = fileContext.resolvedFile;
  } else if (!deferRemoteDownload) {
    try {
      const resolved = await resolvePublishFile(sourceFile, {
        cacheKey: getRemoteCacheKey(v),
      });
      resolvedFile = resolved.localPath;
      cleanupDownload = resolved.cleanup;
    } catch (e) {
      return {
        exitCode: 1,
        status: "failed",
        message: `下载视频失败: ${e && e.message ? e.message : e}`,
      };
    }
  }

  try {
    return await runSingleFilePublishInner(
      v,
      cfg,
      {
        sourceFile,
        resolvedFile,
        stem,
        bt1,
        bt2,
        bookName,
      },
      options
    );
  } finally {
    if (cleanupDownload) cleanupDownload();
  }
}

async function runSingleFilePublishInner(
  v,
  cfg,
  { sourceFile, resolvedFile, stem, bt1, bt2, bookName },
  options = {}
) {
  // 结合「请求显式 draft」与账号「默认发布到草稿」设置，算出最终发布模式
  const effectivePublishMode = resolveAccountPublishMode({
    phone: derivePhoneForRecord(v),
    pt: v.platform,
    requestDraftMode: Boolean(v.draft),
  });
  const showAutomationProcess =
    typeof v.show === "boolean"
      ? v.show
      : Boolean(getAppSettings()?.showAutomationProcess);

  const taskPayload = {
    taskId: Date.now() + Math.random(),
    bookName,
    textType: "local",
    data: {
      textOtherName: stem,
      bt1,
      bt2,
      bq: String(v.bq || "").trim(),
      bdText: "",
      creativeStatement: normalizeCreativeStatement(v.creativeStatement || ""),
    },
    url: cfg.upload,
    show: showAutomationProcess,
    mmCliSuppressWindow: !showAutomationProcess,
    publishMode: effectivePublishMode.publishMode,
    publishToDraft: effectivePublishMode.publishToDraft,
    closeWindowAfterPublish: showAutomationProcess ? v.closeWindowAfterPublish : true,
    useragent: cfg.useragent,
    partition: v.partition,
    phone: derivePhoneForRecord(v),
    filePath: resolvedFile,
    pt: v.platform,
    useRealBrowser: Boolean(v.useRealBrowser),
  };

  const taskId = taskPayload.taskId;
  const recordDate = todayYmd();
  const selectedFile = isRemotePublishFile(sourceFile)
    ? guessFileNameFromUrl(sourceFile)
    : path.basename(resolvedFile);
  const recordItem = {
    bookName,
    textOtherName: stem,
    textType: "local",
    pt: v.platform,
    selectedFile,
    bt: bt1,
    bt2,
    bq: String(v.bq || "").trim(),
    creativeStatement: normalizeCreativeStatement(v.creativeStatement || ""),
    filePath:
      v.publishAt && isRemotePublishFile(sourceFile)
        ? sourceFile
        : resolvedFile,
    remoteFileUrl: isRemotePublishFile(sourceFile) ? sourceFile : "",
    useragent: cfg.useragent,
    phone: derivePhoneForRecord(v),
    partition: v.partition,
    url: cfg.listIndex,
    uploadUrl: cfg.upload,
    date: recordDate,
    publishAttemptCount: 1,
    republishCount: 0,
    publishSuccessCount: 0,
    publishFailCount: 0,
    publishMode: effectivePublishMode.publishMode,
    publishToDraft: effectivePublishMode.publishToDraft,
    publishStatus: effectivePublishMode.publishToDraft ? "drafting" : "publishing",
    lastPublishMessage: effectivePublishMode.publishToDraft
      ? "等待保存草稿结果"
      : "等待发布结果",
    lastPublishAt: Date.now(),
  };

  if (v.scheduleMode === PLATFORM_SCHEDULE_MODE) {
    if (v.publishAt) {
      return {
        exitCode: 2,
        status: "failed",
        message: "平台定时请使用 scheduledPublishAt，不要同时传 publishAt",
      };
    }
    if (recordItem.pt !== "抖音") {
      return {
        exitCode: 2,
        status: "failed",
        message: "平台定时当前仅支持抖音",
      };
    }
    const scheduleValidation = validatePlatformScheduledAt(v.scheduledPublishAt);
    if (!scheduleValidation.ok) {
      return {
        exitCode: 2,
        status: "failed",
        message: scheduleValidation.error,
      };
    }
    recordItem.platformScheduleMode = PLATFORM_SCHEDULE_MODE;
    recordItem.platformScheduledPublishAt = scheduleValidation.value;
    recordItem.platformScheduledPublishAtText = formatPublishAt(scheduleValidation.value);
  }

  if (v.publishAt) {
    let scheduledRecord;
    try {
      scheduledRecord = createScheduledRecord(recordItem, v.publishAt);
    } catch (e) {
      return {
        exitCode: 2,
        status: "failed",
        message: e && e.message ? e.message : String(e),
      };
    }
    try {
      const addRes = changeData({
        fileName: "pushData",
        type: "add",
        item: scheduledRecord,
      });
      let recordId = null;
      if (addRes && addRes.success && Array.isArray(addRes.data)) {
        const found = [...addRes.data]
          .reverse()
          .find(
            (it) =>
              it.scheduledTask === true &&
              it.scheduledPublishAt === scheduledRecord.scheduledPublishAt &&
              it.textOtherName === scheduledRecord.textOtherName &&
              it.pt === scheduledRecord.pt &&
              it.selectedFile === scheduledRecord.selectedFile &&
              it.textType === scheduledRecord.textType
          );
        if (found) recordId = found.id;
      }
      return {
        exitCode: 0,
        status: "scheduled",
        scheduled: true,
        id: recordId,
        publishAt: scheduledRecord.scheduledPublishAtText,
        message: "定时发布任务已创建，已写入发布历史",
      };
    } catch (e) {
      return {
        exitCode: 1,
        status: "failed",
        message: `写入定时发布记录失败: ${e && e.message ? e.message : e}`,
      };
    }
  }

  const matchesRecordItem = (it) =>
    it.textOtherName === recordItem.textOtherName &&
    it.pt === recordItem.pt &&
    it.selectedFile === recordItem.selectedFile &&
    it.textType === recordItem.textType;

  // 发布前登录态检测：复用账号管理 / cli accounts 同款 Cookie 判定
  // （getAccountLoginStatus），命中"确定失效"就直接写一条失败记录并短路
  // 返回，不再打开发布窗口、不进 puppeteer 队列，让 HTTP/CLI/MCP 调用方
  // 第一时间拿到准确的失败原因，而不是等一轮重试超时后收到无关的提示。
  // 该检测目前仅覆盖有明确 cookie 规则的平台（抖音/快手/百家号/哔哩哔哩/
  // 头条/视频号/小红书）；未覆盖的平台（如番茄视频）会返回 loginStatus
  // "unknown"，此时不短路，按原流程继续尝试发布。
  try {
    // partition 有时带用于内部去重的 "-xxx" 后缀（参考 puppeteerFile.js /
    // proxyConfig.js 同样的归一化），必须先剥掉，否则会查到一个不存在的
    // session 分区，永远拿不到登录 cookie，把正常账号误判为"登录失效"。
    const normalizedPartition = v.partition
      ? String(v.partition).split("-")[0]
      : v.partition;
    const loginStatus = await getAccountLoginStatus({
      phone: derivePhoneForRecord(v),
      platform: v.platform,
      url: cfg.index,
      partition: normalizedPartition,
    });
    if (loginStatus.loginStatus === "expired") {
      const message = `${v.platform}（${
        derivePhoneForRecord(v) || "未知账号"
      }）登录状态已失效，请重新登录后再试`;
      console.warn(`MatrixMedia: ${message}`);
      const failedRecordId = addPushDataRecord(
        {
          ...recordItem,
          publishStatus: "failed",
          publishSuccessCount: 0,
          publishFailCount: 1,
          lastPublishMessage: message,
        },
        matchesRecordItem
      );
      return { exitCode: 3, status: "failed", message, id: failedRecordId };
    }
  } catch (e) {
    console.warn(
      "MatrixMedia: 发布前登录态预检测异常，跳过预检查，按原流程继续:",
      e && e.message
    );
  }

  const recordId = addPushDataRecord(recordItem, matchesRecordItem);

  const updateRecord = (status, message) => {
    if (!recordId) return;
    try {
      changeData({
        fileName: "pushData",
        type: "update",
        item: {
          id: recordId,
          date: recordDate,
          publishStatus: status,
          publishSuccessCount: status === "success" ? 1 : 0,
          publishFailCount: status === "failed" ? 1 : 0,
          lastPublishMessage: message || "",
          lastPublishAt: Date.now(),
        },
      });
    } catch (e) {
      console.error("MatrixMedia: 更新 pushData 记录失败:", e && e.message);
    }
  };

  return await new Promise((resolve) => {
    const waitForResult = options.waitForResult !== false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof options.onDone === "function") {
        try {
          options.onDone(result);
        } catch (e) {
          console.error("MatrixMedia: 发布完成回调失败:", e && e.message);
        }
      }
      if (waitForResult) resolve(result);
    };

    const timer = setTimeout(() => {
      const min = Math.round(CLI_PUBLISH_TIMEOUT_MS / 60000);
      const message = `发布超时（${min} 分钟），请检查网络或登录态`;
      console.error(message);
      updateRecord("failed", message);
      finish({ exitCode: 1, status: "failed", message, id: recordId });
    }, CLI_PUBLISH_TIMEOUT_MS);

    const transport = {
      reply(channel, payload) {
        if (channel === "puppeteerFile-done") {
          if (payload && payload.taskId != null && payload.taskId !== taskId) {
            return;
          }
          if (payload && payload.skipped) {
            const message = payload.message || "用户关闭窗口，已跳过发布";
            updateRecord("skipped", message);
            finish({
              exitCode: 0,
              status: "skipped",
              message,
              id: recordId,
            });
            return;
          }
          const ok = payload && payload.status === true;
          const message =
            (payload && payload.message) || (ok ? "上传成功" : "上传失败");
          updateRecord(ok ? "success" : "failed", message);
          finish({
            exitCode: ok ? 0 : 3,
            status: ok ? "success" : "failed",
            message,
            id: recordId,
          });
        } else if (channel === "puppeteer-noLogin") {
          if (payload && payload.taskId != null && payload.taskId !== taskId) {
            return;
          }
          const message = "登录态异常或未登录";
          console.error("登录态异常或未登录:", JSON.stringify(payload));
          updateRecord("failed", message);
          finish({ exitCode: 3, status: "failed", message, id: recordId });
        }
      },
    };

    runPuppeteerTask(taskPayload, transport, () => {});
    if (!waitForResult) {
      resolve({
        exitCode: 0,
        status: "submitted",
        message: "已提交发布任务",
        id: recordId,
      });
    }
  });
}

function sortPublishPlatforms(list) {
  return [...list].sort((a, b) => {
    if (a.platform.includes("视频号")) return -1;
    if (b.platform.includes("视频号")) return 1;
    return 0;
  });
}

/**
 * 多平台顺序发布；远程视频会复用本地缓存，避免重复下载
 * @param {object[]} parsedList
 */
export async function runMultiPlatformPublish(parsedList) {
  if (!Array.isArray(parsedList) || parsedList.length === 0) {
    return {
      success: false,
      exitCode: 2,
      status: "failed",
      message: "平台列表为空",
      total: 0,
      succeeded: 0,
      failed: 0,
      results: [],
    };
  }

  if (parsedList.length === 1) {
    const result = await runSingleFilePublish(parsedList[0]);
    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      status: result.status || (result.exitCode === 0 ? "success" : "failed"),
      message: result.message || "",
      id: result.id ?? null,
      publishAt: result.publishAt ?? null,
      scheduled: result.scheduled === true,
      total: 1,
      succeeded: result.exitCode === 0 ? 1 : 0,
      failed: result.exitCode === 0 ? 0 : 1,
      results: [
        {
          platform: parsedList[0].platform,
          phone: parsedList[0].phone || "",
          creativeStatement: parsedList[0].creativeStatement || "none",
          success: result.exitCode === 0,
          exitCode: result.exitCode,
          status: result.status,
          message: result.message || "",
          id: result.id ?? null,
          publishAt: result.publishAt ?? null,
          scheduled: result.scheduled === true,
        },
      ],
    };
  }

  const sourceFile = String(parsedList[0].file || "").trim();
  const allScheduled = parsedList.every((item) => item.publishAt);
  const deferRemoteDownload = allScheduled && isRemotePublishFile(sourceFile);

  let cleanupDownload = null;
  let fileContext = null;

  if (!deferRemoteDownload) {
    try {
      const resolved = await resolvePublishFile(sourceFile, {
        cacheKey: getRemoteCacheKey(parsedList[0]),
      });
      fileContext = {
        sourceFile,
        resolvedFile: resolved.localPath,
      };
      cleanupDownload = resolved.cleanup;
    } catch (e) {
      return {
        success: false,
        exitCode: 1,
        status: "failed",
        message: `下载视频失败: ${e && e.message ? e.message : e}`,
        total: parsedList.length,
        succeeded: 0,
        failed: parsedList.length,
        results: [],
      };
    }
  }

  const results = [];
  let pendingCleanupCount = parsedList.length;
  const releaseSharedDownload = () => {
    pendingCleanupCount -= 1;
    if (pendingCleanupCount <= 0 && cleanupDownload) {
      cleanupDownload();
      cleanupDownload = null;
    }
  };

  try {
    for (const item of sortPublishPlatforms(parsedList)) {
      const result = await runSingleFilePublish(item, fileContext, {
        waitForResult: true,
        onDone: releaseSharedDownload,
      });
      results.push({
        platform: item.platform,
        phone: item.phone || "",
        creativeStatement: item.creativeStatement || "none",
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        status: result.status,
        message: result.message || "",
        id: result.id ?? null,
        publishAt: result.publishAt ?? null,
        scheduled: result.scheduled === true,
      });
      if (item.platform.includes("视频号")) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
    }
  } finally {
    if (cleanupDownload) {
      cleanupDownload();
      cleanupDownload = null;
    }
  }

  const succeeded = results.filter((item) => item.success).length;
  const failed = results.length - succeeded;
  const success = failed === 0 && succeeded === results.length;

  return {
    success,
    exitCode: success ? 0 : 3,
    status: success ? "completed" : succeeded > 0 ? "partial" : "failed",
    message: `平台发布完成：成功 ${succeeded}，失败 ${failed}`,
    total: results.length,
    succeeded,
    failed,
    results,
  };
}
