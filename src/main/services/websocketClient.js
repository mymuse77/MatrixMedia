/**
 * WebSocket 客户端服务
 * 用于连接远程服务器，接收视频发布任务
 */

const { io } = require('socket.io-client');
const config = require('../config/websocket.config');
const { getClientId } = require('./clientIdentity');
const { sendAccountSnapshot } = require('./websocketHandlers');
const { resolveTaskTransportStatus } = require('./taskResultStatus');
const packageJson = require('../../../package.json');

const protocolVersion = 'matrix-ws-v1';
const QUIET_TASK_TYPES = new Set(['get_accounts', 'get_publish_task_status']);
const clientCapabilities = [
  'accounts.read',
  'accounts.write',
  'accounts.group',
  'publish.video',
  'publish.videos',
  'publish.remote-url',
  'publish.history',
  'client.status',
];

function getClientClockInfo(nowMs = Date.now()) {
  let timeZone = '';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch (_) {
    timeZone = process.env.TZ || '';
  }

  return {
    timeZone,
    utcOffsetMinutes: -new Date(nowMs).getTimezoneOffset(),
    clientTimeMs: nowMs,
  };
}

function isAxiosError(error) {
  return !!(error && (error.isAxiosError || error.name === 'AxiosError'));
}

function truncateText(value, maxLength = 200) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function formatTaskError(error) {
  if (!error) {
    return { message: '未知错误' };
  }

  if (isAxiosError(error)) {
    const summary = {
      name: error.name || 'AxiosError',
      message: error.message || '请求失败',
    };

    if (error.code) summary.code = error.code;
    if (error.config?.method) summary.method = String(error.config.method).toUpperCase();
    if (error.config?.url) summary.url = error.config.url;
    if (typeof error.response?.status === 'number') summary.status = error.response.status;

    const redirectedUrl = error.response?.request?.res?.responseUrl;
    if (redirectedUrl && redirectedUrl !== error.config?.url) {
      summary.redirectedUrl = redirectedUrl;
    }

    const responseData = error.response?.data;
    if (typeof responseData === 'string') {
      const snippet = truncateText(responseData);
      if (snippet) summary.response = snippet;
    }

    return summary;
  }

  return {
    name: error.name || 'Error',
    message: error.message || String(error),
  };
}

class WebSocketClient {
  constructor() {
    this.socket = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = config.reconnection.attempts;
    this.serverUrl = config.serverUrl;
    this.clientId = getClientId();
    this.taskHandlers = new Map(); // 任务处理器映射
    this.heartbeatTimer = null; // 心跳定时器
    this.manualReconnectTimer = null; // 达到上限后的低频自恢复重连
    this.taskTypeById = new Map();
    this.executionTokenByTaskId = new Map();
  }

  /**
   * 初始化并连接 WebSocket 服务器
   */
  connect() {
    if (this.socket) {
      console.log('[WebSocket] 已存在连接，跳过重复连接');
      return;
    }

    this.clearManualReconnectTimer();

    console.log(`[WebSocket] 正在连接到服务器: ${this.serverUrl}${config.path}`);

    this.socket = io(this.serverUrl, {
      path: config.path,
      reconnection: config.reconnection.enabled,
      reconnectionDelay: config.reconnection.delay,
      reconnectionDelayMax: config.reconnection.delayMax,
      reconnectionAttempts: config.reconnection.attempts,
      timeout: config.timeout,
      transports: config.transports,
    });

    this.setupEventHandlers();
  }

  /**
   * 设置事件处理器
   */
  setupEventHandlers() {
    // 连接成功
    this.socket.on('connect', () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.clearManualReconnectTimer();
      console.log('[WebSocket] 连接成功, Socket ID:', this.socket.id);

      // 发送认证信息（可以包含设备ID、账号列表等）
      this.authenticate();
      this.pushInitialAccountSnapshot();

      // 启动心跳
      this.startHeartbeat();
    });

    // 连接断开
    this.socket.on('disconnect', (reason) => {
      this.isConnected = false;
      console.log('[WebSocket] 连接断开, 原因:', reason);

      // 停止心跳
      this.stopHeartbeat();

      if (reason === 'io server disconnect') {
        // 服务器主动断开，需要手动重连
        console.log('[WebSocket] 服务器主动断开连接，尝试重新连接...');
        this.socket.connect();
      }
    });

    // 连接错误
    this.socket.on('connect_error', (error) => {
      this.reconnectAttempts++;
      console.error(`[WebSocket] 连接错误 (尝试 ${this.reconnectAttempts}/${this.maxReconnectAttempts}):`, error.message);
    });

    // 重连尝试
    this.socket.on('reconnect_attempt', (attemptNumber) => {
      console.log(`[WebSocket] 正在尝试重连... (第 ${attemptNumber} 次)`);
    });

