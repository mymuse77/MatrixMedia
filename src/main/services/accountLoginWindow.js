import { BrowserWindow } from 'electron';
import {
  closeOtherAccountLoginWindows,
  getAccountLoginWindowByPartition,
  registerAccountLoginWindow,
} from './accountLoginWindowManager';
import { guardExternalNavigation } from './navigationGuard';

const openingWindows = new Map();
const blockedAccountLoginPartitions = new Map();
const ACCOUNT_LOGIN_PARTITION_BLOCK_TTL_MS = 60_000;
const LOGIN_PAGE_LOAD_ATTEMPTS = 2;
const LOGIN_PAGE_RETRY_DELAY_MS = 500;
const LOGIN_PAGE_ABORT_RECOVERY_TIMEOUT_MS = 3_000;
const LOGIN_PAGE_ABORT_RECOVERY_POLL_MS = 100;

function getLoginPageLoadErrorCode(error) {
  const directCode = Number(error?.errno ?? error?.code);
  if (Number.isInteger(directCode)) return directCode;

  const matchedCode = String(error?.message || error || '').match(/\((-?\d+)\)/);
  return matchedCode ? Number(matchedCode[1]) : null;
}

function isAbortedLoginPageNavigation(error) {
  return (
    getLoginPageLoadErrorCode(error) === -3 ||
    /ERR_ABORTED/.test(String(error?.message || error || ''))
  );
}

function getCurrentLoginPageUrl(win) {
  if (!win || win.isDestroyed()) return '';
  try {
    return String(win.webContents?.getURL?.() || '').trim();
  } catch (_) {
    return '';
  }
}

function isUsableLoginPageUrl(value) {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      Boolean(parsed.hostname)
    );
  } catch (_) {
    return false;
  }
}

async function waitForAbortedLoginPageNavigation(win) {
  const deadline = Date.now() + LOGIN_PAGE_ABORT_RECOVERY_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    if (!win || win.isDestroyed()) return '';
    const currentUrl = getCurrentLoginPageUrl(win);
    if (isUsableLoginPageUrl(currentUrl)) return currentUrl;
    await new Promise((resolve) =>
      setTimeout(resolve, LOGIN_PAGE_ABORT_RECOVERY_POLL_MS),
    );
  }
  return '';
}

function isRetryableLoginPageLoadError(error) {
  const message = String(error?.message || error || '');
  return /ERR_(?:FAILED|CONNECTION_(?:RESET|CLOSED)|NETWORK_CHANGED)/.test(message);
}

export async function openAccountLoginWindow(args) {
  const partition = args && args.partition;
  const accountId = args && args.accountId;
  const url = args && args.url;
  const useragent = args && args.useragent;
  const title = args && args.title;

  if (!partition || !url) {
    return { ok: false, message: 'partition/url 必填' };
  }

  if (isAccountLoginPartitionBlocked(partition, accountId)) {
    return { ok: false, message: '账号登录数据正在清理，请稍后重试' };
  }

  const pending = openingWindows.get(partition);
  if (pending) {
    await pending.catch(() => undefined);
    if (isAccountLoginPartitionBlocked(partition, accountId)) {
      return { ok: false, message: '账号登录数据正在清理，请稍后重试' };
    }
    const existingWin = getAccountLoginWindowByPartition(partition) || findWindowByPartition(partition);
    if (existingWin) {
      focusWindow(existingWin);
      return { ok: true, reused: true };
    }
  }

  const promise = openAccountLoginWindowOnce({ partition, url, useragent, title });
  openingWindows.set(partition, promise);
  try {
    const result = await promise;
    if (isAccountLoginPartitionBlocked(partition, accountId)) {
      return { ok: false, message: '账号登录数据正在清理，请稍后重试' };
    }
    return result;
  } finally {
    if (openingWindows.get(partition) === promise) {
      openingWindows.delete(partition);
    }
  }
}

function findWindowByPartition(partition) {
  let existingWin = null;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    if (!win._mmAccountLoginPartition) continue;
    if (win._mmAccountLoginPartition === partition) {
      existingWin = win;
    }
  }
  return existingWin;
}

