/**
 * WebSocket 任务处理器
 * 处理来自 Web 端的各种业务请求
 */

import { changeData } from '../server/utils';
import { runPuppeteerTask, createIpcTransport } from './puppeteerFile';
import ptConfig from '../config/ptConfig';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';

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

/**
 * 检查账号登录状态
 */
async function checkAccountLogin(phone, platform) {
  // TODO: 实现登录状态检查逻辑
  // 可以通过检查 session cookie 来判断
  return {
    isLoggedIn: false,
    partition: `persist:${phone}${platform}`,
  };
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

    wsClient.sendProgress(taskId, 100, '账号创建成功');

    return {
      success: true,
      account: {
        phone,
        platform,
        partition: `persist:${phone}${platform}`,
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
    const formattedAccounts = accounts.map(acc => ({
      id: acc.id,
      phone: acc.phone,
      platform: acc.pt,
      partition: `persist:${acc.phone}${acc.pt}`,
      url: acc.url,
      createTime: acc.createTime,
      // TODO: 添加登录状态检查
      isLoggedIn: false,
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
 * 4. 发布视频任务
 */
export async function handlePublishVideo(taskData, wsClient) {
  const { taskId, data } = taskData;
  const {
    phone,
    platform,
    partition,
    videoUrl,
    videoPath,
    title,
    description,
    tags,
    coverPath,
    location,
  } = data;

  try {
    wsClient.sendProgress(taskId, 5, '准备发布任务');

    // 验证必填字段
    if (!phone || !platform) {
      throw new Error('缺少必填字段: phone, platform');
    }

    if (!videoUrl && !videoPath) {
      throw new Error('必须提供 videoUrl 或 videoPath');
    }

    // 如果是 URL，需要先下载
    let localVideoPath = videoPath;
    if (videoUrl && !videoPath) {
      wsClient.sendProgress(taskId, 10, '正在下载视频');
      // TODO: 实现视频下载逻辑
      throw new Error('暂不支持从 URL 下载视频，请提供本地路径');
    }

    // 验证视频文件是否存在
    if (!fs.existsSync(localVideoPath)) {
      throw new Error(`视频文件不存在: ${localVideoPath}`);
    }

    wsClient.sendProgress(taskId, 20, '正在准备发布数据');

    // 构建发布任务数据
    const publishData = {
      taskId,
      bookName: title || path.basename(localVideoPath),
      textType: 'local',
      data: {
        textOtherName: title || '',
        bt1: title || '',
        bt2: description || title || '',
        bq: tags || '',
        bdText: '',
        address: location || '',
      },
      textOtherName: title || '',
      selectedFile: path.basename(localVideoPath),
      filePath: localVideoPath,
      url: ptConfig[platform]?.upload,
      show: false,
      mmCliSuppressWindow: true,
      closeWindowAfterPublish: true,
      useragent: ptConfig[platform]?.useragent,
      partition: partition || `persist:${phone}${platform}`,
      pt: platform,
      phone,
      date: new Date().toISOString().split('T')[0],
      coverPath: coverPath || '',
    };

    wsClient.sendProgress(taskId, 30, '正在启动发布流程');

    // 创建发布记录
    await changeData({
      type: 'add',
      fileName: 'pushData',
      item: publishData,
    });

    // 执行发布任务
    return new Promise((resolve, reject) => {
      const transport = {
        reply: (channel, payload) => {
          console.log(`[WebSocket] 发布进度 [${channel}]:`, payload);

          if (channel === 'puppeteerFile-reply') {
            const { status, message, progress } = payload;

            if (status === 'progress') {
              wsClient.sendProgress(taskId, 30 + (progress || 0) * 0.7, message || '发布中');
            } else if (status === 'success') {
              wsClient.sendProgress(taskId, 100, '发布成功');
              resolve({
                success: true,
                message: message || '视频发布成功',
                data: payload,
              });
            } else if (status === 'error' || status === 'failed') {
              reject(new Error(message || '发布失败'));
            }
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

    // TODO: 实现更详细的状态统计
    const loggedInCount = 0; // 需要实现登录状态检查
    const loggedOutCount = accounts.length;

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

  // 4. 发布视频任务
  wsClient.registerTaskHandler('publish_video', (taskData) =>
    handlePublishVideo(taskData, wsClient)
  );

  // 5. 查询发布历史
  wsClient.registerTaskHandler('get_publish_history', (taskData) =>
    handleGetPublishHistory(taskData, wsClient)
  );

  // 6. 获取客户端状态
  wsClient.registerTaskHandler('get_client_status', (taskData) =>
    handleGetClientStatus(taskData, wsClient)
  );

  console.log('[WebSocket] 已注册所有任务处理器');
}
