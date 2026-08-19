/* eslint-disable no-case-declarations */
import path from 'path'
import fs from 'fs'
import http from 'http'
import https from 'https'

function completeDownload(mainWindow, filePath, options) {
  const { onCompleted, onTerminated, notifyCompleted = true } = options
  if (notifyCompleted) {
    safeSend(mainWindow, 'download-done', { filePath })
  }
  if (typeof onCompleted === 'function') {
    Promise.resolve()
      .then(() => onCompleted(filePath))
      .catch((error) => {
        console.error('下载完成后的处理失败:', error && error.message ? error.message : error)
      })
      .finally(() => {
        if (typeof onTerminated === 'function') onTerminated('completed')
      })
    return
  }
  if (typeof onTerminated === 'function') onTerminated('completed')
}

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
    const {
      onCompleted,
      onTerminated,
      notifyCompleted = true,
      downloadDirectory,
    } = options;
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
      const targetDirectory =
        typeof downloadDirectory === 'string' && downloadDirectory
          ? downloadDirectory
          : require('electron').app.getPath('downloads')
      const filePath = path.join(targetDirectory, item.getFilename())
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
              Promise.resolve()
                .then(() => onCompleted(filePath))
                .catch((error) => {
                  console.error('下载完成后的处理失败:', error && error.message ? error.message : error)
                })
                .finally(() => {
                  if (typeof onTerminated === 'function') onTerminated('completed')
                })
              break
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
  },

  downloadToPath(mainWindow, downloadUrl, filePath, options = {}) {
    const { onCompleted, onTerminated, notifyCompleted = false } = options
    if (!downloadUrl || !filePath) return false

    let finalizing = false
    let activeRequest = null
    let output = null

    const removePartialFile = () => {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
      } catch (error) {
        console.warn('清理更新临时文件失败:', error && error.message ? error.message : error)
      }
    }

    const fail = (error) => {
      if (finalizing) return
      finalizing = true
      if (activeRequest) activeRequest.destroy()
      if (output) output.destroy()
      removePartialFile()
      console.error('更新文件下载失败:', error && error.message ? error.message : error)
      safeSend(mainWindow, 'download-error', true)
      if (typeof onTerminated === 'function') onTerminated('failed')
    }

    const requestFile = (url, redirectCount = 0) => {
      if (redirectCount > 5) {
        fail(new Error('更新文件重定向次数过多'))
        return
      }

      let parsedUrl
      try {
        parsedUrl = new URL(url)
      } catch (error) {
        fail(error)
        return
      }

      const requestClient = parsedUrl.protocol === 'http:' ? http : https
      try {
        activeRequest = requestClient.get(
          parsedUrl,
          {
            headers: {
              'User-Agent': 'matrix-video',
            },
          },
          (response) => {
            const statusCode = response.statusCode || 0
            const redirectLocation = response.headers.location
            if (statusCode >= 300 && statusCode < 400 && redirectLocation) {
              response.resume()
              requestFile(new URL(redirectLocation, parsedUrl).toString(), redirectCount + 1)
              return
            }
            if (statusCode !== 200) {
              response.resume()
              fail(new Error(`更新服务器返回 HTTP ${statusCode}`))
              return
            }

            try {
              fs.mkdirSync(path.dirname(filePath), { recursive: true })
              output = fs.createWriteStream(filePath)
            } catch (error) {
              response.resume()
              fail(error)
              return
            }

            const totalBytes = Number(response.headers['content-length']) || 0
            let receivedBytes = 0
            response.on('data', (chunk) => {
              receivedBytes += chunk.length
              if (totalBytes > 0) {
                safeSend(
                  mainWindow,
                  'download-progress',
                  ((receivedBytes / totalBytes) * 100).toFixed(0)
                )
              }
            })
            response.once('error', fail)
            output.once('error', fail)
            output.once('finish', () => {
              output.close(() => {
                if (finalizing) return
                finalizing = true
                completeDownload(mainWindow, filePath, {
                  onCompleted,
                  onTerminated,
                  notifyCompleted,
                })
              })
            })
            response.pipe(output)
          }
        )
        activeRequest.once('error', fail)
      } catch (error) {
        fail(error)
      }
    }

    requestFile(downloadUrl)
    return true
  },
}
