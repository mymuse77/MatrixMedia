/* eslint-disable no-case-declarations */
import path from 'path'

function safeSend(mainWindow, channel, ...args) {
  try {
    if (
      mainWindow &&
      !mainWindow.isDestroyed() &&
      mainWindow.webContents &&
      !mainWindow.webContents.isDestroyed()
    ) {
      mainWindow.webContents.send(channel, ...args)
    }
  } catch (_) {
    // 窗口已关闭或正在退出时忽略
  }
}

export default {
  download(mainWindow, downloadUrL, options = {}) {
    const { onCompleted, onTerminated, notifyCompleted = true } = options;
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      !mainWindow.webContents ||
      mainWindow.webContents.isDestroyed()
    ) {
      return false
    }
    const downloadSession = mainWindow.webContents.session
    const handleWillDownload = (event, item) => {
      if (item.getURL() && item.getURL() !== downloadUrL) return
      downloadSession.removeListener('will-download', handleWillDownload)
      const filePath = path.join(require('electron').app.getPath('downloads'), item.getFilename())
      item.setSavePath(filePath)
      item.on('updated', (event, state) => {
        switch (state) {
          case 'progressing': {
            const total = item.getTotalBytes()
            const pct =
              total > 0
                ? ((item.getReceivedBytes() / total) * 100).toFixed(0)
                : '0'
            safeSend(mainWindow, 'download-progress', pct)
            break
          }
          case 'interrupted':
            safeSend(mainWindow, 'download-paused', true)
            break
          default:
            break
        }
      })
      item.once('done', (event, state) => {
        switch (state) {
          case 'completed':
            if (notifyCompleted) {
              safeSend(mainWindow, 'download-done', { filePath })
            }
            if (typeof onCompleted === 'function') {
              Promise.resolve(onCompleted(filePath)).catch((error) => {
                console.error('下载完成后的处理失败:', error && error.message ? error.message : error)
              })
            }
            if (typeof onTerminated === 'function') onTerminated('completed')
            break
          case 'interrupted':
            safeSend(mainWindow, 'download-error', true)
            if (typeof onTerminated === 'function') onTerminated('interrupted')
            break
          case 'cancelled':
            safeSend(mainWindow, 'download-error', true)
            if (typeof onTerminated === 'function') onTerminated('cancelled')
            break
          default:
            if (typeof onTerminated === 'function') onTerminated(state)
            break
        }
      })
    }
    downloadSession.on('will-download', handleWillDownload)
    try {
      mainWindow.webContents.downloadURL(downloadUrL)
      return true
    } catch (error) {
      downloadSession.removeListener('will-download', handleWillDownload)
      if (typeof onTerminated === 'function') onTerminated('failed')
      safeSend(mainWindow, 'download-error', true)
      return false
    }
  }
}
