# WebSocket 客户端使用指南

## 概述

WebSocket 客户端服务用于连接远程服务器，接收视频发布任务并执行。客户端在应用启动时自动连接，支持断线重连、心跳保活等功能。

## 功能特性

- ✅ 自动连接：应用启动时自动连接到 WebSocket 服务器
- ✅ 断线重连：支持指数退避重连策略
- ✅ 心跳保活：定时发送心跳，保持连接活跃
- ✅ 任务处理：接收并处理服务器下发的任务
- ✅ 消息确认：任务接收后立即发送 ACK
- ✅ 进度上报：实时上报任务执行进度
- ✅ 状态同步：定期同步客户端状态

## 配置

### 服务器地址配置

编辑 `src/main/config/websocket.config.js`：

```javascript
module.exports = {
  // WebSocket 服务器地址
  serverUrl: 'http://your-server.com:3000',
  
  // 重连配置
  reconnection: {
    enabled: true,
    delay: 1000,        // 初始重连延迟（毫秒）
    delayMax: 5000,     // 最大重连延迟（毫秒）
    attempts: 10,       // 最大重连次数
  },
  
  // 心跳间隔（毫秒）
  heartbeatInterval: 30000,
};
```

### 环境变量配置

也可以通过环境变量设置服务器地址：

```bash
# Windows
set WS_SERVER_URL=http://your-server.com:3000

# Linux/Mac
export WS_SERVER_URL=http://your-server.com:3000
```

## 使用方法

### 1. 安装依赖

```bash
npm install socket.io-client
# 或
yarn add socket.io-client
```

### 2. 启动应用

应用启动时会自动连接 WebSocket 服务器，无需手动操作。

### 3. 注册任务处理器

在 `src/main/index.js` 中注册任务处理器：

```javascript
const wsClient = getWebSocketClient();

// 注册视频发布任务处理器
wsClient.registerTaskHandler('publish_video', async (taskData) => {
  console.log('收到视频发布任务:', taskData);
  
  const { videoUrl, account, title, description } = taskData;
  
  // 发送进度更新
  wsClient.sendProgress(taskData.taskId, 10, '开始下载视频');
  
  // 执行发布逻辑
  // ...
  
  wsClient.sendProgress(taskData.taskId, 50, '视频上传中');
  // ...
  
  wsClient.sendProgress(taskData.taskId, 100, '发布完成');
  
  return { success: true, message: '视频发布成功' };
});

// 注册文章发布任务处理器
wsClient.registerTaskHandler('publish_article', async (taskData) => {
  // 处理文章发布
  return { success: true };
});
```

## 消息协议

### 客户端 → 服务器

#### 1. 认证消息 (auth)

```javascript
{
  type: 'auth',
  deviceId: 'device-xxx',
  timestamp: 1234567890,
  accounts: [
    { phone: '13800138000', platform: '抖音' },
    { phone: '13900139000', platform: '快手' }
  ]
}
```

#### 2. 任务确认 (ack)

```javascript
{
  taskId: 'task-xxx',
  timestamp: 1234567890
}
```

#### 3. 进度更新 (progress)

```javascript
{
  taskId: 'task-xxx',
  progress: 50,  // 0-100
  message: '视频上传中',
  timestamp: 1234567890
}
```

#### 4. 任务结果 (result)

```javascript
{
  taskId: 'task-xxx',
  status: 'success',  // 'success' | 'failed'
  data: {
    message: '发布成功',
    videoId: 'xxx'
  },
  timestamp: 1234567890
}
```

#### 5. 状态同步 (status)

```javascript
{
  onlineAccounts: 5,
  queueLength: 3,
  timestamp: 1234567890
}
```

#### 6. 心跳 (heartbeat)

```javascript
{
  timestamp: 1234567890
}
```

### 服务器 → 客户端

#### 1. 任务下发 (task)

```javascript
{
  taskId: 'task-xxx',
  type: 'publish_video',  // 任务类型
  data: {
    videoUrl: 'http://...',
    account: '13800138000',
    platform: '抖音',
    title: '视频标题',
    description: '视频描述'
  },
  timestamp: 1234567890
}
```

