/**
 * WebSocket 任务处理器
 * 处理来自 Web 端的各种业务请求
 */

import { changeData } from '../server/utils';
import { runPuppeteerTask, createIpcTransport } from './puppeteerFile';
import ptConfig from '../config/ptConfig';
import path from 'path';
import fs from 'fs';
import { app, BrowserWindow } from 'electron';
import { getAccountLoginStatus, getAccountPartition } from './accountLoginStatus';
import { openAccountLoginWindow } from './accountLoginWindow';

/**
 * 获取账号数据目录
 */
function getAccountDataDir() {
  const documents = app.getPath('documents');
  return path.join(documents, 'MatrixMedia', 'data', 'account');
}

/**
 * 读取所有账号数据
 */
function getAllAccounts() {
  const accountDir = getAccountDataDir();
  if (!fs.existsSync(accountDir)) {
    return [];
  }

  const files = fs.readdirSync(accountDir).filter(f => f.endsWith('.json'));
  const allAccounts = [];

  files.forEach(fileName => {
    const filePath = path.join(accountDir, fileName);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const accounts = JSON.parse(content);
      if (Array.isArray(accounts)) {
        allAccounts.push(...accounts);
      }
    } catch (error) {
      console.error(`[WebSocket] 读取账号文件失败: ${fileName}`, error);
    }
  });

  return allAccounts;
}

function notifyAccountChanged(payload) {
  const message = {
    source: 'websocket',
    timestamp: Date.now(),
    ...(payload || {}),
  };

  BrowserWindow.getAllWindows().forEach(win => {
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send('matrix-account-changed', message);
    } catch (error) {
      console.error('[WebSocket] notify account changed failed:', error);
    }
  });
}

/**
 * 检查账号登录状态
 */
async function checkAccountLogin(phone, platform) {
  return getAccountLoginStatus({
    phone,
    platform,
    url: ptConfig[platform]?.index,
    partition: getAccountPartition(phone, platform),
  });
}

/**
 * 1. 新增媒体账号
 */
export async function handleAddAccount(taskData, wsClient) {
  const { taskId, data } = taskData;
  const { phone, platform } = data;

  try {
    wsClient.sendProgress(taskId, 10, '正在创建账号');

    // 验证平台是否支持
    if (!ptConfig[platform]) {
      throw new Error(`不支持的平台: ${platform}`);
    }

    // 创建账号记录
    const accountData = {
      phone,
      pt: platform,
      url: ptConfig[platform].index,
    };

    wsClient.sendProgress(taskId, 50, '正在保存账号信息');

    const result = await changeData({
      type: 'add',
      fileName: 'account',
      item: accountData,
    });

    if (!result.success) {
      throw new Error(result.message || '添加账号失败');
    }

    notifyAccountChanged({
      reason: 'add',
      taskId,
      phone,
      pt: platform,
      platform,
    });

    wsClient.sendProgress(taskId, 100, '账号创建成功');

    return {
      success: true,
      account: {
        phone,
        platform,
        partition: getAccountPartition(phone, platform),
        url: ptConfig[platform].index,
        createTime: Date.now(),
      },
      message: '账号添加成功，请在客户端完成登录',
    };
  } catch (error) {
    console.error('[WebSocket] 添加账号失败:', error);
    throw error;
  }
}

/**
 * 2. 查询账号列表
 */
export async function handleGetAccounts(taskData, wsClient) {
  const { taskId, data = {} } = taskData;
  const { platform } = data;

  try {
    wsClient.sendProgress(taskId, 50, '正在查询账号列表');

    let accounts = getAllAccounts();

    // 按平台筛选
    if (platform) {
      accounts = accounts.filter(acc => acc.pt === platform);
    }

    // 格式化账号数据
    const formattedAccounts = await Promise.all(accounts.map(async acc => {
      const loginStatus = await getAccountLoginStatus({
        phone: acc.phone,
        platform: acc.pt,
        url: acc.url || ptConfig[acc.pt]?.index,
        partition: getAccountPartition(acc.phone, acc.pt),
      });

      return {
        id: acc.id,
        phone: acc.phone,
        platform: acc.pt,
        partition: loginStatus.partition,
        url: acc.url,
        createTime: acc.createTime,
        ...loginStatus,
      };
    }));

    wsClient.sendProgress(taskId, 100, '查询完成');

    return {
      success: true,
      accounts: formattedAccounts,
      total: formattedAccounts.length,
    };
  } catch (error) {
    console.error('[WebSocket] 查询账号列表失败:', error);
    throw error;
  }
}

