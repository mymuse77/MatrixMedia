/**
 * WebSocket 任务处理器
 * 处理来自 Web 端的各种业务请求
 */

import { changeData } from '../server/utils';
import {
  runPuppeteerTask,
  runPuppeteerPreflight,
  createIpcTransport,
} from './puppeteerFile';
import ptConfig from '../config/ptConfig';
import path from 'path';
import fs from 'fs';
import { app, BrowserWindow } from 'electron';
import { getAccountLoginStatus, getAccountPartition } from './accountLoginStatus';
import { openAccountLoginWindow, unblockAccountLoginPartition } from './accountLoginWindow';
import { purgeAccountSession } from './accountSessionCleanup';
import { isRemotePublishFile, resolvePublishFile } from './resolvePublishFile';
import { getAppSettings } from './appSettings';
import { notifyPublishSuccess } from './publishNotification';
import { cancelScheduledPublishRecords, createScheduledRecord, schedulePublishRecord, subscribeScheduledPublishEvents } from './scheduledPublish';
import { resolveTaskTransportStatus } from './taskResultStatus';
import {
  PLATFORM_SCHEDULE_MODE,
  validatePlatformScheduledAt,
} from '../../shared/platformSchedule.js';
import {
  PUBLISH_ATTEMPT_TIMEOUT_MS,
  PUBLISH_ATTEMPT_LIMIT,
  PUBLISH_DOWNLOAD_TIMEOUT_MS,
  PUBLISH_TASK_TIMEOUT_MS,
  resolvePublishTimeoutMs,
} from './upLoad/uploadTimeouts.js';

const LOGIN_STATUS_WATCH_INTERVAL_MS = 3_000;
const LOGIN_STATUS_WATCH_TIMEOUT_MS = 10 * 60 * 1_000;
const PUBLISH_MAX_ATTEMPTS = PUBLISH_ATTEMPT_LIMIT;
const PUBLISH_RETRY_DELAYS_MS = [1_000];
const activeLoginStatusWatches = new Map();

function stopAccountLoginStatusWatches(partition) {
  const partitionPrefix = `${cleanText(partition)}|`;
  for (const [key, watch] of activeLoginStatusWatches.entries()) {
    if (!key.startsWith(partitionPrefix)) continue;
    watch.stop();
  }
}

/**
 * 获取账号数据目录
 */
function getAccountDataDir() {
  const documents = app.getPath('documents');
  return path.join(documents, 'MatrixMedia', 'data', 'account');
}

/**
 * 归一化媒体平台管理账号数据
 */
function normalizeAccountList(value, date) {
  if (Array.isArray(value)) {
    return value
      .filter(item => item && typeof item === 'object')
      .map(item => ({
        ...item,
        date: item.date || date,
      }));
  }

  if (value && typeof value === 'object' && (value.phone || value.pt || value.platform)) {
    return [{
      ...value,
      date: value.date || date,
    }];
  }

  return [];
}

function flattenAccountData(data) {
  if (Array.isArray(data)) {
    return normalizeAccountList(data);
  }

  if (!data || typeof data !== 'object') {
    return [];
  }

  return Object.entries(data).flatMap(([date, value]) => normalizeAccountList(value, date));
}

function getPushDataDir() {
  const documents = app.getPath('documents');
  return path.join(documents, 'MatrixMedia', 'data', 'pushData');
}

function getAllPushDataRecords() {
  const folderPath = getPushDataDir();
  if (!fs.existsSync(folderPath)) return [];

  return fs
    .readdirSync(folderPath)
    .filter(fileName => fileName.endsWith('.json'))
    .flatMap((fileName) => {
      try {
        const filePath = path.join(folderPath, fileName);
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(content);
        return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') : [];
      } catch (error) {
        console.error(`[WebSocket] 读取发布历史失败: ${fileName}`, error);
        return [];
      }
    });
}

function normalizePublishSnapshotStatus(record) {
  const rawStatus = cleanText(record?.publishStatus).toLowerCase();
  if (rawStatus === 'success') return 'success';
  if (rawStatus === 'expired') return 'expired';
  if (rawStatus === 'failed' || rawStatus === 'skipped' || rawStatus === 'interrupted') {
    return 'failed';
  }
  if (rawStatus === 'publishing' || rawStatus === 'scheduled') return 'running';
  if (Number(record?.publishSuccessCount) > 0) return 'success';
  if (Number(record?.publishFailCount) > 0) return 'failed';
  return 'pending';
}

function summarizePublishSnapshotStatus(results) {
  const successCount = results.filter(item => item.status === 'success').length;
  const failCount = results.filter(item => item.status === 'failed').length;
  const expiredCount = results.filter(item => item.status === 'expired').length;
  const runningCount = results.filter(item => item.status === 'running').length;
  const pendingCount = results.filter(item => item.status === 'pending').length;
  const total = results.length;

  const status =
    expiredCount > 0 && successCount === 0 && failCount === 0 ? 'expired'
      : runningCount > 0 ? 'running'
      : failCount > 0 && successCount > 0 ? 'partial'
        : failCount > 0 && successCount === 0 && pendingCount === 0 ? 'failed'
          : total > 0 && successCount >= total ? 'completed'
            : pendingCount > 0 ? 'running'
              : successCount > 0 ? 'partial'
      : 'running';

  return {
    total,
    successCount,
    failCount,
    expiredCount,
    runningCount,
    pendingCount,
    status,
  };
}

/**
 * 读取媒体平台管理账号数据
 */
function getAllAccounts() {
  const result = changeData({
    type: 'get',
    fileName: 'account',
    item: {
      pageSize: 9999,
    },
  });

  if (result && result.success) {
    return flattenAccountData(result.data);
  }

  return [];
}