function focusWindow(win) {
  if (!win || win.isDestroyed()) return;
  try {
    if (win.isMinimized()) win.restore();
    win.focus();
  } catch (_) {
    /* ignore */
  }
}

async function openAccountLoginWindowOnce({ partition, url, useragent, title }) {
  closeOtherAccountLoginWindows(partition);
  const existingWin = getAccountLoginWindowByPartition(partition) || findWindowByPartition(partition);

  if (existingWin) {
    registerAccountLoginWindow(existingWin, partition);
    focusWindow(existingWin);
    return { ok: true, reused: true };
  }

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    if (!win._mmAccountLoginPartition || win._mmAccountLoginPartition === partition) continue;
    try {
      win.close();
    } catch (_) {
      /* ignore */
    }
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: `${title || '账号登录'} ${partition}`,
    autoHideMenuBar: true,
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: false,
      devTools: true,
    },
  });
  registerAccountLoginWindow(win, partition);

  if (useragent) {
    try {
      win.webContents.setUserAgent(useragent);
    } catch (_) {
      /* ignore */
    }
  }

  try {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  } catch (_) {
    /* ignore */
  }
  guardExternalNavigation(win.webContents);

  for (let attempt = 1; attempt <= LOGIN_PAGE_LOAD_ATTEMPTS; attempt += 1) {
    try {
      await win.loadURL(url);
      return { ok: true };
    } catch (error) {
      const message = (error && error.message) || '账号登录页加载失败';
      const navigationAborted = isAbortedLoginPageNavigation(error);
      if (navigationAborted && !win.isDestroyed()) {
        const currentUrl = await waitForAbortedLoginPageNavigation(win);
        if (currentUrl) {
          console.log(
            '[open-account-login-window] loadURL 导航中断后页面已恢复:',
            JSON.stringify({ requestedUrl: url, currentUrl, attempt }),
          );
          focusWindow(win);
          return { ok: true };
        }
      }
      const canRetry =
        attempt < LOGIN_PAGE_LOAD_ATTEMPTS &&
        !win.isDestroyed() &&
        (navigationAborted || isRetryableLoginPageLoadError(error));
      if (canRetry) {
        console.warn(
          `[open-account-login-window] loadURL 暂时失败，准备重试 ${attempt}/${LOGIN_PAGE_LOAD_ATTEMPTS - 1}:`,
          message,
        );
        await new Promise((resolve) => setTimeout(resolve, LOGIN_PAGE_RETRY_DELAY_MS));
        continue;
      }

      console.warn(
        '[open-account-login-window] loadURL failed:',
        JSON.stringify({
          message,
          code: getLoginPageLoadErrorCode(error),
          requestedUrl: url,
          currentUrl: getCurrentLoginPageUrl(win),
          destroyed: win.isDestroyed(),
          attempt,
        }),
      );
      if (!win.isDestroyed()) {
        try {
          win.close();
        } catch (_) {
          /* ignore */
        }
      }
      return { ok: false, message };
    }
  }

  return { ok: false, message: '账号登录页加载失败' };
}

export function blockAccountLoginPartition(partition, accountId) {
  if (partition) {
    blockedAccountLoginPartitions.set(partition, {
      accountId: String(accountId || '*'),
      expiresAt: Date.now() + ACCOUNT_LOGIN_PARTITION_BLOCK_TTL_MS,
    });
  }
}

export function unblockAccountLoginPartition(partition, accountId) {
  if (!partition) return;
  const blocked = blockedAccountLoginPartitions.get(partition);
  if (!blocked) return;
  if (!accountId || blocked.accountId === String(accountId)) {
    blockedAccountLoginPartitions.delete(partition);
  }
}

export function isAccountLoginPartitionBlocked(partition, accountId) {
  const blocked = blockedAccountLoginPartitions.get(partition);
  if (!blocked) return false;
  if (blocked.expiresAt <= Date.now()) {
    blockedAccountLoginPartitions.delete(partition);
    return false;
  }

  const nextAccountId = String(accountId || '');
  if (nextAccountId && blocked.accountId !== '*' && blocked.accountId !== nextAccountId) {
    blockedAccountLoginPartitions.delete(partition);
    return false;
  }
  return true;
}
