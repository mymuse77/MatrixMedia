/**
 * WebSocket 客户端服务
 * 用于连接远程服务器，接收视频发布任务
 */

const { io } = require('socket.io-client');
const config = require('../config/websocket.config');

class WebSocketClient {
  constructor() {
    this.socket = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = config.reconnection.attempts;
    this.serverUrl = config.serverUrl;
    this.taskHandlers = new Map(); // 任务处理器映射
    this.heartbeatTimer = null; // 心跳定时器
  }

  /**
   * 初始化并连接 WebSocket 服务器
   */
  connect() {
    if (this.socket) {
      console.log('[WebSocket] 已存在连接，跳过重复连接');
      return;
    }

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
      console.log('[WebSocket] 连接成功, Socket ID:', this.socket.id);

      // 发送认证信息（可以包含设备ID、账号列表等）
      this.authenticate();

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

      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        console.error('[WebSocket] 达到最大重连次数，停止重连');
        this.disconnect();
      }
    });

    // 重连尝试
    this.socket.on('reconnect_attempt', (attemptNumber) => {
      console.log(`[WebSocket] 正在尝试重连... (第 ${attemptNumber} 次)`);
    });

    // 重连成功
    this.socket.on('reconnect', (attemptNumber) => {
      console.log(`[WebSocket] 重连成功 (尝试了 ${attemptNumber} 次)`);
      this.reconnectAttempts = 0;
    });

    // 接收服务器的 pong 响应
    this.socket.on('pong', (data) => {
      console.log('[WebSocket] 收到 pong:', data);
    });

    // 接收发布任务
    this.socket.on('task', (taskData) => {
      console.log('[WebSocket] 收到发布任务:', taskData);
      this.handleTask(taskData);
    });

    // 接收服务器消息
    this.socket.on('message', (data) => {
      console.log('[WebSocket] 收到服务器消息:', data);
    });
  }

  /**
   * 发送认证信息
   */
  authenticate() {
    // TODO: 获取本地账号列表
    const authData = {
      type: 'auth',
      clientType: config.clientType,
      deviceId: this.getDeviceId(),
      timestamp: Date.now(),
      // accounts: [], // 可用账号列表
    };

    console.log('[WebSocket] 发送认证信息:', authData);
    this.socket.emit('auth', authData);
  }

  /**
   * 获取设备ID（可以从配置文件读取或生成）
   */
  getDeviceId() {
    // TODO: 实现设备ID获取逻辑
    return `device-${Date.now()}`;
  }

  /**
   * 处理接收到的任务
   */
  handleTask(taskData) {
    const { taskId, type } = taskData;

    // 立即发送 ACK 确认收到任务
    this.sendAck(taskId);

    // 根据任务类型调用对应的处理器
    const handler = this.taskHandlers.get(type);
    if (handler) {
      handler(taskData)
        .then((result) => {
          this.sendTaskResult(taskId, 'success', result);
        })
        .catch((error) => {
          console.error(`[WebSocket] 任务执行失败 (${taskId}):`, error);
          this.sendTaskResult(taskId, 'failed', { error: error.message });
        });
    } else {
      console.warn(`[WebSocket] 未找到任务类型 "${type}" 的处理器`);
      this.sendTaskResult(taskId, 'failed', { error: `未知任务类型: ${type}` });
    }
  }

  /**
   * 发送任务确认
   */
  sendAck(taskId) {
    this.socket.emit('ack', {
      clientType: config.clientType,
      taskId,
      timestamp: Date.now()
    });
    console.log(`[WebSocket] 已发送任务确认: ${taskId}`);
  }

  /**
   * 发送任务执行结果
   */
  sendTaskResult(taskId, status, data) {
    const result = {
      clientType: config.clientType,
      taskId,
      status, // 'success' | 'failed'
      data,
      timestamp: Date.now(),
    };

    this.socket.emit('result', result);
    console.log(`[WebSocket] 已发送任务结果: ${taskId}, 状态: ${status}`);
  }

  /**
   * 发送进度更新
   */
  sendProgress(taskId, progress, message) {
    const progressData = {
      clientType: config.clientType,
      taskId,
      progress, // 0-100
      message,
      timestamp: Date.now(),
    };

    this.socket.emit('progress', progressData);
    console.log(`[WebSocket] 已发送进度更新: ${taskId}, ${progress}%`);
  }

  /**
   * 发送客户端状态
   */
  sendStatus(statusData) {
    this.socket.emit('status', {
      clientType: config.clientType,
      ...statusData,
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

  /**
   * 发送心跳
   */
  sendHeartbeat() {
    if (this.isConnected) {
      this.socket.emit('heartbeat', {
        clientType: config.clientType,
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
};
