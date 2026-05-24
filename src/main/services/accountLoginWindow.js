import { BrowserWindow } from 'electron';

export async function openAccountLoginWindow(args) {
  const partition = args && args.partition;
  const url = args && args.url;
  const useragent = args && args.useragent;
  const title = args && args.title;

  if (!partition || !url) {
    return { ok: false, message: 'partition/url 必填' };
  }

  let existingWin = null;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    if (!win._mmAccountLoginPartition) continue;
    if (win._mmAccountLoginPartition === partition) {
      existingWin = win;
    } else {
      try {
        win.close();
      } catch (_) {
        /* ignore */
      }
    }
  }

  if (existingWin) {
    try {
      if (existingWin.isMinimized()) existingWin.restore();
      existingWin.focus();
    } catch (_) {
      /* ignore */
    }
    return { ok: true, reused: true };
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
  win._mmAccountLoginPartition = partition;

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

  try {
    await win.loadURL(url);
  } catch (error) {
    console.warn('[open-account-login-window] loadURL failed:', error && error.message);
  }

  return { ok: true };
}
