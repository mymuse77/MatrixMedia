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
  'publish.schedule.cancel',
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

/**
 * 判断任务是否可能包含「尚未到发布时间」的分散/定时计划。
 * 这类计划由客户端本地调度器持有，客户端重启后会继续发布，
 * 因此不能在退出上报时把整个任务一次性判为失败。
 */
function hasPendingScheduledPublishPlan(data = {}, nowMs = Date.now()) {
  if (data.scheduleMixDistribution === true || String(data.scheduleMixDistribution) === 'true') {
    return true;
  }

  const scheduleMode = String(data.scheduleMode || '').trim().toLowerCase();
  if (scheduleMode === 'scheduled' || scheduleMode === 'platform') return true;

  const taskScheduledAt = Number(data.scheduledPublishAt);
  if (Number.isFinite(taskScheduledAt) && taskScheduledAt > nowMs) return true;

  const items = Array.isArray(data.publishItems) ? data.publishItems : [];
  return items.some((item) => {
    const itemScheduledAt = Number(item && item.scheduledPublishAt);
    return Number.isFinite(itemScheduledAt) && itemScheduledAt > nowMs;
  });
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
  constructor({ resultStore } = {}) {
    this.socket = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = config.reconnection.attempts;
    this.serverUrl = config.serverUrl;
    this.clientId = getClientId();
    this.taskHandlers = new Map(); // 任务处理器映射
    this.heartbeatTimer = null; // 心跳定时器
    this.taskTypeById = new Map();
    this.taskDataById = new Map();
    this.taskStatusById = new Map();
    this.executionTokenByTaskId = new Map();
    this.publishTaskItemsByTaskId = new Map();
    this.pendingTaskResultDeliveries = new Set();
    this.resultOutbox = new Map();
    this.resultRetryTimer = null;
    this.resultStore = resultStore;
    this.resultStoreFailed = false;
    try {
      if (!this.resultStore) {
        this.resultStore = require('./publishResultOutbox').createPublishResultStore(this.serverUrl, this.clientId);
      }
      for (const result of this.resultStore.load()) {
        if (result && typeof result.taskId === 'string') {
          this.resultOutbox.set(JSON.stringify(result), { result, durable: true, attempts: 0, nextAttemptAt: 0 });
        }
      }
    } catch (error) {
      this.resultStoreFailed = true;
      console.error('[WebSocket] 发布结果队列读取失败，不覆盖原文件:', error?.message || error);
    }
    this.isShuttingDown = false;
    this.lastConnectedAt = 0;
    this.lastDisconnectedAt = 0;
    this.lastDisconnectReason = '';
  }

  /**
   * 初始化并连接 WebSocket 服务器
   */
  connect() {
    if (this.socket) {
      console.log('[WebSocket] 已存在连接，跳过重复连接');
      return;
    }

    this.isShuttingDown = false;

    console.log(`[WebSocket] 正在连接到服务器: ${this.serverUrl}${config.path}`);

    this.socket = io(this.serverUrl, {
      path: config.path,
      reconnection: config.reconnection.enabled,
      reconnectionDelay: config.reconnection.delay,
      reconnectionDelayMax: config.reconnection.delayMax,
      reconnectionAttempts: config.reconnection.attempts,
      randomizationFactor: config.reconnection.randomizationFactor,
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
      this.lastConnectedAt = Date.now();
      console.log('[WebSocket] 连接成功, Socket ID:', this.socket.id);

      // 发送认证信息（可以包含设备ID、账号列表等）
      this.authenticate();
      this.flushTaskResults();
      this.pushInitialAccountSnapshot();

      // 启动心跳
      this.startHeartbeat();
    });

    // 连接断开
    this.socket.on('disconnect', (reason) => {
      this.isConnected = false;
      this.lastDisconnectedAt = Date.now();
      this.lastDisconnectReason = String(reason || 'unknown');
      console.log('[WebSocket] 连接断开, 原因:', reason);

      // 停止心跳
      this.stopHeartbeat();

      if (this.isShuttingDown) {
        return;
      }

      if (reason === 'io server disconnect') {
        // 服务器主动断开，需要手动重连
        console.log('[WebSocket] 服务器主动断开连接，尝试重新连接...');
        this.socket.connect();
      }
    });

    // 连接错误
    this.socket.on('connect_error', (error) => {
      this.reconnectAttempts++;
      const attemptText = Number.isFinite(this.maxReconnectAttempts)
        ? `${this.reconnectAttempts}/${this.maxReconnectAttempts}`
        : `${this.reconnectAttempts}/持续重试`;
      console.warn(`[WebSocket] 连接失败，正在退避重试 (尝试 ${attemptText}):`, error.message);
    });

    // 重连尝试
    this.socket.on('reconnect_attempt', (attemptNumber) => {
      console.log(`[WebSocket] 正在尝试重连... (第 ${attemptNumber} 次)`);
    });

    // 重连成功
    this.socket.io.on('reconnect', (attemptNumber) => {
      console.log(`[WebSocket] 重连成功 (尝试了 ${attemptNumber} 次)`);
      this.reconnectAttempts = 0;
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
    if (this.isShuttingDown) return;
    const { taskId, type } = taskData;
    this.taskTypeById.set(taskId, type);
    if (type === 'publish_video' || type === 'publish_videos') {
      this.taskDataById.set(taskId, taskData);
      this.taskStatusById.delete(taskId);
    }
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
          if (this.isShuttingDown) return;
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
          if (this.isShuttingDown) return;
          const errorSummary = formatTaskError(error);
          const errorMessage = errorSummary.message || '任务执行失败';
          console.error(`[WebSocket] 任务执行失败 (${taskId}):`, errorSummary);
          if (type === 'publish_video') {
            const taskPayload = taskData && typeof taskData.data === 'object' && taskData.data !== null ? taskData.data : {};
            const nonRetryable =
              error?.nonRetryable === true ||
              error?.publishPayload?.nonRetryable === true;
            const verificationRequired =
              error?.verificationRequired === true ||
              error?.publishPayload?.verificationRequired === true;
            this.sendTaskResult(taskId, 'failed', {
              action: 'publish_video',
              itemId: taskPayload.itemId || '',
              idempotencyKey: taskPayload.idempotencyKey || '',
              executionToken: taskPayload.executionToken || '',
              phone: taskPayload.phone || '',
              platform: taskPayload.platform || '',
              videoPath: taskPayload.videoPath || taskPayload.sourceFilePath || taskPayload.filePath || '',
              videoUrl: taskPayload.videoUrl || taskPayload.url || '',
              error: errorMessage,
              nonRetryable,
              verificationRequired,
            });
            return;
          }

          if (type === 'publish_videos') {
            const taskPayload = taskData && typeof taskData.data === 'object' && taskData.data !== null ? taskData.data : {};
            this.sendTaskResult(taskId, 'failed', {
              action: 'publish_videos',
              success: false,
              status: 'failed',
              executionToken: taskPayload.executionToken || '',
              error: errorMessage,
            });
            return;
          }

          this.sendTaskResult(taskId, 'failed', { error: errorMessage });
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
  sendAck(taskId, queueStatus = {}) {
    const queuePayload = queueStatus && typeof queueStatus === 'object'
      ? Object.fromEntries(
        Object.entries(queueStatus).filter(([, value]) => value !== undefined && value !== null),
      )
      : {};
    this.socket.emit('ack', {
      clientType: config.clientType,
      clientId: this.clientId,
      protocolVersion,
      taskId,
      executionToken: this.executionTokenByTaskId.get(taskId) || '',
      ...queuePayload,
      timestamp: Date.now()
    });
    if (this.shouldLogTask(taskId)) {
      const queueMessage = queuePayload.queueState === 'queued'
        ? `，已排队，前方 ${queuePayload.queueAhead || 0} 个任务`
        : queuePayload.queueState === 'running'
          ? '，已开始执行'
          : '';
      console.log(`[WebSocket] 已发送任务确认: ${taskId}${queueMessage}`);
    }
  }

  registerPublishTaskItems(taskId, items = []) {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId || !Array.isArray(items)) return;

    const itemStates = new Map();
    for (const item of items) {
      const itemId = String(item?.itemId || '').trim();
      if (!itemId) continue;
      itemStates.set(itemId, {
        state: 'queued',
        itemId,
        idempotencyKey: item?.idempotencyKey || '',
        executionToken: item?.executionToken || '',
        phone: item?.phone || '',
        platform: item?.platform || '',
        videoPath: item?.videoPath || '',
        videoUrl: item?.videoUrl || '',
      });
    }

    if (itemStates.size > 0) {
      this.publishTaskItemsByTaskId.set(normalizedTaskId, itemStates);
    }
  }

  updatePublishTaskItem(taskId, itemId, state, patch = {}) {
    const itemStates = this.publishTaskItemsByTaskId.get(String(taskId || '').trim());
    const normalizedItemId = String(itemId || '').trim();
    if (!itemStates || !normalizedItemId) return;
    const item = itemStates.get(normalizedItemId);
    if (!item) return;
    Object.assign(item, patch);
    item.state = state;
  }

  updatePublishTaskItemsFromResult(taskId, resultData) {
    const itemStates = this.publishTaskItemsByTaskId.get(String(taskId || '').trim());
    if (!itemStates || !resultData || typeof resultData !== 'object') return;
    const currentToken = this.executionTokenByTaskId.get(String(taskId || '').trim());
    if (currentToken && currentToken !== resultData.executionToken) return;
    const results = Array.isArray(resultData.results) ? resultData.results : [];

    for (const result of results) {
      const itemId = String(result?.itemId || '').trim();
      const item = itemStates.get(itemId);
      if (!item) continue;
      const status = String(result?.status || '').toLowerCase();
      if (result?.success === true || status === 'success' || status === 'completed') {
        item.state = 'success';
      } else if (status === 'failed' || status === 'skipped' || status === 'expired') {
        item.state = 'failed';
      }
    }
  }

  finalizeTaskTracking(taskId, resultData) {
    const normalizedTaskId = String(taskId || '').trim();
    const currentToken = this.executionTokenByTaskId.get(normalizedTaskId) || this.taskDataById.get(normalizedTaskId)?.data?.executionToken;
    if (currentToken && currentToken !== resultData?.executionToken) return;
    if ([...this.resultOutbox.values()].some((entry) => entry.result.taskId === normalizedTaskId)) return;
    const businessStatus = String(resultData?.status || '').toLowerCase();
    const items = this.publishTaskItemsByTaskId.get(normalizedTaskId);
    const allFinished = items?.size > 0 && [...items.values()].every((item) => item.state === 'success' || item.state === 'failed');
    const keepsExecutionContext = !allFinished && (businessStatus === 'running' || businessStatus === 'scheduled');
    if (!keepsExecutionContext) {
      this.taskTypeById.delete(normalizedTaskId);
      this.taskDataById.delete(normalizedTaskId);
      this.taskStatusById.delete(normalizedTaskId);
      this.executionTokenByTaskId.delete(normalizedTaskId);
      this.publishTaskItemsByTaskId.delete(normalizedTaskId);
    } else {
      this.taskStatusById.set(normalizedTaskId, businessStatus);
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

    const snapshot = JSON.parse(JSON.stringify(result));
    const key = JSON.stringify(snapshot);
    const type = this.taskTypeById.get(taskId) || snapshot.data?.action;
    const entry = { result: snapshot, durable: type === 'publish_video' || type === 'publish_videos', attempts: 0, nextAttemptAt: 0 };
    this.resultOutbox.set(key, entry);
    if (entry.durable) this.persistResultOutbox();
    this.updatePublishTaskItemsFromResult(taskId, snapshot.data);
    return this.deliverTaskResult(key, entry);
  }

  persistResultOutbox() {
    if (this.resultStoreFailed) return false;
    try {
      this.resultStore.save([...this.resultOutbox.values()].filter((entry) => entry.durable).map((entry) => entry.result));
      return true;
    } catch (error) {
      console.error('[WebSocket] 发布结果队列保存失败，保留内存结果:', error?.message || error);
      return false;
    }
  }

  scheduleResultRetry() {
    if (this.resultRetryTimer || this.isShuttingDown || !this.isConnected || !this.resultOutbox.size) return;
    this.resultRetryTimer = setTimeout(() => {
      this.resultRetryTimer = null;
      this.flushTaskResults();
    }, 1_000);
    this.resultRetryTimer.unref?.();
  }

  flushTaskResults() {
    for (const [key, entry] of this.resultOutbox) {
      if (!entry.delivery && entry.nextAttemptAt <= Date.now()) void this.deliverTaskResult(key, entry);
    }
    this.scheduleResultRetry();
  }

  deliverTaskResult(key, entry) {
    if (entry.delivery) return entry.delivery;
    const socket = this.socket;
    if (!socket || !this.isConnected) return Promise.resolve(false);
    const delivery = new Promise((resolve) => {
      try {
        socket.timeout(5_000).emit('result', entry.result, (error, response) => {
          resolve(!error && response?.success === true);
        });
      } catch (error) {
        console.warn('[WebSocket] 发送结果失败:', error?.message || error);
        resolve(false);
      }
    });
    entry.delivery = delivery;
    this.pendingTaskResultDeliveries.add(delivery);
    void delivery.then((delivered) => {
      entry.delivery = null;
      this.pendingTaskResultDeliveries.delete(delivery);
      if (this.resultOutbox.get(key) !== entry) return;
      if (delivered) {
        this.resultOutbox.delete(key);
        if (entry.durable) this.persistResultOutbox();
        this.finalizeTaskTracking(entry.result.taskId, entry.result.data);
      } else {
        entry.attempts += 1;
        entry.nextAttemptAt = Date.now() + Math.min(30_000, 1_000 * 2 ** Math.min(entry.attempts, 5));
      }
      this.scheduleResultRetry();
    });
    return delivery;
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
  async notifyInterruptedTasks(reason = '应用退出，已中断发布', timeoutMs = 4_000) {
    const socket = this.socket;
    if (!socket || !this.isConnected) return false;

    const pendingDeliveries = [...this.pendingTaskResultDeliveries];
    if (pendingDeliveries.length > 0) {
      await Promise.race([
        Promise.allSettled(pendingDeliveries),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    }

    const tasks = Array.from(this.taskDataById.entries())
      .filter(([taskId, taskData]) => {
        const type = this.taskTypeById.get(taskId) || taskData?.type;
        return (
          (type === 'publish_video' || type === 'publish_videos') &&
          this.taskStatusById.get(taskId) !== 'scheduled'
        );
      })
      .map(([taskId, taskData]) => {
        const type = this.taskTypeById.get(taskId) || taskData?.type;
        const data = taskData?.data && typeof taskData.data === 'object' && !Array.isArray(taskData.data)
          ? taskData.data
          : {};
        const itemStates = this.publishTaskItemsByTaskId.get(taskId);
        if (type === 'publish_video' && [...this.resultOutbox.values()].some((entry) =>
          entry.result.taskId === taskId && entry.result.data?.executionToken === data.executionToken)) return null;
        // 明细状态缺失时无法区分「已到时间」与「尚未到时间的分散/定时计划」。
        // 此时整批上报失败会让服务端把本地仍在等待执行的计划一并判为失败，
        // 而客户端重启后本地调度器仍会继续发布它们，导致实际已发布却显示失败。
        // 这种情况不上报，交给服务端断线接管（只终止已到时间的明细，保留未来计划）。
        if (type === 'publish_videos' && !itemStates && hasPendingScheduledPublishPlan(data)) {
          return null;
        }
        if (type === 'publish_videos' && itemStates) {
          const futureIds = new Set((Array.isArray(data.publishItems) ? data.publishItems : [])
            .filter((item) => Number(item.scheduledPublishAt) > Date.now())
            .map((item) => String(item.itemId || item.id || '')));
          const listedItems = [...itemStates.values()].filter((item) => item.state !== 'scheduled' &&
            (item.state === 'success' || item.state === 'failed' || !futureIds.has(item.itemId)));
          if (listedItems.length === 0) return null;
          return {
            taskId,
            status: 'failed',
            data: {
              action: type,
              success: false,
              status: 'failed',
              clientShutdown: true,
              onlyApplyListedItems: true,
              error: reason,
              message: reason,
              executionToken: data.executionToken || '',
              ...(data.matrixTaskId ? { matrixTaskId: data.matrixTaskId } : {}),
              results: listedItems.map((item) => {
                const completedSuccessfully = item.state === 'success';
                return {
                  ...item,
                  status: completedSuccessfully ? 'success' : 'failed',
                  success: completedSuccessfully,
                  error: completedSuccessfully ? '' : item.error || reason,
                  message: completedSuccessfully ? '' : item.error || reason,
                };
              }),
            },
          };
        }
        const interruptedData = {
          action: type,
          success: false,
          status: 'failed',
          error: reason,
          message: reason,
          executionToken: data.executionToken || '',
          ...(data.matrixTaskId ? { matrixTaskId: data.matrixTaskId } : {}),
          ...(type === 'publish_video'
            ? {
              itemId: data.itemId || '',
              idempotencyKey: data.idempotencyKey || '',
              phone: data.phone || '',
              platform: data.platform || '',
              videoPath: data.videoPath || data.sourceVideoPath || data.filePath || '',
              videoUrl: data.videoUrl || data.url || '',
            }
            : {}),
        };

        return {
          taskId,
          status: 'failed',
          data: interruptedData,
        };
      })
      .filter(Boolean);

    if (tasks.length === 0) return true;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (success) => {
        if (settled) return;
        settled = true;
        resolve(success);
      };

      const timer = setTimeout(() => finish(false), timeoutMs + 250);
      try {
        socket.timeout(timeoutMs).emit(
          'client:shutdown',
          {
            clientType: config.clientType,
            clientId: this.clientId,
            reason,
            tasks,
            timestamp: Date.now(),
          },
          (error, response) => {
            clearTimeout(timer);
            finish(!error && response?.success !== false);
          },
        );
      } catch (error) {
        clearTimeout(timer);
        console.warn('[WebSocket] 上报退出中的发布任务失败:', error?.message || error);
        finish(false);
      }
    });
  }

  async disconnect(reason = '应用退出，已中断发布') {
    const socket = this.socket;
    this.isShuttingDown = true;
    clearTimeout(this.resultRetryTimer);
    this.resultRetryTimer = null;
    this.persistResultOutbox();
    this.stopHeartbeat();

    if (!socket) {
      this.isConnected = false;
      return false;
    }

    console.log('[WebSocket] 正在断开连接...');
    const notified = await this.notifyInterruptedTasks(reason);
    // 分散发布的未来计划必须继续保存在本地。客户端重启后调度器会恢复它们，
    // 服务端退出处理只会终止当前已到时间的明细，并保留同一执行令牌。
    socket.disconnect();
    if (this.socket === socket) {
      this.socket = null;
    }
    this.isConnected = false;
    this.taskTypeById.clear();
    this.taskDataById.clear();
    this.taskStatusById.clear();
    this.executionTokenByTaskId.clear();
    this.publishTaskItemsByTaskId.clear();
    this.pendingTaskResultDeliveries.clear();
    return notified;
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
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastDisconnectReason: this.lastDisconnectReason,
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