#### 2. 服务器消息 (message)

```javascript
{
  type: 'info',
  message: '服务器通知消息'
}
```

## API 参考

### WebSocketClient 类

#### 方法

- `connect()` - 连接到服务器
- `disconnect()` - 断开连接
- `registerTaskHandler(taskType, handler)` - 注册任务处理器
- `sendProgress(taskId, progress, message)` - 发送进度更新
- `sendStatus(statusData)` - 发送客户端状态
- `getConnectionStatus()` - 获取连接状态

#### 示例

```javascript
const { getWebSocketClient } = require('./services/websocketClient');

const wsClient = getWebSocketClient();

// 连接服务器
wsClient.connect();

// 注册任务处理器
wsClient.registerTaskHandler('my_task', async (taskData) => {
  // 处理任务
  return { success: true };
});

// 发送状态
wsClient.sendStatus({
  onlineAccounts: 5,
  queueLength: 2
});

// 获取连接状态
const status = wsClient.getConnectionStatus();
console.log(status);
// { isConnected: true, socketId: 'xxx', reconnectAttempts: 0 }

// 断开连接
wsClient.disconnect();
```

## 日志

WebSocket 客户端会输出详细的日志信息：

```
[WebSocket] 正在连接到服务器: http://localhost:3000
[WebSocket] 连接成功, Socket ID: abc123
[WebSocket] 发送认证信息: {...}
[WebSocket] 心跳已启动，间隔: 30000ms
[WebSocket] 收到发布任务: {...}
[WebSocket] 已发送任务确认: task-xxx
[WebSocket] 已发送进度更新: task-xxx, 50%
[WebSocket] 已发送任务结果: task-xxx, 状态: success
```

## 故障排查

### 1. 无法连接到服务器

- 检查服务器地址配置是否正确
- 确认服务器是否正常运行
- 检查网络连接和防火墙设置

### 2. 频繁断线重连

- 检查网络稳定性
- 调整心跳间隔配置
- 查看服务器日志

### 3. 任务处理失败

- 检查任务处理器是否正确注册
- 查看任务数据格式是否正确
- 检查任务处理逻辑中的错误

## 最佳实践

1. **任务处理器应该是异步的**：使用 `async/await` 处理异步操作
2. **及时发送进度更新**：让服务器和用户了解任务执行状态
3. **错误处理**：捕获并处理任务执行中的错误
4. **资源清理**：任务完成后清理临时文件和资源
5. **日志记录**：记录关键操作和错误信息

## 示例：完整的视频发布流程

```javascript
wsClient.registerTaskHandler('publish_video', async (taskData) => {
  const { taskId, videoUrl, account, platform, title } = taskData;
  
  try {
    // 1. 下载视频
    wsClient.sendProgress(taskId, 10, '开始下载视频');
    const videoPath = await downloadVideo(videoUrl);
    
    // 2. 检查账号登录状态
    wsClient.sendProgress(taskId, 30, '检查账号登录状态');
    const isLoggedIn = await checkAccountLogin(account, platform);
    if (!isLoggedIn) {
      throw new Error('账号未登录');
    }
    
    // 3. 上传视频
    wsClient.sendProgress(taskId, 50, '上传视频中');
    const uploadResult = await uploadVideo(videoPath, account, platform);
    
    // 4. 填写视频信息
    wsClient.sendProgress(taskId, 80, '填写视频信息');
    await fillVideoInfo(title, description);
    
    // 5. 发布
    wsClient.sendProgress(taskId, 90, '正在发布');
    const publishResult = await publishVideo();
    
    // 6. 清理临时文件
    wsClient.sendProgress(taskId, 100, '发布完成');
    await cleanupTempFiles(videoPath);
    
    return {
      success: true,
      videoId: publishResult.videoId,
      message: '视频发布成功'
    };
    
  } catch (error) {
    console.error('视频发布失败:', error);
    throw error;
  }
});
```

## 相关文件

- `src/main/services/websocketClient.js` - WebSocket 客户端服务
- `src/main/config/websocket.config.js` - 配置文件
- `src/main/index.js` - 主进程入口（初始化连接）