/**
 * 3. 删除媒体账号
 */
export async function handleDeleteAccount(taskData, wsClient) {
  const { taskId, data } = taskData;
  const { id, phone, platform, date } = data;

  try {
    wsClient.sendProgress(taskId, 50, '正在删除账号');

    const result = await changeData({
      type: 'delete',
      fileName: 'account',
      item: { id, phone, pt: platform, date },
    });

    if (!result.success) {
      throw new Error(result.message || '删除账号失败');
    }

    notifyAccountChanged({
      reason: 'delete',
      taskId,
      id,
      phone,
      pt: platform,
      platform,
    });

    wsClient.sendProgress(taskId, 100, '账号删除成功');

    return {
      success: true,
      message: '账号删除成功',
    };
  } catch (error) {
    console.error('[WebSocket] 删除账号失败:', error);
    throw error;
  }
}

/**
 * 4. 打开账号登录/管理窗口
 */
export async function handleOpenAccountLogin(taskData, wsClient) {
  const { taskId, data = {} } = taskData;
  const { id, phone, platform } = data;

  try {
    wsClient.sendProgress(taskId, 30, '正在打开账号窗口');

    const accounts = getAllAccounts();
    const account = accounts.find(acc => {
      if (id && acc.id === id) return true;
      return acc.phone === phone && acc.pt === platform;
    });
    const targetPhone = account?.phone || phone;
    const targetPlatform = account?.pt || platform;

    if (!targetPhone || !targetPlatform) {
      throw new Error('缺少账号 phone/platform');
    }

    if (!ptConfig[targetPlatform]) {
      throw new Error(`不支持的平台: ${targetPlatform}`);
    }

    notifyAccountChanged({
      reason: 'focus',
      taskId,
      phone: targetPhone,
      pt: targetPlatform,
      platform: targetPlatform,
    });

    const result = await openAccountLoginWindow({
      partition: data.partition || getAccountPartition(targetPhone, targetPlatform),
      url: data.url || account?.url || ptConfig[targetPlatform].index,
      useragent: ptConfig[targetPlatform].useragent,
      title: `${targetPhone} ${targetPlatform}`,
    });

    if (!result || result.ok === false) {
      throw new Error(result?.message || '打开账号窗口失败');
    }

    wsClient.sendProgress(taskId, 100, '账号窗口已打开');

    return {
      success: true,
      action: 'open_account_login',
      opened: true,
      reused: Boolean(result.reused),
      account: {
        id: account?.id || id,
        phone: targetPhone,
        platform: targetPlatform,
        partition: data.partition || getAccountPartition(targetPhone, targetPlatform),
        url: data.url || account?.url || ptConfig[targetPlatform].index,
      },
      message: result.reused ? '已切换到账号窗口' : '账号窗口已打开',
    };
  } catch (error) {
    console.error('[WebSocket] 打开账号窗口失败:', error);
    throw error;
  }
}

/**
 * 5. 发布视频任务
 */