function formatDateKey(value) {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getAccountIdentityKey(account) {
  return [cleanText(account?.id), cleanText(account?.phone), getAccountPlatformValue(account)].join('|');
}

function replaceAccountsFromSnapshot(snapshotAccounts) {
  const accountDir = getAccountDataDir();
  fs.mkdirSync(accountDir, { recursive: true });

  const existingAccounts = getAllAccounts();

  for (const filePath of getAccountFiles()) {
    fs.unlinkSync(filePath);
  }

  const existingByIdentity = new Map(existingAccounts.map((account) => [getAccountIdentityKey(account), account]));
  const existingByPhonePlatform = new Map(
    existingAccounts.map((account) => [[cleanText(account.phone), getAccountPlatformValue(account)].join('|'), account]),
  );

  const groupedAccounts = new Map();
  const now = Date.now();

  snapshotAccounts.forEach((account, index) => {
    const phone = cleanText(account?.phone);
    const platform = getAccountPlatformValue(account);
    if (!phone || !platform || !ptConfig[platform]) return;

    const existingRecord =
      existingByIdentity.get(getAccountIdentityKey(account)) ??
      existingByPhonePlatform.get([phone, platform].join('|'));

    const createTime =
      Number(account?.createTime) ||
      Date.parse(cleanText(account?.createdAt)) ||
      Number(existingRecord?.createTime) ||
      now + index;
    const dateKey = cleanText(account?.date) || formatDateKey(createTime);

    const nextRecord = {
      ...existingRecord,
      id: cleanText(account?.id) || cleanText(existingRecord?.id) || `sync-${createTime}-${index}`,
      phone,
      pt: platform,
      url: cleanText(account?.url) || cleanText(existingRecord?.url) || ptConfig[platform].index,
      group: cleanText(account?.group),
      createTime,
    };

    const currentGroup = groupedAccounts.get(dateKey) || [];
    groupedAccounts.set(dateKey, [...currentGroup, nextRecord]);
  });

  for (const [dateKey, accounts] of groupedAccounts.entries()) {
    const filePath = path.join(accountDir, `${dateKey}.json`);
    writeAccountFile(filePath, accounts);
  }

  return Array.from(groupedAccounts.values()).reduce((total, accounts) => total + accounts.length, 0);
}

async function getFormattedAccounts(platform) {
  let accounts = getAllAccounts();

  if (platform) {
    accounts = accounts.filter(acc => getAccountPlatformValue(acc) === platform);
  }

  return Promise.all(accounts.map(async acc => {
    const accountPlatform = getAccountPlatformValue(acc);
    const loginStatus = await getAccountLoginStatus({
      phone: acc.phone,
      platform: accountPlatform,
      url: acc.url || ptConfig[accountPlatform]?.index,
      partition: getAccountPartition(acc.phone, accountPlatform),
    });

    return {
      id: acc.id,
      phone: acc.phone,
      platform: accountPlatform,
      pt: accountPlatform,
      partition: loginStatus.partition,
      group: acc.group || '',
      url: acc.url || ptConfig[accountPlatform]?.index,
      date: acc.date,
      createTime: acc.createTime,
      ...loginStatus,
    };
  }));
}

export async function sendAccountSnapshot(wsClient, reason = 'snapshot') {
  if (!wsClient || typeof wsClient.sendStatus !== 'function') {
    return;
  }

  try {
    const accounts = await getFormattedAccounts();
    wsClient.sendStatus({
      action: 'accounts_snapshot',
      reason,
      accounts,
      total: accounts.length,
    });
  } catch (error) {
    console.error('[WebSocket] 推送账号快照失败:', error);
    wsClient.sendStatus({
      action: 'accounts_snapshot',
      reason,
      accounts: [],
      total: 0,
      error: error && error.message ? error.message : String(error),
    });
  }
}

function watchAccountLoginStatus({ wsClient, accountId, phone, platform, partition, url }) {
  const key = `${partition}|${phone}|${platform}`;
  activeLoginStatusWatches.get(key)?.stop();

  let stopped = false;
  let checking = false;
  let interval = null;
  let timeout = null;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (interval) clearInterval(interval);
    if (timeout) clearTimeout(timeout);
    activeLoginStatusWatches.delete(key);
  };
  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      const status = await getAccountLoginStatus({ phone, platform, partition, url });
      if (stopped) return;
      if (!status.isLoggedIn) return;
      stop();
      wsClient.sendStatus({
        action: 'account_login_status',
        account: {
          id: accountId,
          phone,
          platform,
          pt: platform,
          partition,
          url,
          ...status,
        },
      });
    } catch (error) {
      console.warn('[WebSocket] 检查账号登录状态失败:', error && error.message ? error.message : error);
    } finally {
      checking = false;
    }
  };

  interval = setInterval(() => void check(), LOGIN_STATUS_WATCH_INTERVAL_MS);
  timeout = setTimeout(stop, LOGIN_STATUS_WATCH_TIMEOUT_MS);
  activeLoginStatusWatches.set(key, { stop });
  void check();
}

function readAccountFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const accounts = JSON.parse(content);
    return Array.isArray(accounts) ? accounts : [];
  } catch (error) {
    console.error(`[WebSocket] 读取账号文件失败: ${path.basename(filePath)}`, error);
    return [];
  }
}

function writeAccountFile(filePath, accounts) {
  fs.writeFileSync(filePath, JSON.stringify(accounts, null, 2), 'utf-8');
}

