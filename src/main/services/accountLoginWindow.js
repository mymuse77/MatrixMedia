import { BrowserWindow } from 'electron';
import {
  closeOtherAccountLoginWindows,
  getAccountLoginWindowByPartition,
  registerAccountLoginWindow,
} from './accountLoginWindowManager';

const openingWindows = new Map();

export async function openAccountLoginWindow(args) {
  const partition = args && args.partition;
  const url = args && args.url;
  const useragent = args && args.useragent;
  const title = args && args.title;

  if (!partition || !url) {
    return { ok: false, message: 'partition/url 必填' };
  }

  const pending = openingWindows.get(partition);
  if (pending) {
    await pending.catch(() => undefined);
    const existingWin = getAccountLoginWindowByPartition(partition) || findWindowByPartition(partition);
    if (existingWin) {
      focusWindow(existingWin);
      return { ok: true, reused: true };
    }
  }

  const promise = openAccountLoginWindowOnce({ partition, url, useragent, title });
  openingWindows.set(partition, promise);
  try {
    return await promise;
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

  win.loadURL(url).catch((error) => {
    console.warn('[open-account-login-window] loadURL failed:', error && error.message);
  });

  return { ok: true };
}