    // 重连成功
    this.socket.on('reconnect', (attemptNumber) => {
      console.log(`[WebSocket] 重连成功 (尝试了 ${attemptNumber} 次)`);
      this.reconnectAttempts = 0;
      this.clearManualReconnectTimer();
    });

    this.socket.io.on('reconnect_failed', () => {
      console.error('[WebSocket] 达到最大重连次数，切换为低频自动重试');
      this.scheduleManualReconnect();
    });

    // 接收服务器的 pong 响应
    this.socket.on('pong', () => {});

    // 接收发布任务
    this.socket.on('task', (taskData) => {
      const taskType = String(taskData?.type || '');
      const taskId = String(taskData?.taskId || '');
      if (!QUIET_TASK_TYPES.has(taskType)) {
        console.log('[WebSocket] 收到发布任务:', { taskId, type: taskType });
      }
      this.handleTask(taskData);
    });

    // 接收服务器消息
    this.socket.on('message', (data) => {
      if (data?.type === 'heartbeat_ack' || data?.type === 'pong') {
        return;
      }
      console.log('[WebSocket] 收到服务器消息:', data);
    });
  }

  /**
   * 发送认证信息
   */
  authenticate() {
    // TODO: 获取本地账号列表
    const clockInfo = getClientClockInfo();
    const authData = {
      type: 'auth',
      clientType: config.clientType,
      clientId: this.clientId,
      deviceId: this.getDeviceId(),
      appVersion: packageJson.version,
      protocolVersion,
      capabilities: clientCapabilities,
      ...clockInfo,
      timestamp: Date.now(),
      // accounts: [], // 可用账号列表
    };

    console.log('[WebSocket] 发送认证信息:', authData);
    this.socket.emit('auth', authData);
  }

  pushInitialAccountSnapshot() {
    sendAccountSnapshot(this, 'client_connected').catch((error) => {
      console.error('[WebSocket] 初始账号快照推送失败:', error && error.message ? error.message : error);
    });
  }

  /**
   * 获取设备ID（可以从配置文件读取或生成）
   */
  getDeviceId() {
    return this.clientId;
  }

  /**
   * 处理接收到的任务
   */
  handleTask(taskData) {
    const { taskId, type } = taskData;
    this.taskTypeById.set(taskId, type);
    if (taskData?.data?.executionToken) {
      this.executionTokenByTaskId.set(taskId, taskData.data.executionToken);
    }

    // 立即发送 ACK 确认收到任务
    this.sendAck(taskId);

    // 根据任务类型调用对应的处理器
    const handler = this.taskHandlers.get(type);
    if (handler) {
      handler(taskData)
        .then((result) => {
          if (type === 'publish_video') {
            const taskPayload = taskData && typeof taskData.data === 'object' && taskData.data !== null ? taskData.data : {};
            this.sendTaskResult(taskId, 'success', {
              action: 'publish_video',
              itemId: taskPayload.itemId || '',
              idempotencyKey: taskPayload.idempotencyKey || '',
              executionToken: taskPayload.executionToken || '',
              phone: taskPayload.phone || '',
              platform: taskPayload.platform || '',
              videoPath: taskPayload.videoPath || taskPayload.sourceFilePath || taskPayload.filePath || '',
              videoUrl: taskPayload.videoUrl || taskPayload.url || '',
              ...(result && typeof result === 'object' ? result : { result }),
            });
            return;
          }

          this.sendTaskResult(
            taskId,
            resolveTaskTransportStatus(type, result),
            result,
          );
        })
        .catch((error) => {
          console.error(`[WebSocket] 任务执行失败 (${taskId}):`, formatTaskError(error));
          if (type === 'publish_video') {
            const taskPayload = taskData && typeof taskData.data === 'object' && taskData.data !== null ? taskData.data : {};
            this.sendTaskResult(taskId, 'failed', {
              action: 'publish_video',
              itemId: taskPayload.itemId || '',
              idempotencyKey: taskPayload.idempotencyKey || '',
              executionToken: taskPayload.executionToken || '',
              phone: taskPayload.phone || '',
              platform: taskPayload.platform || '',
              videoPath: taskPayload.videoPath || taskPayload.sourceFilePath || taskPayload.filePath || '',
              videoUrl: taskPayload.videoUrl || taskPayload.url || '',
              error: error.message,
            });
            return;
          }

          this.sendTaskResult(taskId, 'failed', { error: error.message });
        });
    } else {
      console.warn(`[WebSocket] 未找到任务类型 "${type}" 的处理器`);
      this.sendTaskResult(taskId, 'failed', { error: `未知任务类型: ${type}` });
    }
  }

  shouldLogTask(taskId) {
    const taskType = this.taskTypeById.get(taskId);
    return !QUIET_TASK_TYPES.has(taskType);
  }

  /**
   * 发送任务确认
   */
  sendAck(taskId) {
    this.socket.emit('ack', {
      clientType: config.clientType,
      clientId: this.clientId,
      protocolVersion,
      taskId,
      timestamp: Date.now()
    });
    if (this.shouldLogTask(taskId)) {
      console.log(`[WebSocket] 已发送任务确认: ${taskId}`);
    }
  }

  /**
   * 发送任务执行结果
   */
  sendTaskResult(taskId, status, data) {
    const result = {
      clientType: config.clientType,
      clientId: this.clientId,
      protocolVersion,
      taskId,
      status, // 'success' | 'failed'
      data,
      timestamp: Date.now(),
    };

    this.socket.emit('result', result);
    if (this.shouldLogTask(taskId)) {
      console.log(`[WebSocket] 已发送任务结果: ${taskId}, 状态: ${status}`);
    }
    this.taskTypeById.delete(taskId);
    this.executionTokenByTaskId.delete(taskId);
  }

  /**
   * 发送进度更新
   */
  sendProgress(taskId, progress, message) {
    const progressData = {
      clientType: config.clientType,
      clientId: this.clientId,
      protocolVersion,
      taskId,
      progress, // 0-100
      message,
      executionToken: this.executionTokenByTaskId.get(taskId) || '',
      timestamp: Date.now(),
    };

    this.socket.emit('progress', progressData);
    if (this.shouldLogTask(taskId)) {
      console.log(`[WebSocket] 已发送进度更新: ${taskId}, ${progress}%`);
    }
  }

  /**
   * 发送客户端状态
   */
  sendStatus(statusData) {
    const clockInfo = getClientClockInfo();
    this.socket.emit('status', {
      clientType: config.clientType,
      clientId: this.clientId,
      appVersion: packageJson.version,
      protocolVersion,
      capabilities: clientCapabilities,
      ...statusData,
      ...clockInfo,
      timestamp: Date.now(),
    });
  }

  /**
   * 注册任务处理器
   * @param {string} taskType - 任务类型
   * @param {Function} handler - 处理函数，返回 Promise
   */
  registerTaskHandler(taskType, handler) {
    this.taskHandlers.set(taskType, handler);
    console.log(`[WebSocket] 已注册任务处理器: ${taskType}`);
  }

  /**
   * 启动心跳
   */
  startHeartbeat() {
    this.stopHeartbeat(); // 先清除旧的定时器

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, config.heartbeatInterval);

    console.log(`[WebSocket] 心跳已启动，间隔: ${config.heartbeatInterval}ms`);
  }

  /**
   * 停止心跳
   */
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      console.log('[WebSocket] 心跳已停止');
    }
  }

  clearManualReconnectTimer() {
    if (this.manualReconnectTimer) {
      clearTimeout(this.manualReconnectTimer);
      this.manualReconnectTimer = null;
    }
  }

  scheduleManualReconnect() {
    if (this.manualReconnectTimer) return;

    const retryDelay = Math.max(config.reconnection.delayMax || 5000, 15000);
    this.manualReconnectTimer = setTimeout(() => {
      this.manualReconnectTimer = null;

      if (!this.socket || this.isConnected) {
        return;
      }

      this.reconnectAttempts = 0;
      console.log(`[WebSocket] ${retryDelay}ms 后执行手动重连...`);
      this.socket.connect();
    }, retryDelay);

    console.log(`[WebSocket] 已安排低频自动重连，${retryDelay}ms 后重试`);
  }

  /**
   * 发送心跳
   */
  sendHeartbeat() {
    if (this.isConnected) {
      const clockInfo = getClientClockInfo();
      this.socket.emit('heartbeat', {
        clientType: config.clientType,
        clientId: this.clientId,
        appVersion: packageJson.version,
        protocolVersion,
        capabilities: clientCapabilities,
        ...clockInfo,
        timestamp: Date.now()
      });
    }
  }

  /**
   * 断开连接
   */
  disconnect() {
    if (this.socket) {
      console.log('[WebSocket] 正在断开连接...');
      this.stopHeartbeat();
      this.clearManualReconnectTimer();
      this.socket.disconnect();
      this.socket = null;
      this.isConnected = false;
    }
  }

  /**
   * 获取连接状态
   */
  getConnectionStatus() {
    return {
      isConnected: this.isConnected,
      clientId: this.clientId,
      socketId: this.socket?.id,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}

// 单例模式
let instance = null;

function getWebSocketClient() {
  if (!instance) {
    instance = new WebSocketClient();
  }
  return instance;
}

module.exports = {
  getWebSocketClient,
  WebSocketClient,
  getClientClockInfo,
};