function getAccountFiles() {
  const accountDir = getAccountDataDir();
  if (!fs.existsSync(accountDir)) return [];
  return fs
    .readdirSync(accountDir)
    .filter(fileName => fileName.endsWith('.json'))
    .map(fileName => path.join(accountDir, fileName));
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
    await sendAccountSnapshot(wsClient, 'add');

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

    const formattedAccounts = await getFormattedAccounts(platform);

    wsClient.sendProgress(taskId, 100, '查询完成');
    wsClient.sendStatus({
      action: 'accounts_snapshot',
      reason: 'get_accounts',
      accounts: formattedAccounts,
      total: formattedAccounts.length,
    });

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
 * 4. 更新媒体账号分组
 */
export async function handleUpdateAccountGroup(taskData, wsClient) {
  const { taskId, data = {} } = taskData;
  const targetGroup = cleanText(data.group);
  const targetAccounts = asList(data.accounts);

  if (!targetAccounts.length) {
    throw new Error('没有要更新分组的账号');
  }

  wsClient.sendProgress(taskId, 40, '正在更新账号分组');

  const matchers = targetAccounts.map(account => ({
    id: cleanText(account.id),
    phone: cleanText(account.phone),
    platform: getAccountPlatformValue(account),
  }));

  const updatedAccounts = [];
  let changed = 0;

  for (const filePath of getAccountFiles()) {
    const accounts = readAccountFile(filePath);
    let fileChanged = false;
    const nextAccounts = accounts.map(account => {
      const accountPlatform = getAccountPlatformValue(account);
      const matched = matchers.some(matcher => {
        if (matcher.id && cleanText(account.id) === matcher.id) return true;
        return matcher.phone && matcher.platform && cleanText(account.phone) === matcher.phone && accountPlatform === matcher.platform;
      });

      if (!matched) return account;

      fileChanged = true;
      changed += 1;
      const nextAccount = {
        ...account,
        group: targetGroup,
      };
      updatedAccounts.push({
        ...nextAccount,
        platform: accountPlatform,
        partition: getAccountPartition(nextAccount.phone, accountPlatform),
      });
      return nextAccount;
    });

    if (fileChanged) {
      writeAccountFile(filePath, nextAccounts);
    }
  }

    notifyAccountChanged({
      reason: 'group',
      taskId,
      group: targetGroup,
      count: changed,
    });
  await sendAccountSnapshot(wsClient, 'group');

  wsClient.sendProgress(taskId, 100, '账号分组已更新');

  return {
    success: true,
    action: 'update_account_group',
    group: targetGroup,
    updatedAccounts,
    message: changed > 0 ? '账号分组已更新' : '未找到匹配账号',
  };
}

export async function handleSyncAccountsSnapshot(taskData, wsClient) {
  const { taskId, data = {} } = taskData;
  const snapshotAccounts = asList(data.accounts);

  wsClient.sendProgress(taskId, 20, '正在同步账号快照');

  const count = replaceAccountsFromSnapshot(snapshotAccounts);

  notifyAccountChanged({
    reason: 'sync',
    taskId,
    count,
  });
  await sendAccountSnapshot(wsClient, 'sync');

  wsClient.sendProgress(taskId, 100, '账号快照已同步');

  return {
    success: true,
    action: 'sync_accounts_snapshot',
    total: count,
    message: `已同步 ${count} 个账号`,
  };
}

/**
 * 5. 打开账号登录/管理窗口
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
      accountId: account?.id || id,
      partition: data.partition || getAccountPartition(targetPhone, targetPlatform),
      url: data.url || account?.url || ptConfig[targetPlatform].index,
      useragent: ptConfig[targetPlatform].useragent,
      title: `${targetPhone} ${targetPlatform}`,
    });

    if (!result || result.ok === false) {
      throw new Error(result?.message || '打开账号窗口失败');
    }

    const partition = data.partition || getAccountPartition(targetPhone, targetPlatform);
    const url = data.url || account?.url || ptConfig[targetPlatform].index;
    watchAccountLoginStatus({
      wsClient,
      accountId: account?.id || id,
      phone: targetPhone,
      platform: targetPlatform,
      partition,
      url,
    });

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
        partition,
        url,
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

export async function handlePurgeAccountSessions(taskData, wsClient) {
  const { taskId, data = {} } = taskData;
  const accounts = asList(data.accounts);
  if (accounts.length === 0) {
    throw new Error('没有要清理登录数据的账号');
  }

  wsClient.sendProgress(taskId, 10, '正在停止账号登录监控');
  const results = [];

  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    const partition = cleanText(account?.partition);
    if (!partition) {
      results.push({
        id: cleanText(account?.id),
        phone: cleanText(account?.phone),
        platform: getAccountPlatformValue(account),
        success: false,
        error: '缺少账号会话 partition',
      });
      continue;
    }

    stopAccountLoginStatusWatches(partition);
    try {
      results.push(await purgeAccountSession({
        id: account?.id,
        phone: account?.phone,
        platform: getAccountPlatformValue(account),
        partition,
      }));
    } catch (error) {
      results.push({
        id: cleanText(account?.id),
        phone: cleanText(account?.phone),
        platform: getAccountPlatformValue(account),
        partition,
        success: false,
        error: error && error.message ? error.message : String(error),
      });
    }

    const progress = 10 + Math.round(((index + 1) / accounts.length) * 90);
    wsClient.sendProgress(taskId, progress, `已清理 ${index + 1}/${accounts.length} 个账号`);
  }

  const failedResults = results.filter(result => !result.success);
  if (failedResults.length > 0) {
    for (const result of results.filter(item => item.success)) {
      unblockAccountLoginPartition(result.partition, result.id);
    }
    const failedNames = failedResults
      .map(result => result.phone || result.id || result.partition || '未命名账号')
      .join('、');
    throw new Error(`以下账号登录数据清理失败：${failedNames}。账号记录未删除，请重试`);
  }

  return {
    success: true,
    action: 'purge_account_sessions',
    results,
    message: `已彻底清理 ${results.length} 个账号的 Cookie、缓存和登录监控`,
  };
}

export async function handleReleaseAccountSessionPurge(taskData, wsClient) {
  const { taskId, data = {} } = taskData;
  const accounts = asList(data.accounts);
  for (const account of accounts) {
    const partition = cleanText(account?.partition);
    if (!partition) continue;
    unblockAccountLoginPartition(partition, account?.id);
  }

  wsClient.sendProgress(taskId, 100, '已解除账号登录清理保护');
  return {
    success: true,
    action: 'release_account_session_purge',
    message: '账号未删除，已解除登录清理保护',
  };
}

function sendPublishLoginExpiredStatus(wsClient, { phone, platform, partition, url }) {
  if (!wsClient || typeof wsClient.sendStatus !== 'function') return;

  const checkedAt = Date.now();
  wsClient.sendStatus({
    action: 'account_login_status',
    reason: 'publish_login_expired',
    account: {
      phone,
      platform,
      pt: platform,
      partition: partition || getAccountPartition(phone, platform),
      url: url || ptConfig[platform]?.index,
      isLoggedIn: false,
      loginStatus: 'expired',
      loginStatusText: '登录失效',
      loginExpiresAtMs: null,
      checkedAt,
    },
  });
}

function getVideoPathValue(video) {
  return cleanText(video?.videoPath) || cleanText(video?.filePath) || cleanText(video?.path) || cleanText(video?.sourceFilePath);
}

function getVideoUrlValue(video) {
  return cleanText(video?.videoUrl) || cleanText(video?.url) || cleanText(video?.downloadUrl) || cleanText(video?.download?.url);
}

function getConfiguredServerOrigin() {
  try {
    const serverUrl = String(getAppSettings()?.webSocketServerUrl || '').trim();
    return serverUrl ? new URL(serverUrl).origin : '';
  } catch (_) {
    return '';
  }
}

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}

function normalizeRemoteDownloadUrl(rawUrl) {
  const value = cleanText(rawUrl);
  if (!value) {
    return '';
  }

  const serverOrigin = getConfiguredServerOrigin();
  if (!serverOrigin) {
    return value;
  }

  try {
    if (/^https?:\/\//i.test(value)) {
      const parsed = new URL(value);
      const serviceOrigin = new URL(serverOrigin);
      if (isLoopbackHostname(parsed.hostname) && !isLoopbackHostname(serviceOrigin.hostname)) {
        return new URL(parsed.pathname + parsed.search + parsed.hash, serviceOrigin).toString();
      }
      return parsed.toString();
    }

    return new URL(value, serverOrigin).toString();
  } catch (_) {
    return value;
  }
}

function normalizeRequestHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return null;
  }

  const normalized = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = cleanText(rawKey);
    if (!key) continue;

    const value = Array.isArray(rawValue)
      ? rawValue.map(item => cleanText(item)).filter(Boolean).join(', ')
      : cleanText(rawValue);

    if (value) {
      normalized[key] = value;
    }
  }

  return Object.keys(normalized).length ? normalized : null;
}

function createDownloadRequest(videoUrl, download, downloadHeaders, downloadExpiresAt) {
  const normalizedDownload = isPlainObject(download) ? download : null;
  const url = normalizeRemoteDownloadUrl(normalizedDownload?.url || videoUrl);
  if (!url) {
    return null;
  }

  const headers = normalizeRequestHeaders(normalizedDownload?.headers || downloadHeaders);
  const expiresAt = cleanText(normalizedDownload?.expiresAt || downloadExpiresAt);
  const request = { url };

  if (headers) {
    request.headers = headers;
  }

  if (expiresAt) {
    request.expiresAt = expiresAt;
  }

  for (const key of ['jobId', 'outputIndex', 'matrixTaskId', 'clientId']) {
    const value = normalizedDownload?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      request[key] = value;
    }
  }

  return request;
}

function getRemoteVideoCacheKey({
  itemId,
  video,
  downloadRequest,
  localPublishRecord,
}) {
  const jobId = cleanText(downloadRequest?.jobId || video?.jobId);
  const outputIndexValue = downloadRequest?.outputIndex ?? video?.outputIndex;
  const outputIndex = Number(outputIndexValue);
  if (jobId && Number.isInteger(outputIndex) && outputIndex >= 0) {
    return `${jobId}-${outputIndex}`;
  }

  const directId =
    cleanText(video?.matrixItemId) ||
    cleanText(video?.videoId) ||
    cleanText(video?.id) ||
    cleanText(video?._id) ||
    cleanText(localPublishRecord?.matrixSourceVideoId) ||
    cleanText(localPublishRecord?.matrixVideoId) ||
    cleanText(itemId) ||
    cleanText(video?.itemId) ||
    cleanText(localPublishRecord?.matrixItemId);
  if (directId) return directId;

  return '';
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
  itemId,
  phone,
  platform,
  partition,
  videoPath,
  sourceVideoPath,
  sourceVideoUrl,
  title,
  taskName,
  description,
  tags,
  coverPath,
  location,
  show,
  idempotencyKey,
  executionToken,
  publishTimeoutMs,
}) {
  const localRecordName = cleanText(taskName) || title || path.basename(videoPath);
  const shortTitle = description || (platform === '视频号' ? title : '');
  const showAutomationProcess =
    typeof show === 'boolean'
      ? show
      : Boolean(getAppSettings()?.showAutomationProcess);

  return {
    id: createLocalPublishRecordId(),
    taskId,
    bookName: localRecordName,
    textType: 'local',
    data: {
      textOtherName: localRecordName,
      bt1: title || '',
      ...(shortTitle ? { bt2: shortTitle } : {}),
      bq: tags || '',
      bdText: '',
      // dy.js 读 data.address；保留 location 别名便于排查
      address: location || '',
      location: location || '',
    },
    textOtherName: localRecordName,
    selectedFile: path.basename(videoPath),
    bt: title || '',
    ...(shortTitle ? { bt2: shortTitle } : {}),
    bq: tags || '',
    filePath: videoPath,
    url: ptConfig[platform]?.upload,
    show: showAutomationProcess,
    mmCliSuppressWindow: !showAutomationProcess,
    closeWindowAfterPublish: true,
    useragent: ptConfig[platform]?.useragent,
    partition: partition || getAccountPartition(phone, platform),
    pt: platform,
    phone,
    matrixItemId: cleanText(itemId),
    idempotencyKey: cleanText(idempotencyKey),
    executionToken: cleanText(executionToken),
    publishTimeoutMs,
    matrixSourceVideoPath: cleanText(sourceVideoPath || videoPath),
    matrixSourceVideoUrl: cleanText(sourceVideoUrl),
    date: formatDateKey(new Date()),
    coverPath: coverPath || '',
    publishStatus: 'publishing',
    lastPublishMessage: '等待发布结果',
    lastPublishAt: Date.now(),
  };
}

function normalizeLocalPublishData(localPublishRecord, overrides = {}) {
  const next = {
    ...(isPlainObject(localPublishRecord) ? localPublishRecord : {}),
    ...overrides,
  };
  const nextVideoPath = cleanText(next.filePath || overrides.videoPath);

  if (nextVideoPath) {
    next.filePath = nextVideoPath;
    next.selectedFile = path.basename(nextVideoPath);
  }

  if (!next.textOtherName) {
    next.textOtherName = cleanText(next.bookName || next.taskName || next.bt);
  }

  if (overrides.itemId || next.matrixItemId) {
    next.matrixItemId = cleanText(overrides.itemId || next.matrixItemId);
  }

  if (overrides.sourceVideoPath || next.matrixSourceVideoPath) {
    next.matrixSourceVideoPath = cleanText(overrides.sourceVideoPath || next.matrixSourceVideoPath);
  }

  if (overrides.sourceVideoUrl || next.matrixSourceVideoUrl) {
    next.matrixSourceVideoUrl = cleanText(overrides.sourceVideoUrl || next.matrixSourceVideoUrl);
  }

  return next;
}

function waitForPublishRetry(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function sendBatchPublishItemResult(wsClient, taskId, payload) {
  if (!wsClient || typeof wsClient.sendTaskResult !== 'function') {
    return;
  }

  const doneCount = payload.successCount + payload.failCount;
  const isDone = doneCount >= payload.total;
  // 最终结果统一由 websocketClient 在 handler 返回后发送，避免同一任务
  // 先在最后一项完成时发送一次、随后又被外层发送第二次。
  if (isDone) return;

  const result = {
    success: true,
    action: 'publish_videos',
    status: 'running',
    taskName: payload.taskName,
    total: payload.total,
    successCount: payload.successCount,
    failCount: payload.failCount,
    executionToken: payload.detail.executionToken || '',
    results: [payload.detail],
    message: `批量发布中：已完成 ${doneCount}/${payload.total}`,
  };
  wsClient.sendTaskResult(
    taskId,
    resolveTaskTransportStatus('publish_videos', result),
    result,
  );
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
  const captionLines = captionText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const firstCaptionLine = captionLines[0] || '';
  const fallbackTitle = getFallbackVideoTitle(video, videoPath, taskName);
  const title = firstCaptionLine || fallbackTitle || 'video';
  const tags = [
    ...normalizeTagList(taskTags),
    ...normalizeTagList(caption?.tags),
  ];

  return {
    title,
    // bt1 已填写首行标题，bt2 只保留后续正文，避免抖音等平台重复显示首行。
    description: captionLines.slice(1).join('\n'),
    tags: formatPublishTags(tags, platform),
  };
}

function formatScheduledPublishAt(value) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function isFutureScheduledPublishAt(value, nowMs = Date.now()) {
  const publishAt = Number(value);
  return Number.isFinite(publishAt) && publishAt > nowMs + 1_000;
}

async function prepareScheduledVideoFile(queued) {
  const rawVideoPath = cleanText(queued?.videoPath);
  const rawVideoUrl = cleanText(queued?.videoUrl) || (isRemotePublishFile(rawVideoPath) ? rawVideoPath : '');
  const downloadRequest = createDownloadRequest(
    rawVideoUrl,
    queued?.download,
    queued?.downloadHeaders,
    queued?.downloadExpiresAt,
  );
  const remoteUrl = cleanText(downloadRequest?.url || rawVideoUrl);

  if (remoteUrl) {
    const cachedVideo = await resolvePublishFile(remoteUrl, {
      headers: downloadRequest?.headers,
      cacheKey: queued?.itemId || queued?.serverId,
    });
    if (!cachedVideo?.localPath || !fs.existsSync(cachedVideo.localPath)) {
      throw new Error('视频预下载完成但本地缓存不存在');
    }
    return {
      localPath: cachedVideo.localPath,
      remoteUrl,
      downloadHeaders: downloadRequest?.headers || null,
      downloadExpiresAt: downloadRequest?.expiresAt || null,
    };
  }

  if (rawVideoPath && fs.existsSync(rawVideoPath)) {
    return {
      localPath: rawVideoPath,
      remoteUrl: '',
      downloadHeaders: null,
      downloadExpiresAt: null,
    };
  }

  throw new Error('定时发布视频无法预下载：未找到本地文件或远程视频地址');
}

async function deferMixedImmediatePublishItems(publishQueue, taskId, nowMs = Date.now()) {
  const immediateQueue = [];
  const scheduledResults = [];

  for (const queued of publishQueue) {
    if (!isFutureScheduledPublishAt(queued.scheduledPublishAt, nowMs)) {
      immediateQueue.push(queued);
      continue;
    }

    const scheduledPublishAt = formatScheduledPublishAt(queued.scheduledPublishAt);
    if (!scheduledPublishAt) {
      immediateQueue.push(queued);
      continue;
    }

    const preparedVideo = await prepareScheduledVideoFile(queued);

    const scheduledRecord = createScheduledRecord({
      ...queued.publishData,
      matrixTaskId: taskId,
      matrixItemId: queued.itemId,
      filePath: preparedVideo.localPath,
      selectedFile: path.basename(preparedVideo.localPath),
      matrixSourceVideoPath: queued.videoPath || queued.videoUrl || '',
      matrixSourceVideoUrl: preparedVideo.remoteUrl,
      sourceVideoUrl: preparedVideo.remoteUrl,
      downloadHeaders: preparedVideo.downloadHeaders,
      downloadExpiresAt: preparedVideo.downloadExpiresAt,
    }, scheduledPublishAt, Date.now());

    await changeData({ type: 'add', fileName: 'pushData', item: scheduledRecord });
    schedulePublishRecord(scheduledRecord);
    scheduledResults.push({
      itemId: queued.itemId,
      idempotencyKey: queued.idempotencyKey,
      executionToken: queued.executionToken,
      phone: queued.phone,
      platform: queued.platform,
      videoPath: queued.videoPath,
      videoUrl: queued.videoUrl,
      status: 'scheduled',
      scheduledPublishAt: queued.scheduledPublishAt,
    });
  }

  return { immediateQueue, scheduledResults };
}

export async function handlePublishVideo(taskData, wsClient) {
  const { taskId, data } = taskData;
  const {
    phone,
    platform,
    itemId,
    serverId,
    partition,
    videoUrl,
    videoPath,
    download,
    downloadTimeoutMs,
    downloadHeaders,
    downloadExpiresAt,
    title,
    taskName,
    description,
    tags,
    coverPath,
    location,
    progressRange,
    localPublishRecord,
    idempotencyKey,
    executionToken,
    publishTimeoutMs,
    scheduleMode,
    scheduledPublishAt,
    platformScheduleMode,
    platformScheduledPublishAt,
  } = data;
  let cleanupDownloadedVideo = null;

  try {
    sendScopedProgress(wsClient, taskId, 5, '准备发布任务', progressRange);

    // 验证必填字段
    if (!phone || !platform) {
      throw new Error('缺少必填字段: phone, platform');
    }

    if (!ptConfig[platform]) {
      throw new Error(`不支持的平台: ${platform}`);
    }

    const requestedScheduleMode = cleanText(scheduleMode) || cleanText(platformScheduleMode);
    const requestedPlatformAt =
      scheduledPublishAt != null ? scheduledPublishAt : platformScheduledPublishAt;
    if (requestedScheduleMode === PLATFORM_SCHEDULE_MODE) {
      if (platform !== '抖音') {
        throw new Error('平台定时当前仅支持抖音');
      }
      const scheduleValidation = validatePlatformScheduledAt(requestedPlatformAt);
      if (!scheduleValidation.ok) throw new Error(scheduleValidation.error);
    }

    if (platform === '抖音' && data.skipPublishPreflight !== true) {
      sendScopedProgress(wsClient, taskId, 8, '正在检查抖音发布页', progressRange);
      try {
        await runPuppeteerPreflight({
          taskId: `${taskId}:dy-preflight`,
          phone,
          pt: platform,
          partition: partition || getAccountPartition(phone, platform),
          url: ptConfig[platform]?.upload,
          useragent: ptConfig[platform]?.useragent,
        });
      } catch (error) {
        const diagnostic =
          error?.preflightPayload?.diagnostic?.screenshotPath ||
          error?.preflightPayload?.diagnostic?.metadataPath ||
          '';
        const diagnosticHint = diagnostic ? `，诊断文件：${diagnostic}` : '';
        const preflightError = new Error(
          `抖音账号 ${phone} 发布页预检失败：${error?.message || '页面未就绪'}${diagnosticHint}`,
        );
        preflightError.nonRetryable = error?.preflightPayload?.nonRetryable === true;
        preflightError.publishPayload = error?.preflightPayload || null;
        throw preflightError;
      }
    }

    const downloadRequest = createDownloadRequest(videoUrl, download, downloadHeaders, downloadExpiresAt);
    const resolvedVideoUrl = cleanText(downloadRequest?.url || videoUrl);
    const persistedSourceVideoUrl = downloadRequest?.headers ? '' : resolvedVideoUrl;

    if (!resolvedVideoUrl && !videoPath) {
      throw new Error('必须提供 videoUrl 或 videoPath');
    }

    // 如果是 URL，需要先下载
    let localVideoPath = videoPath;
    if (resolvedVideoUrl && !videoPath) {
      sendScopedProgress(wsClient, taskId, 10, '正在下载视频', progressRange);
      const resolved = await resolvePublishFile(resolvedVideoUrl, {
        headers: downloadRequest?.headers,
        downloadTimeoutMs,
        cacheKey: getRemoteVideoCacheKey({
          itemId: cleanText(serverId) || itemId,
          downloadRequest,
          localPublishRecord,
        }),
      });
      localVideoPath = resolved.localPath;
      cleanupDownloadedVideo = resolved.cleanup;
    }

    // 本地路径失效但仍有可下载地址时，回退到下载模式，兼容 web 端重发场景。
    if (!fs.existsSync(localVideoPath)) {
      if (resolvedVideoUrl) {
        sendScopedProgress(wsClient, taskId, 10, '正在下载视频', progressRange);
        const resolved = await resolvePublishFile(resolvedVideoUrl, {
          headers: downloadRequest?.headers,
          downloadTimeoutMs,
          cacheKey: getRemoteVideoCacheKey({
            itemId: cleanText(serverId) || itemId,
            downloadRequest,
            localPublishRecord,
          }),
        });
        localVideoPath = resolved.localPath;
        cleanupDownloadedVideo = resolved.cleanup;
      } else {
        throw new Error(`视频文件不存在: ${localVideoPath}`);
      }
    }

    sendScopedProgress(wsClient, taskId, 20, '正在准备发布数据', progressRange);

    const existingBt2 = cleanText(localPublishRecord?.bt2);
    const normalizedBt2 = description ||
      (platform === '视频号' ? title : existingBt2 && existingBt2 !== title ? existingBt2 : '') ||
      '';
    const publishOverrides = {
      taskId,
      itemId,
      idempotencyKey,
      executionToken,
      publishTimeoutMs,
      phone,
      pt: platform,
      partition,
      filePath: localVideoPath,
      sourceVideoPath: videoPath,
      sourceVideoUrl: persistedSourceVideoUrl,
      url: ptConfig[platform]?.upload,
      bt: title || localPublishRecord?.bt || '',
      bq: tags || localPublishRecord?.bq || '',
      coverPath: coverPath || localPublishRecord?.coverPath || '',
      ...(normalizedBt2 ? { bt2: normalizedBt2 } : {}),
    };
    const publishData = isPlainObject(localPublishRecord)
      ? normalizeLocalPublishData(localPublishRecord, publishOverrides)
      : createLocalPublishData({
        taskId,
        itemId,
        phone,
        platform,
        partition,
        videoPath: localVideoPath,
        sourceVideoPath: videoPath,
        sourceVideoUrl: persistedSourceVideoUrl,
        title,
        taskName,
        description,
        tags,
        coverPath,
        location,
        show: data.show,
        idempotencyKey,
        executionToken,
        publishTimeoutMs,
      });

    // 请求里的 location 必须落到 dy.js 读取的 data.address（含带 localPublishRecord 的重发）
    const resolvedLocation = cleanText(location) || cleanText(publishData?.data?.address) || cleanText(publishData?.data?.location);
    if (resolvedLocation) {
      publishData.data = {
        ...(isPlainObject(publishData.data) ? publishData.data : {}),
        address: resolvedLocation,
        location: resolvedLocation,
      };
    }

    if (requestedScheduleMode === PLATFORM_SCHEDULE_MODE) {
      publishData.platformScheduleMode = PLATFORM_SCHEDULE_MODE;
      publishData.platformScheduledPublishAt = Number(requestedPlatformAt);
      publishData.platformScheduledPublishAtText = formatScheduledPublishAt(requestedPlatformAt);
    }

    // 显式 show 优先；未显式传入时沿用 appSettings 里的默认值。
    if (typeof data?.show === 'boolean') {
      publishData.show = data.show;
      publishData.mmCliSuppressWindow = !data.show;
      publishData.closeWindowAfterPublish = data.show
        ? data.closeWindowAfterPublish === false
          ? false
          : publishData.closeWindowAfterPublish === false
            ? false
            : true
        : true;
    }
    if (data && data.closeWindowAfterPublish === false) {
      publishData.closeWindowAfterPublish = false;
    }

    if (isPlainObject(localPublishRecord) && publishData.id && publishData.date) {
      await changeData({
        type: 'update',
        fileName: 'pushData',
        item: {
          id: publishData.id,
          date: publishData.date,
          matrixItemId: publishData.matrixItemId || cleanText(itemId),
          filePath: publishData.filePath || '',
          selectedFile: publishData.selectedFile || '',
          partition: publishData.partition || partition || '',
          pt: publishData.pt || platform,
          phone: publishData.phone || phone,
          matrixSourceVideoPath: publishData.matrixSourceVideoPath || videoPath || '',
          matrixSourceVideoUrl: publishData.matrixSourceVideoUrl || persistedSourceVideoUrl || '',
          bt: publishData.bt || title || '',
          ...(publishData.bt2 ? { bt2: publishData.bt2 } : {}),
          bq: publishData.bq || tags || '',
          lastPublishMessage: '等待发布结果',
          lastPublishAt: Date.now(),
        },
      });
    }

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
      const cleanupOnce = () => {
        if (cleanupDownloadedVideo) {
          cleanupDownloadedVideo();
          cleanupDownloadedVideo = null;
        }
      };
      const resolveOnce = async (result, message) => {
        if (settled) return;
        settled = true;
        await updateLocalPublishRecord(publishData, 'success', message || '视频发布成功');
        notifyPublishSuccess({
          phone,
          platform,
          videoName: localVideoPath || videoPath || videoUrl || title,
        });
        cleanupOnce();
        resolve(result);
      };
      const rejectOnce = async (error, payload) => {
        if (settled) return;
        settled = true;
        if (error && payload) {
          error.publishPayload = payload;
          error.nonRetryable = payload.nonRetryable === true;
        }
        const status = payload?.skipped ? 'skipped' : 'failed';
        await updateLocalPublishRecord(publishData, status, error?.message || '发布失败');
        cleanupOnce();
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
              // reply 只表示平台流程已提交，最终成功必须由 puppeteerFile-done
              // 回执确认，避免页面跳转或上传完成被误报成已发布。
              sendScopedProgress(wsClient, taskId, 90, '已提交，等待平台最终确认', progressRange);
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
            sendPublishLoginExpiredStatus(wsClient, {
              phone,
              platform,
              partition: publishData?.partition || partition,
            });
            void rejectOnce(
              new Error(payload?.message || '登录状态异常或未登录'),
              { ...payload, nonRetryable: true },
            );
          }
        },
      };

      runPuppeteerTask(publishData, transport, () => {
        console.log('[WebSocket] 发布任务完成');
      });
    });
  } catch (error) {
    if (cleanupDownloadedVideo) {
      cleanupDownloadedVideo();
    }
    console.error('[WebSocket] 发布视频失败:', error);
    throw error;
  }
}

async function preflightDouyinBatchAccounts({
  publishQueue,
  taskId,
  wsClient,
}) {
  const uniqueAccounts = new Map();
  for (const queued of publishQueue) {
    if (queued.platform !== '抖音') continue;
    const key = `${queued.partition}|${queued.phone}`;
    if (!uniqueAccounts.has(key)) uniqueAccounts.set(key, queued);
  }

  const targets = [...uniqueAccounts.values()];
  if (targets.length < 2) {
    return { failures: [], passedAccountKeys: [] };
  }

  console.log(`[WebSocket] 开始抖音批量发布页预检，共 ${targets.length} 个账号`);
  const failures = [];
  const passedAccountKeys = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    wsClient.sendProgress(
      taskId,
      Number((1 + ((index + 1) / targets.length) * 4).toFixed(2)),
      `正在预检抖音账号 ${index + 1}/${targets.length}: ${target.phone}`,
    );

    try {
      await runPuppeteerPreflight({
        taskId: `${taskId}:dy-preflight:${index + 1}`,
        phone: target.phone,
        pt: target.platform,
        partition: target.partition,
        url: ptConfig[target.platform]?.upload,
        useragent: ptConfig[target.platform]?.useragent,
      });
      passedAccountKeys.push(`${target.partition}|${target.phone}`);
    } catch (error) {
      const diagnostic = error?.preflightPayload?.diagnostic || null;
      const diagnosticPath =
        diagnostic?.screenshotPath || diagnostic?.metadataPath || '';
      const diagnosticHint = diagnosticPath ? `，诊断文件：${diagnosticPath}` : '';
      const message =
        `抖音账号 ${target.phone} 发布页预检失败：${error?.message || '页面未就绪'}${diagnosticHint}`;
      if (error?.preflightPayload?.nonRetryable === true) {
        failures.push({
          key: `${target.partition}|${target.phone}`,
          phone: target.phone,
          platform: target.platform,
          message,
          diagnostic,
          nonRetryable: true,
        });
      }
      console.warn(`[WebSocket] ${message}`);
    }
  }
  const retryableFailureCount =
    targets.length - passedAccountKeys.length - failures.length;
  if (failures.length || retryableFailureCount) {
    console.warn(
      `[WebSocket] 抖音批量发布页预检完成：通过 ${passedAccountKeys.length}，需单项重试 ${retryableFailureCount}，不可发布 ${failures.length}`,
    );
  } else {
    console.log('[WebSocket] 抖音批量发布页预检全部通过');
  }
  return { failures, passedAccountKeys };
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
  const videos = asList(data.videos).filter(video => getVideoPathValue(video) || getVideoUrlValue(video));
  const captions = asList(data.captions);
  const accounts = asList(data.accounts);
  const publishAccounts = accounts.filter(account => {
    const platform = getAccountPlatformValue(account);
    return platform && (!platforms.size || platforms.has(platform));
  });
  const publishItemIds = asList(data.publishItemIds).map(item => cleanText(item));
  const plannedPublishItems = asList(data.publishItems);
  const hasOneToOneAssignments = publishItemIds.length === publishAccounts.length && videos.length >= publishAccounts.length;
  const publishPairs = plannedPublishItems.length
    ? plannedPublishItems.map((item) => ({
      account: {
        id: item.accountId,
        phone: item.phone,
        platform: item.platform,
      },
      video: {
        id: item.videoId,
        videoPath: item.videoPath,
        videoUrl: item.videoUrl,
        download: item.download,
        downloadHeaders: item.downloadHeaders,
        downloadExpiresAt: item.downloadExpiresAt,
        projectName: item.videoTitle,
      },
      plannedItem: item,
    }))
    : hasOneToOneAssignments
    ? publishAccounts.map((account, index) => ({ account, video: videos[index] }))
    : publishAccounts.flatMap(account => videos.map(video => ({ account, video })));
  const total = publishPairs.length;

  if (data.replaceExisting === true && cleanText(data.matrixTaskId)) {
    await cancelScheduledPublishRecords(data.matrixTaskId);
  }

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

  for (const { account, video, plannedItem } of publishPairs) {
    const phone = cleanText(account.phone);
    const platform = getAccountPlatformValue(account);
    const partition = cleanText(account.partition) || getAccountPartition(phone, platform);

    const videoPath = getVideoPathValue(video);
    const videoUrl = getVideoUrlValue(video);
    const download = createDownloadRequest(videoUrl, video?.download, video?.downloadHeaders, video?.downloadExpiresAt);
    const caption = plannedItem?.captionText ? { textContent: plannedItem.captionText } : pickCaption(captions, detailIndex, captionMode);
    const publishText = buildPublishText({ caption, video, videoPath, taskName, taskTags, platform });
    const currentIndex = detailIndex + 1;
    const progressStart = (detailIndex / total) * 100;
    const progressEnd = (currentIndex / total) * 100;
    const publishData = createLocalPublishData({
      taskId,
      itemId: cleanText(plannedItem?.itemId) || publishItemIds[detailIndex] || '',
      idempotencyKey: cleanText(plannedItem?.idempotencyKey),
      executionToken: cleanText(data.executionToken),
      publishTimeoutMs: data.publishTimeoutMs,
      phone,
      platform,
      partition,
      videoPath,
      title: publishText.title,
      taskName,
      description: publishText.description,
      tags: publishText.tags,
      location: cleanText(plannedItem?.location),
    });

    publishQueue.push({
      itemId: cleanText(plannedItem?.itemId) || publishItemIds[detailIndex] || '',
      idempotencyKey: cleanText(plannedItem?.idempotencyKey),
      executionToken: cleanText(data.executionToken),
      serverId: getRemoteVideoCacheKey({
        itemId: publishItemIds[detailIndex] || '',
        video,
        downloadRequest: download,
      }),
      phone,
      platform,
      partition,
      videoPath,
      videoUrl,
      download,
      publishText,
      publishData,
      currentIndex,
      progressStart,
      progressEnd,
      scheduledPublishAt:
        Number(plannedItem?.scheduledPublishAt ?? data.scheduledPublishAt) || 0,
    });

    detailIndex += 1;
  }

  if (cleanText(data.scheduleMode) === PLATFORM_SCHEDULE_MODE) {
    for (const queued of publishQueue) {
      if (queued.platform !== '抖音') {
        throw new Error('平台定时当前仅支持抖音');
      }
      const scheduleValidation = validatePlatformScheduledAt(queued.scheduledPublishAt);
      if (!scheduleValidation.ok) throw new Error(scheduleValidation.error);
      queued.publishData.platformScheduleMode = PLATFORM_SCHEDULE_MODE;
      queued.publishData.platformScheduledPublishAt = queued.scheduledPublishAt;
      queued.publishData.platformScheduledPublishAtText = formatScheduledPublishAt(queued.scheduledPublishAt);
    }
  }

  if (cleanText(data.scheduleMode) === 'scheduled') {
    const scheduledResults = [];
    try {
      for (const queued of publishQueue) {
        const publishAt = formatScheduledPublishAt(queued.scheduledPublishAt);
        if (!publishAt) {
          throw new Error('定时发布任务缺少有效发布时间');
        }
        const preparedVideo = await prepareScheduledVideoFile(queued);
        const scheduledRecord = createScheduledRecord({
          ...queued.publishData,
          matrixTaskId: taskId,
          matrixItemId: queued.itemId,
          filePath: preparedVideo.localPath,
          selectedFile: path.basename(preparedVideo.localPath),
          matrixSourceVideoPath: queued.videoPath || queued.videoUrl || '',
          matrixSourceVideoUrl: preparedVideo.remoteUrl,
          sourceVideoUrl: preparedVideo.remoteUrl,
          downloadHeaders: preparedVideo.downloadHeaders,
          downloadExpiresAt: preparedVideo.downloadExpiresAt,
        }, publishAt);
        await changeData({ type: 'add', fileName: 'pushData', item: scheduledRecord });
        schedulePublishRecord(scheduledRecord);
        scheduledResults.push({
          itemId: queued.itemId,
          idempotencyKey: queued.idempotencyKey,
          executionToken: queued.executionToken,
          phone: queued.phone,
          platform: queued.platform,
          videoPath: queued.videoPath,
          videoUrl: queued.videoUrl,
          status: 'scheduled',
          scheduledPublishAt: queued.scheduledPublishAt,
        });
      }
    } catch (error) {
      await cancelScheduledPublishRecords(taskId).catch((cleanupError) => {
        console.warn('[WebSocket] 清理失败的定时发布计划失败:', cleanupError?.message || cleanupError);
      });
      throw error;
    }
    wsClient.sendProgress(taskId, 100, `已写入 ${scheduledResults.length} 条定时发布计划`);
    return {
      success: true,
      action: 'publish_videos',
      status: 'scheduled',
      total,
      successCount: 0,
      failCount: 0,
      executionToken: cleanText(data.executionToken),
      results: scheduledResults,
      message: `已写入 ${scheduledResults.length} 条定时发布计划`,
    };
  }

  const isMixedImmediatePublish =
    cleanText(data.scheduleMode) === 'immediate' && data.scheduleMixDistribution === true;
  let mixedImmediateSchedule;
  try {
    mixedImmediateSchedule = isMixedImmediatePublish
      ? await deferMixedImmediatePublishItems(publishQueue, taskId)
      : { immediateQueue: publishQueue, scheduledResults: [] };
  } catch (error) {
    await cancelScheduledPublishRecords(taskId).catch((cleanupError) => {
      console.warn('[WebSocket] 清理失败的分散发布计划失败:', cleanupError?.message || cleanupError);
    });
    throw error;
  }
  const immediatePublishQueue = mixedImmediateSchedule.immediateQueue;
  const scheduledResults = mixedImmediateSchedule.scheduledResults;

  const douyinBatchPreflight = await preflightDouyinBatchAccounts({
    publishQueue: immediatePublishQueue,
    taskId,
    wsClient,
  });
  const douyinPreflightFailures = new Map(
    douyinBatchPreflight.failures.map((failure) => [failure.key, failure]),
  );
  const douyinPreflightPassedAccounts = new Set(
    douyinBatchPreflight.passedAccountKeys,
  );

  try {
    for (const queued of immediatePublishQueue) {
      await changeData({
        type: 'add',
        fileName: 'pushData',
        item: queued.publishData,
      });
    }
  } catch (error) {
    if (scheduledResults.length > 0) {
      await cancelScheduledPublishRecords(taskId).catch((cleanupError) => {
        console.warn('[WebSocket] 清理本地记录失败后的分散发布计划失败:', cleanupError?.message || cleanupError);
      });
    }
    throw error;
  }

  for (const queued of immediatePublishQueue) {
    const {
      phone,
      platform,
      itemId,
      serverId,
      partition,
      videoPath,
      videoUrl,
      download,
      publishText,
      publishData,
      idempotencyKey,
      executionToken,
      currentIndex,
      progressStart,
      progressEnd,
    } = queued;
    let attemptCount = 0;
    const preflightFailure = douyinPreflightFailures.get(`${partition}|${phone}`);

    if (preflightFailure) {
      failCount += 1;
      await updateLocalPublishRecord(
        publishData,
        'failed',
        preflightFailure.message,
      );
      const detail = {
        success: false,
        itemId,
        phone,
        platform,
        videoPath,
        videoUrl,
        idempotencyKey,
        executionToken,
        attemptCount: 0,
        error: preflightFailure.message,
        nonRetryable: preflightFailure.nonRetryable,
        ...(preflightFailure.diagnostic
          ? { diagnostic: preflightFailure.diagnostic }
          : {}),
      };
      results.push(detail);
      sendBatchPublishItemResult(wsClient, taskId, {
        taskName,
        total,
        successCount,
        failCount,
        detail,
        results,
      });
      wsClient.sendProgress(
        taskId,
        Number(progressEnd.toFixed(2)),
        `跳过登录失效账号 ${currentIndex}/${total}: ${phone}`,
      );
      continue;
    }

    const itemTimeoutMs = resolvePublishTimeoutMs(
      data.publishTimeoutMs,
      PUBLISH_TASK_TIMEOUT_MS,
    );
    const itemDeadline = Date.now() + itemTimeoutMs;

    try {
      wsClient.sendProgress(taskId, Number(progressStart.toFixed(2)), `正在发布 ${currentIndex}/${total}`);

      let result;
      let lastError;
      for (let attempt = 1; attempt <= PUBLISH_MAX_ATTEMPTS; attempt += 1) {
        attemptCount = attempt;
        try {
          const remainingMs = itemDeadline - Date.now();
          if (remainingMs <= 0) {
            const timeoutError = new Error(
              `单账号发布总超时（${Math.round(itemTimeoutMs / 60000)} 分钟）`,
            );
            timeoutError.nonRetryable = true;
            throw timeoutError;
          }
          const attemptTimeoutMs = Math.min(
            remainingMs,
            PUBLISH_ATTEMPT_TIMEOUT_MS,
          );
          const downloadTimeoutMs = Math.min(
            remainingMs,
            PUBLISH_DOWNLOAD_TIMEOUT_MS,
          );
          result = await handlePublishVideo({
            taskId,
            type: 'publish_video',
            data: {
              phone,
              platform,
              itemId,
              idempotencyKey,
              executionToken,
              serverId,
              partition,
              videoUrl,
              videoPath,
              download,
              downloadTimeoutMs,
              taskName,
              title: publishText.title,
              description: publishText.description,
              tags: publishText.tags,
              publishTimeoutMs: attemptTimeoutMs,
              localPublishRecord: publishData,
              scheduleMode: cleanText(data.scheduleMode),
              scheduledPublishAt:
                cleanText(data.scheduleMode) === PLATFORM_SCHEDULE_MODE
                  ? queued.scheduledPublishAt
                  : undefined,
              progressRange: {
                start: progressStart,
                end: progressEnd,
              },
              skipPublishPreflight:
                platform === '抖音' &&
                douyinPreflightPassedAccounts.has(`${partition}|${phone}`),
            },
          }, wsClient);
          break;
        } catch (error) {
          lastError = error;
          if (
            error?.nonRetryable === true ||
            error?.publishPayload?.nonRetryable === true
          ) {
            break;
          }
          if (attempt < PUBLISH_MAX_ATTEMPTS) {
            wsClient.sendProgress(taskId, Number(progressStart.toFixed(2)), `发布失败，${PUBLISH_RETRY_DELAYS_MS[attempt - 1] / 1000} 秒后自动重试（${attempt}/${PUBLISH_MAX_ATTEMPTS - 1}）`);
            await waitForPublishRetry(PUBLISH_RETRY_DELAYS_MS[attempt - 1]);
          }
        }
      }
      if (!result) {
        lastError.attemptCount = attemptCount;
        throw lastError;
      }

      successCount += 1;
      const detail = {
        success: true,
        itemId,
        phone,
        platform,
        videoPath,
        videoUrl,
        idempotencyKey,
        executionToken,
        attemptCount,
        result,
      };
      results.push(detail);
      sendBatchPublishItemResult(wsClient, taskId, {
        taskName,
        total,
        successCount,
        failCount,
        detail,
        results,
      });
    } catch (error) {
      failCount += 1;
      const message = error?.message || '发布失败';
      const diagnostic = error?.publishPayload?.diagnostic || null;
      const nonRetryable =
        error?.nonRetryable === true ||
        error?.publishPayload?.nonRetryable === true;
      const detail = {
        success: false,
        itemId,
        phone,
        platform,
        videoPath,
        videoUrl,
        idempotencyKey,
        executionToken,
        attemptCount,
        error: message,
        nonRetryable,
        ...(diagnostic ? { diagnostic } : {}),
      };
      results.push(detail);
      sendBatchPublishItemResult(wsClient, taskId, {
        taskName,
        total,
        successCount,
        failCount,
        detail,
        results,
      });
      wsClient.sendProgress(taskId, Number(progressEnd.toFixed(2)), `发布失败 ${currentIndex}/${total}: ${message}`);
    }
  }

  if (scheduledResults.length > 0) {
    wsClient.sendProgress(
      taskId,
      100,
      immediatePublishQueue.length > 0
        ? `已完成即时发布，并安排 ${scheduledResults.length} 条分散发布计划`
        : `已安排 ${scheduledResults.length} 条分散发布计划`,
    );
    return {
      success: true,
      action: 'publish_videos',
      status: 'running',
      taskName,
      total,
      successCount,
      failCount,
      executionToken: cleanText(data.executionToken),
      results: [...results, ...scheduledResults],
      message: `已安排 ${scheduledResults.length} 条分散发布计划`,
    };
  }

  wsClient.sendProgress(taskId, 100, `批量发布完成：成功 ${successCount}，失败 ${failCount}`);

  return {
    success: successCount === total,
    action: 'publish_videos',
    status: successCount === total ? 'completed' : successCount > 0 ? 'partial' : 'failed',
    taskName,
    total,
    successCount,
    failCount,
    executionToken: cleanText(data.executionToken),
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
 * 6. 查询单个发布任务状态
 */
export async function handleGetPublishTaskStatus(taskData, wsClient) {
  const { taskId, data = {} } = taskData;
  const matrixTaskId = cleanText(data.matrixTaskId || data.taskId);

  try {
    wsClient.sendProgress(taskId, 30, '正在读取发布状态');

    if (!matrixTaskId) {
      throw new Error('缺少 matrixTaskId');
    }

    const results = getAllPushDataRecords()
      .filter((record) => cleanText(record.taskId) === matrixTaskId)
      .map((record) => {
        const status = normalizePublishSnapshotStatus(record);
        return {
          id: cleanText(record.id),
          itemId: cleanText(record.matrixItemId),
          phone: cleanText(record.phone),
          platform: cleanText(record.pt || record.platform),
          partition: cleanText(record.partition),
          videoPath: cleanText(record.matrixSourceVideoPath || record.filePath),
          videoUrl: cleanText(record.matrixSourceVideoUrl || record.videoUrl),
          status,
          success: status === 'success',
          error: status === 'failed' ? cleanText(record.lastPublishMessage) || '发布失败' : '',
          message: cleanText(record.lastPublishMessage),
          executionToken: cleanText(record.executionToken),
          lastPublishAt: Number(record.lastPublishAt) || 0,
          date: cleanText(record.date),
        };
      })
      .sort((left, right) => (right.lastPublishAt || 0) - (left.lastPublishAt || 0));

    const summary = summarizePublishSnapshotStatus(results);
    const executionTokens = [...new Set(results.map((item) => cleanText(item.executionToken)).filter(Boolean))];

    wsClient.sendProgress(taskId, 100, `已同步 ${summary.total} 条发布状态`);

    return {
      success: true,
      action: 'get_publish_task_status',
      matrixTaskId,
      status: summary.status,
      total: summary.total,
      successCount: summary.successCount,
      failCount: summary.failCount,
      runningCount: summary.runningCount,
      pendingCount: summary.pendingCount,
      executionToken: executionTokens.length === 1 ? executionTokens[0] : '',
      results,
      message: `已同步 ${summary.total} 条发布状态`,
    };
  } catch (error) {
    console.error('[WebSocket] 获取发布任务状态失败:', error);
    throw error;
  }
}

export async function handleCancelPublishSchedule(taskData, wsClient) {
  const { taskId, data = {} } = taskData;
  const matrixTaskId = cleanText(data.matrixTaskId);
  if (!matrixTaskId) {
    throw new Error('缺少 matrixTaskId');
  }

  wsClient.sendProgress(taskId, 50, '正在取消本地定时发布计划');
  const canceledCount = await cancelScheduledPublishRecords(matrixTaskId);
  wsClient.sendProgress(taskId, 100, `已取消 ${canceledCount} 条本地定时发布计划`);
  return {
    success: true,
    action: 'cancel_publish_schedule',
    matrixTaskId,
    canceledCount,
    message: `已取消 ${canceledCount} 条本地定时发布计划`,
  };
}

/**
 * 7. 获取客户端状态
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
  subscribeScheduledPublishEvents((record) => {
    const matrixTaskId = cleanText(record?.matrixTaskId);
    const itemId = cleanText(record?.matrixItemId);
    if (!matrixTaskId || !itemId) return;

    if (record.publishStatus === 'publishing') {
      wsClient.sendProgress(matrixTaskId, 0, `定时发布开始：${record.phone || ''} ${record.pt || ''}`.trim());
      return;
    }

    if (record.publishStatus === 'success' || record.publishStatus === 'failed' || record.publishStatus === 'skipped' || record.publishStatus === 'expired') {
      const success = record.publishStatus === 'success';
      wsClient.sendTaskResult(matrixTaskId, 'success', {
        action: 'publish_videos',
        status: 'running',
        executionToken: cleanText(record.executionToken),
        results: [{
          itemId,
          idempotencyKey: cleanText(record.idempotencyKey),
          executionToken: cleanText(record.executionToken),
          phone: record.phone,
          platform: record.pt,
          videoPath: record.filePath,
          success,
          status: success ? 'success' : record.publishStatus,
          error: success ? '' : record.lastPublishMessage || (record.publishStatus === 'expired' ? '错过发布时间' : '发布失败'),
        }],
      });
    }
  });

  wsClient.registerTaskHandler('sync_accounts_snapshot', (taskData) =>
    handleSyncAccountsSnapshot(taskData, wsClient)
  );

  wsClient.registerTaskHandler('purge_account_sessions', (taskData) =>
    handlePurgeAccountSessions(taskData, wsClient)
  );

  wsClient.registerTaskHandler('release_account_session_purge', (taskData) =>
    handleReleaseAccountSessionPurge(taskData, wsClient)
  );

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

  // 4. 更新账号分组
  wsClient.registerTaskHandler('update_account_group', (taskData) =>
    handleUpdateAccountGroup(taskData, wsClient)
  );

  // 5. 打开账号登录/管理窗口
  wsClient.registerTaskHandler('open_account_login', (taskData) =>
    handleOpenAccountLogin(taskData, wsClient)
  );

  // 6. 发布视频任务
  wsClient.registerTaskHandler('publish_video', (taskData) =>
    handlePublishVideo(taskData, wsClient)
  );

  // 7. 批量发布视频任务
  wsClient.registerTaskHandler('publish_videos', (taskData) =>
    handlePublishVideos(taskData, wsClient)
  );

  // 8. 查询发布历史
  wsClient.registerTaskHandler('get_publish_history', (taskData) =>
    handleGetPublishHistory(taskData, wsClient)
  );

  // 9. 查询单个发布任务状态
  wsClient.registerTaskHandler('get_publish_task_status', (taskData) =>
    handleGetPublishTaskStatus(taskData, wsClient)
  );

  wsClient.registerTaskHandler('cancel_publish_schedule', (taskData) =>
    handleCancelPublishSchedule(taskData, wsClient)
  );

  // 11. 获取客户端状态
  wsClient.registerTaskHandler('get_client_status', (taskData) =>
    handleGetClientStatus(taskData, wsClient)
  );

  console.log('[WebSocket] 已注册所有任务处理器');
}