function asList(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clampProgress(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.max(0, Math.min(100, numberValue));
}

function sendScopedProgress(wsClient, taskId, progress, message, progressRange) {
  const safeProgress = clampProgress(progress);
  const rangeStart = clampProgress(progressRange?.start ?? 0);
  const rangeEnd = clampProgress(progressRange?.end ?? 100);
  const scopedProgress = rangeStart + ((rangeEnd - rangeStart) * safeProgress) / 100;

  wsClient.sendProgress(taskId, Number(scopedProgress.toFixed(2)), message);
}

function getAccountPlatformValue(account) {
  return cleanText(account?.platform) || cleanText(account?.pt);
}

function getVideoPathValue(video) {
  return cleanText(video?.videoPath) || cleanText(video?.filePath) || cleanText(video?.path);
}

function getCaptionText(caption) {
  return (
    cleanText(caption?.textContent) ||
    cleanText(caption?.content) ||
    cleanText(caption?.description) ||
    cleanText(caption?.name)
  );
}

function pickCaption(captions, index, captionMode) {
  if (!captions.length) return null;
  if (captionMode === 'random') {
    return captions[Math.floor(Math.random() * captions.length)];
  }
  return captions[index % captions.length];
}

function normalizeTagList(value) {
  const rawTags = Array.isArray(value)
    ? value
    : String(value || '')
      .split(/[\s,，、;；|]+/);

  return Array.from(
    new Set(
      rawTags
        .map(tag => String(tag || '').trim())
        .filter(Boolean)
        .map(tag => tag.replace(/^#+/, '')),
    ),
  );
}

function formatPublishTags(tags, platform) {
  const normalizedTags = normalizeTagList(tags);
  const hashtagPlatforms = new Set(['视频号', '抖音', '快手']);

  if (hashtagPlatforms.has(platform)) {
    return normalizedTags.map(tag => `#${tag}`).join(' ');
  }

  return normalizedTags.join(' ');
}

function createLocalPublishRecordId() {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createLocalPublishData({
  taskId,
  phone,
  platform,
  partition,
  videoPath,
  title,
  taskName,
  description,
  tags,
  coverPath,
  location,
}) {
  const localRecordName = cleanText(taskName) || title || path.basename(videoPath);

  return {
    id: createLocalPublishRecordId(),
    taskId,
    bookName: localRecordName,
    textType: 'local',
    data: {
      textOtherName: localRecordName,
      bt1: title || '',
      bt2: description || title || '',
      bq: tags || '',
      bdText: '',
      address: location || '',
    },
    textOtherName: localRecordName,
    selectedFile: path.basename(videoPath),
    bt: title || '',
    bt2: description || title || '',
    bq: tags || '',
    filePath: videoPath,
    url: ptConfig[platform]?.upload,
    show: false,
    mmCliSuppressWindow: true,
    closeWindowAfterPublish: true,
    useragent: ptConfig[platform]?.useragent,
    partition: partition || getAccountPartition(phone, platform),
    pt: platform,
    phone,
    date: new Date().toISOString().split('T')[0],
    coverPath: coverPath || '',
    publishStatus: 'publishing',
    lastPublishMessage: '等待发布结果',
    lastPublishAt: Date.now(),
  };
}

function sendBatchPublishItemResult(wsClient, taskId, payload) {
  if (!wsClient || typeof wsClient.sendTaskResult !== 'function') {
    return;
  }

  const doneCount = payload.successCount + payload.failCount;
  const isDone = doneCount >= payload.total;
  const status = isDone
    ? payload.successCount === payload.total
      ? 'completed'
      : payload.successCount > 0
        ? 'partial'
        : 'failed'
    : 'running';

  wsClient.sendTaskResult(taskId, 'success', {
    success: isDone ? payload.successCount > 0 : true,
    action: 'publish_videos',
    status,
    taskName: payload.taskName,
    total: payload.total,
    successCount: payload.successCount,
    failCount: payload.failCount,
    results: [payload.detail],
    message: isDone
      ? `批量发布完成：成功 ${payload.successCount}，失败 ${payload.failCount}`
      : `批量发布中：已完成 ${doneCount}/${payload.total}`,
  });
}

async function updateLocalPublishRecord(publishData, status, message) {
  if (!publishData?.id || !publishData?.date) return;

  try {
    await changeData({
      type: 'update',
      fileName: 'pushData',
      item: {
        id: publishData.id,
        date: publishData.date,
        publishStatus: status,
        lastPublishMessage: message || '',
        lastPublishAt: Date.now(),
        ...(status === 'success' ? { publishSuccessCount: 1, publishFailCount: 0 } : {}),
        ...(status === 'failed' || status === 'skipped' ? { publishFailCount: 1 } : {}),
      },
    });
  } catch (error) {
    console.error('[WebSocket] 更新本地发布记录失败:', error);
  }
}

function getFallbackVideoTitle(video, videoPath, taskName) {
  return (
    cleanText(video?.projectName) ||
    cleanText(video?.versionName) ||
    cleanText(video?.name) ||
    cleanText(taskName) ||
    cleanText(videoPath ? path.basename(videoPath, path.extname(videoPath)) : '')
  );
}

function buildPublishText({ caption, video, videoPath, taskName, taskTags, platform }) {
  const captionText = getCaptionText(caption);
  const firstCaptionLine = captionText
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);
  const fallbackTitle = getFallbackVideoTitle(video, videoPath, taskName);
  const title = firstCaptionLine || fallbackTitle || 'video';
  const tags = [
    ...normalizeTagList(taskTags),
    ...normalizeTagList(caption?.tags),
  ];

  return {
    title,
    description: captionText || title,
    tags: formatPublishTags(tags, platform),
  };
}

export async function handlePublishVideo(taskData, wsClient) {
  const { taskId, data } = taskData;
  const {
    phone,
    platform,
    partition,
    videoUrl,
    videoPath,
    title,
    taskName,
    description,
    tags,
    coverPath,
    location,
    progressRange,
    localPublishRecord,
  } = data;

  try {
    sendScopedProgress(wsClient, taskId, 5, '准备发布任务', progressRange);

    // 验证必填字段
    if (!phone || !platform) {
      throw new Error('缺少必填字段: phone, platform');
    }

    if (!ptConfig[platform]) {
      throw new Error(`不支持的平台: ${platform}`);
    }

    if (!videoUrl && !videoPath) {
      throw new Error('必须提供 videoUrl 或 videoPath');
    }

    // 如果是 URL，需要先下载
    let localVideoPath = videoPath;
    if (videoUrl && !videoPath) {
      sendScopedProgress(wsClient, taskId, 10, '正在下载视频', progressRange);
      // TODO: 实现视频下载逻辑
      throw new Error('暂不支持从 URL 下载视频，请提供本地路径');
    }

    // 验证视频文件是否存在
    if (!fs.existsSync(localVideoPath)) {
      throw new Error(`视频文件不存在: ${localVideoPath}`);
    }

    sendScopedProgress(wsClient, taskId, 20, '正在准备发布数据', progressRange);

    const publishData = isPlainObject(localPublishRecord)
      ? localPublishRecord
      : createLocalPublishData({
        taskId,
        phone,
        platform,
        partition,
        videoPath: localVideoPath,
        title,
        taskName,
        description,
        tags,
        coverPath,
        location,
      });

    sendScopedProgress(wsClient, taskId, 30, '正在启动发布流程', progressRange);

    if (!localPublishRecord) {
      await changeData({
        type: 'add',
        fileName: 'pushData',
        item: publishData,
      });
    }

    // 执行发布任务
    return new Promise((resolve, reject) => {
      let settled = false;
      const resolveOnce = async (result, message) => {
        if (settled) return;
        settled = true;
        await updateLocalPublishRecord(publishData, 'success', message || '视频发布成功');
        resolve(result);
      };
      const rejectOnce = async (error, payload) => {
        if (settled) return;
        settled = true;
        const status = payload?.skipped ? 'skipped' : 'failed';
        await updateLocalPublishRecord(publishData, status, error?.message || '发布失败');
        reject(error);
      };
      const transport = {
        reply: (channel, payload) => {
          console.log(`[WebSocket] 发布进度 [${channel}]:`, payload);

          if (payload && payload.taskId != null && payload.taskId !== taskId) {
            return;
          }

          if (channel === 'puppeteerFile-reply') {
            const { status, message, progress } = payload || {};

            if (status === 'progress') {
              sendScopedProgress(wsClient, taskId, 30 + (progress || 0) * 0.7, message || '发布中', progressRange);
            } else if (status === 'success') {
              sendScopedProgress(wsClient, taskId, 100, '发布成功', progressRange);
              void resolveOnce({
                success: true,
                message: message || '视频发布成功',
                data: payload,
              }, message || '视频发布成功');
            } else if (status === 'error' || status === 'failed') {
              void rejectOnce(new Error(message || '发布失败'), payload);
            }
          } else if (channel === 'puppeteerFile-done') {
            const { status, message } = payload || {};

            if (status === true) {
              sendScopedProgress(wsClient, taskId, 100, '发布成功', progressRange);
              void resolveOnce({
                success: true,
                message: message || '视频发布成功',
                data: payload,
              }, message || '视频发布成功');
            } else {
              void rejectOnce(new Error(message || '发布失败'), payload);
            }
          } else if (channel === 'puppeteer-noLogin') {
            void rejectOnce(new Error('登录状态异常或未登录'), payload);
          }
        },
      };

      runPuppeteerTask(publishData, transport, () => {
        console.log('[WebSocket] 发布任务完成');
      });
    });
  } catch (error) {
    console.error('[WebSocket] 发布视频失败:', error);
    throw error;
  }
}

/**
 * 6. 批量发布视频任务
 */
export async function handlePublishVideos(taskData, wsClient) {
  const { taskId, data = {} } = taskData;
  const taskName = cleanText(data.taskName);
  const captionMode = cleanText(data.captionMode) || 'random';
  const taskTags = data.tags;
  const platforms = new Set(asList(data.platforms).map(cleanText).filter(Boolean));
  const videos = asList(data.videos).filter(video => getVideoPathValue(video) || cleanText(video?.url));
  const captions = asList(data.captions);
  const accounts = asList(data.accounts);
  const publishAccounts = accounts.filter(account => {
    const platform = getAccountPlatformValue(account);
    return platform && (!platforms.size || platforms.has(platform));
  });
  const total = publishAccounts.length * videos.length;

  if (!publishAccounts.length) {
    throw new Error('没有可发布的账号');
  }

  if (!videos.length) {
    throw new Error('没有可发布的视频');
  }

  wsClient.sendProgress(taskId, 1, `准备批量发布，共 ${total} 条`);

  const results = [];
  let successCount = 0;
  let failCount = 0;
  let detailIndex = 0;
  const publishQueue = [];

  for (const account of publishAccounts) {
    const phone = cleanText(account.phone);
    const platform = getAccountPlatformValue(account);
    const partition = cleanText(account.partition) || getAccountPartition(phone, platform);

    for (const video of videos) {
      const videoPath = getVideoPathValue(video);
      const videoUrl = cleanText(video.url);
      const caption = pickCaption(captions, detailIndex, captionMode);
      const publishText = buildPublishText({ caption, video, videoPath, taskName, taskTags, platform });
      const currentIndex = detailIndex + 1;
      const progressStart = (detailIndex / total) * 100;
      const progressEnd = (currentIndex / total) * 100;
      const publishData = createLocalPublishData({
        taskId,
        phone,
        platform,
        partition,
        videoPath,
        title: publishText.title,
        taskName,
        description: publishText.description,
        tags: publishText.tags,
      });

      publishQueue.push({
        phone,
        platform,
        partition,
        videoPath,
        videoUrl,
        publishText,
        publishData,
        currentIndex,
        progressStart,
        progressEnd,
      });

      detailIndex += 1;
    }
  }

  for (const queued of publishQueue) {
    await changeData({
      type: 'add',
      fileName: 'pushData',
      item: queued.publishData,
    });
  }

  for (const queued of publishQueue) {
    const {
      phone,
      platform,
      partition,
      videoPath,
      videoUrl,
      publishText,
      publishData,
      currentIndex,
      progressStart,
      progressEnd,
    } = queued;

    try {
      wsClient.sendProgress(taskId, Number(progressStart.toFixed(2)), `正在发布 ${currentIndex}/${total}`);

      const result = await handlePublishVideo({
        taskId,
        type: 'publish_video',
        data: {
          phone,
          platform,
          partition,
          videoUrl,
          videoPath,
          taskName,
          title: publishText.title,
          description: publishText.description,
          tags: publishText.tags,
          localPublishRecord: publishData,
          progressRange: {
            start: progressStart,
            end: progressEnd,
          },
        },
      }, wsClient);

      successCount += 1;
      const detail = {
        success: true,
        phone,
        platform,
        videoPath,
        videoUrl,
        result,
      };
      results.push(detail);
      sendBatchPublishItemResult(wsClient, taskId, {
        taskName,
        total,
        successCount,
        failCount,
        detail,
      });
    } catch (error) {
      failCount += 1;
      const message = error?.message || '发布失败';
      const detail = {
        success: false,
        phone,
        platform,
        videoPath,
        videoUrl,
        error: message,
      };
      results.push(detail);
      sendBatchPublishItemResult(wsClient, taskId, {
        taskName,
        total,
        successCount,
        failCount,
        detail,
      });
      wsClient.sendProgress(taskId, Number(progressEnd.toFixed(2)), `发布失败 ${currentIndex}/${total}: ${message}`);
    }
  }

  wsClient.sendProgress(taskId, 100, `批量发布完成：成功 ${successCount}，失败 ${failCount}`);

  return {
    success: successCount > 0,
    action: 'publish_videos',
    status: successCount === total ? 'completed' : successCount > 0 ? 'partial' : 'failed',
    taskName,
    total,
    successCount,
    failCount,
    results,
    message: `批量发布完成：成功 ${successCount}，失败 ${failCount}`,
  };
}

/**
 * 5. 查询发布历史
 */
export async function handleGetPublishHistory(taskData, wsClient) {
  const { taskId, data = {} } = taskData;
  const { page = 1, pageSize = 10, platform, status } = data;

  try {
    wsClient.sendProgress(taskId, 50, '正在查询发布历史');

    const result = await changeData({
      type: 'get',
      fileName: 'pushData',
      item: { page, pageSize },
    });

    if (!result.success) {
      throw new Error(result.message || '查询失败');
    }

    let historyData = result.data || {};

    // 按平台筛选
    if (platform) {
      Object.keys(historyData).forEach(date => {
        historyData[date] = historyData[date].filter(item => item.pt === platform);
      });
    }

    // 按状态筛选
    if (status) {
      Object.keys(historyData).forEach(date => {
        historyData[date] = historyData[date].filter(item => item.publishStatus === status);
      });
    }

    wsClient.sendProgress(taskId, 100, '查询完成');

    return {
      success: true,
      data: historyData,
      totalDays: result.totalDays,
      page: result.page,
      pageSize: result.pageSize,
    };
  } catch (error) {
    console.error('[WebSocket] 查询发布历史失败:', error);
    throw error;
  }
}

/**
 * 6. 获取客户端状态
 */
export async function handleGetClientStatus(taskData, wsClient) {
  const { taskId } = taskData;

  try {
    wsClient.sendProgress(taskId, 50, '正在获取客户端状态');

    const accounts = getAllAccounts();

    const accountStatuses = await Promise.all(accounts.map(acc =>
      getAccountLoginStatus({
        phone: acc.phone,
        platform: acc.pt,
        url: acc.url || ptConfig[acc.pt]?.index,
        partition: getAccountPartition(acc.phone, acc.pt),
      })
    ));
    const loggedInCount = accountStatuses.filter(status => status.isLoggedIn).length;
    const loggedOutCount = accounts.length - loggedInCount;

    // TODO: 获取任务队列状态
    const queueStatus = {
      pending: 0,
      processing: 0,
    };

    wsClient.sendProgress(taskId, 100, '状态获取完成');

    return {
      success: true,
      status: {
        isOnline: true,
        accounts: {
          total: accounts.length,
          loggedIn: loggedInCount,
          loggedOut: loggedOutCount,
        },
        queue: queueStatus,
        lastHeartbeat: Date.now(),
      },
    };
  } catch (error) {
    console.error('[WebSocket] 获取客户端状态失败:', error);
    throw error;
  }
}

/**
 * 注册所有任务处理器
 */
export function registerWebSocketHandlers(wsClient) {
  // 1. 新增媒体账号
  wsClient.registerTaskHandler('add_account', (taskData) =>
    handleAddAccount(taskData, wsClient)
  );

  // 2. 查询账号列表
  wsClient.registerTaskHandler('get_accounts', (taskData) =>
    handleGetAccounts(taskData, wsClient)
  );

  // 3. 删除媒体账号
  wsClient.registerTaskHandler('delete_account', (taskData) =>
    handleDeleteAccount(taskData, wsClient)
  );

  // 4. 打开账号登录/管理窗口
  wsClient.registerTaskHandler('open_account_login', (taskData) =>
    handleOpenAccountLogin(taskData, wsClient)
  );

  // 5. 发布视频任务
  wsClient.registerTaskHandler('publish_video', (taskData) =>
    handlePublishVideo(taskData, wsClient)
  );

  // 6. 批量发布视频任务
  wsClient.registerTaskHandler('publish_videos', (taskData) =>
    handlePublishVideos(taskData, wsClient)
  );

  // 7. 查询发布历史
  wsClient.registerTaskHandler('get_publish_history', (taskData) =>
    handleGetPublishHistory(taskData, wsClient)
  );

  // 8. 获取客户端状态
  wsClient.registerTaskHandler('get_client_status', (taskData) =>
    handleGetClientStatus(taskData, wsClient)
  );

  console.log('[WebSocket] 已注册所有任务处理器');
}
