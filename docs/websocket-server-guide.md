# WebSocket 服务端发送格式指南

## 概述

本文档说明服务端（Web后端）如何向客户端发送任务请求。客户端监听 `task` 事件来接收任务。

---

## 服务端代码示例

### Node.js + Socket.IO 服务端

```javascript
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  path: '/api/socket',
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// 存储所有连接的客户端
const clients = new Map();

io.on('connection', (socket) => {
  console.log('客户端连接:', socket.id);
  
  // 保存客户端连接
  clients.set(socket.id, {
    socket,
    connectedAt: Date.now(),
    deviceId: null,
    accounts: []
  });

  // 接收客户端认证信息
  socket.on('auth', (data) => {
    console.log('客户端认证:', data);
    const client = clients.get(socket.id);
    if (client) {
      client.deviceId = data.deviceId;
      client.accounts = data.accounts || [];
    }
  });

  // 接收任务确认
  socket.on('ack', (data) => {
    console.log('任务已确认:', data.taskId);
  });

  // 接收进度更新
  socket.on('progress', (data) => {
    console.log(`任务进度 [${data.taskId}]: ${data.progress}% - ${data.message}`);
    // 可以转发给Web前端
  });

  // 接收任务结果
  socket.on('result', (data) => {
    console.log(`任务完成 [${data.taskId}]:`, data.status);
    // 可以保存到数据库或转发给Web前端
  });

  // 接收心跳
  socket.on('heartbeat', (data) => {
    console.log('收到心跳:', socket.id);
  });

  // 客户端断开
  socket.on('disconnect', () => {
    console.log('客户端断开:', socket.id);
    clients.delete(socket.id);
  });
});

server.listen(3000, () => {
  console.log('WebSocket 服务器运行在 http://localhost:3000');
});

// ============ 以下是发送任务的函数 ============

/**
 * 生成唯一任务ID
 */
function generateTaskId() {
  return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 向指定客户端发送任务
 */
function sendTaskToClient(socketId, taskType, taskData) {
  const client = clients.get(socketId);
  if (!client) {
    throw new Error('客户端不存在');
  }

  const taskId = generateTaskId();
  const task = {
    taskId,
    type: taskType,
    data: taskData
  };

  console.log(`发送任务到客户端 [${socketId}]:`, task);
  client.socket.emit('task', task);

  return taskId;
}

/**
 * 向所有客户端广播任务
 */
function broadcastTask(taskType, taskData) {
  const taskIds = [];
  
  clients.forEach((client, socketId) => {
    const taskId = sendTaskToClient(socketId, taskType, taskData);
    taskIds.push({ socketId, taskId });
  });

  return taskIds;
}

// ============ 导出API接口 ============

/**
 * 1. 新增媒体账号
 */
app.post('/api/account/add', (req, res) => {
  const { phone, platform, clientId } = req.body;

  if (!phone || !platform) {
    return res.status(400).json({ error: '缺少必填字段' });
  }

  try {
    // 如果指定了客户端ID，发送给指定客户端
    const socketId = clientId || clients.keys().next().value;
    
    if (!socketId) {
      return res.status(503).json({ error: '没有可用的客户端' });
    }

    const taskId = sendTaskToClient(socketId, 'add_account', {
      phone,
      platform
    });

    res.json({
      success: true,
      taskId,
      socketId,
      message: '任务已发送到客户端'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 2. 查询账号列表
 */
app.get('/api/accounts', (req, res) => {
  const { platform, clientId } = req.query;

  try {
    const socketId = clientId || clients.keys().next().value;
    
    if (!socketId) {
      return res.status(503).json({ error: '没有可用的客户端' });
    }

    const taskId = sendTaskToClient(socketId, 'get_accounts', {
      platform: platform || undefined
    });

    res.json({
      success: true,
      taskId,
      socketId,
      message: '任务已发送到客户端'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 3. 删除媒体账号
 */
app.delete('/api/account/:id', (req, res) => {
  const { id } = req.params;
  const { phone, platform, date, clientId } = req.body;

  if (!phone || !platform || !date) {
    return res.status(400).json({ error: '缺少必填字段' });
  }

  try {
    const socketId = clientId || clients.keys().next().value;
    
    if (!socketId) {
      return res.status(503).json({ error: '没有可用的客户端' });
    }

    const taskId = sendTaskToClient(socketId, 'delete_account', {
      id,
      phone,
      platform,
      date
    });

    res.json({
      success: true,
      taskId,
      socketId,
      message: '任务已发送到客户端'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 4. 发布视频
 */
app.post('/api/video/publish', (req, res) => {
  const {
    phone,
    platform,
    videoPath,
    title,
    description,
    tags,
    coverPath,
    location,
    clientId
  } = req.body;

  if (!phone || !platform || !videoPath || !title) {
    return res.status(400).json({ error: '缺少必填字段' });
  }

  try {
    const socketId = clientId || clients.keys().next().value;
    
    if (!socketId) {
      return res.status(503).json({ error: '没有可用的客户端' });
    }

    const taskId = sendTaskToClient(socketId, 'publish_video', {
      phone,
      platform,
      videoPath,
      title,
      description,
      tags,
      coverPath,
      location
    });

    res.json({
      success: true,
      taskId,
      socketId,
      message: '发布任务已发送到客户端'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 5. 查询发布历史
 */
app.get('/api/publish/history', (req, res) => {
  const { page, pageSize, platform, status, clientId } = req.query;

  try {
    const socketId = clientId || clients.keys().next().value;
    
    if (!socketId) {
      return res.status(503).json({ error: '没有可用的客户端' });
    }

    const taskId = sendTaskToClient(socketId, 'get_publish_history', {
      page: parseInt(page) || 1,
      pageSize: parseInt(pageSize) || 10,
      platform: platform || undefined,
      status: status || undefined
    });

    res.json({
      success: true,
      taskId,
      socketId,
      message: '任务已发送到客户端'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 6. 获取客户端状态
 */
app.get('/api/client/status', (req, res) => {
  const { clientId } = req.query;

  try {
    const socketId = clientId || clients.keys().next().value;
    
    if (!socketId) {
      return res.status(503).json({ error: '没有可用的客户端' });
    }

    const taskId = sendTaskToClient(socketId, 'get_client_status', {});

    res.json({
      success: true,
      taskId,
      socketId,
      message: '任务已发送到客户端'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取所有在线客户端列表
 */
app.get('/api/clients', (req, res) => {
  const clientList = [];
  
  clients.forEach((client, socketId) => {
    clientList.push({
      socketId,
      deviceId: client.deviceId,
      connectedAt: client.connectedAt,
      accounts: client.accounts
    });
  });

  res.json({
    success: true,
    clients: clientList,
    total: clientList.length
  });
});
```

---

## 具体示例

### 1. 新增媒体账号

**HTTP 请求**:
```bash
POST http://localhost:3000/api/account/add
Content-Type: application/json

{
  "phone": "13800138000",
  "platform": "抖音"
}
```

**服务端发送给客户端**:
```javascript
socket.emit('task', {
  taskId: 'task-1716192000000-abc123',
  type: 'add_account',
  data: {
    phone: '13800138000',
    platform: '抖音'
  }
});
```

**HTTP 响应**:
```json
{
  "success": true,
  "taskId": "task-1716192000000-abc123",
  "socketId": "socket-xyz789",
  "message": "任务已发送到客户端"
}
```

**客户端响应流程**:
```javascript
// 1. 客户端发送 ACK
socket.emit('ack', {
  taskId: 'task-1716192000000-abc123',
  timestamp: 1716192001000
});

// 2. 客户端发送进度
socket.emit('progress', {
  taskId: 'task-1716192000000-abc123',
  progress: 10,
  message: '正在创建账号',
  timestamp: 1716192002000
});

socket.emit('progress', {
  taskId: 'task-1716192000000-abc123',
  progress: 50,
  message: '正在保存账号信息',
  timestamp: 1716192003000
});

// 3. 客户端发送最终结果
socket.emit('result', {
  taskId: 'task-1716192000000-abc123',
  status: 'success',
  data: {
    success: true,
    account: {
      phone: '13800138000',
      platform: '抖音',
      partition: 'persist:13800138000抖音',
      url: 'https://creator.douyin.com',
      createTime: 1716192004000
    },
    message: '账号添加成功，请在客户端完成登录'
  },
  timestamp: 1716192004000
});
```

---

### 2. 查询账号列表

**HTTP 请求**:
```bash
GET http://localhost:3000/api/accounts?platform=抖音
```

**服务端发送给客户端**:
```javascript
socket.emit('task', {
  taskId: 'task-1716192010000-def456',
  type: 'get_accounts',
  data: {
    platform: '抖音'
  }
});
```

**客户端响应**:
```javascript
socket.emit('result', {
  taskId: 'task-1716192010000-def456',
  status: 'success',
  data: {
    success: true,
    accounts: [
      {
        id: 'acc-001',
        phone: '13800138000',
        platform: '抖音',
        partition: 'persist:13800138000抖音',
        url: 'https://creator.douyin.com',
        createTime: 1716192004000,
        isLoggedIn: false
      }
    ],
    total: 1
  },
  timestamp: 1716192011000
});
```

---

### 3. 发布视频

**HTTP 请求**:
```bash
POST http://localhost:3000/api/video/publish
Content-Type: application/json

{
  "phone": "13800138000",
  "platform": "抖音",
  "videoPath": "D:/videos/demo.mp4",
  "title": "我的第一个视频",
  "description": "这是一个测试视频",
  "tags": "测试 演示",
  "location": "北京"
}
```

**服务端发送给客户端**:
```javascript
socket.emit('task', {
  taskId: 'task-1716192020000-ghi789',
  type: 'publish_video',
  data: {
    phone: '13800138000',
    platform: '抖音',
    videoPath: 'D:/videos/demo.mp4',
    title: '我的第一个视频',
    description: '这是一个测试视频',
    tags: '测试 演示',
    location: '北京'
  }
});
```

**客户端响应（多次进度更新）**:
```javascript
// 进度 1
socket.emit('progress', {
  taskId: 'task-1716192020000-ghi789',
  progress: 5,
  message: '准备发布任务',
  timestamp: 1716192021000
});

// 进度 2
socket.emit('progress', {
  taskId: 'task-1716192020000-ghi789',
  progress: 20,
  message: '正在准备发布数据',
  timestamp: 1716192022000
});

// 进度 3
socket.emit('progress', {
  taskId: 'task-1716192020000-ghi789',
  progress: 50,
  message: '正在上传视频',
  timestamp: 1716192030000
});

// 进度 4
socket.emit('progress', {
  taskId: 'task-1716192020000-ghi789',
  progress: 80,
  message: '正在填写视频信息',
  timestamp: 1716192040000
});

// 最终结果
socket.emit('result', {
  taskId: 'task-1716192020000-ghi789',
  status: 'success',
  data: {
    success: true,
    message: '视频发布成功'
  },
  timestamp: 1716192050000
});
```

---

## 前端调用示例

### Vue.js 示例

```vue
<template>
  <div>
    <h2>添加账号</h2>
    <input v-model="phone" placeholder="手机号" />
    <select v-model="platform">
      <option value="抖音">抖音</option>
      <option value="快手">快手</option>
      <option value="哔哩哔哩">哔哩哔哩</option>
    </select>
    <button @click="addAccount">添加</button>

    <div v-if="progress.show">
      <p>{{ progress.message }}</p>
      <progress :value="progress.value" max="100"></progress>
    </div>
  </div>
</template>

<script>
import axios from 'axios';

export default {
  data() {
    return {
      phone: '',
      platform: '抖音',
      progress: {
        show: false,
        value: 0,
        message: ''
      }
    };
  },
  methods: {
    async addAccount() {
      try {
        // 1. 发送HTTP请求到服务端
        const response = await axios.post('http://localhost:3000/api/account/add', {
          phone: this.phone,
          platform: this.platform
        });

        const { taskId } = response.data;
        console.log('任务已发送:', taskId);

        // 2. 显示进度
        this.progress.show = true;
        this.progress.value = 0;
        this.progress.message = '任务已发送...';

        // 3. 等待结果（通过轮询或WebSocket监听）
        // 这里需要服务端提供查询任务结果的接口
        this.pollTaskResult(taskId);

      } catch (error) {
        alert('添加失败: ' + error.message);
      }
    },

    async pollTaskResult(taskId) {
      // 轮询查询任务结果
      const interval = setInterval(async () => {
        try {
          const response = await axios.get(`http://localhost:3000/api/task/${taskId}`);
          const { status, progress, message, result } = response.data;

          if (status === 'processing') {
            this.progress.value = progress;
            this.progress.message = message;
          } else if (status === 'success') {
            clearInterval(interval);
            this.progress.value = 100;
            this.progress.message = '添加成功！';
            alert('账号添加成功');
          } else if (status === 'failed') {
            clearInterval(interval);
            alert('添加失败: ' + result.error);
          }
        } catch (error) {
          clearInterval(interval);
          alert('查询失败: ' + error.message);
        }
      }, 1000);
    }
  }
};
</script>
```

---

## 完整的服务端架构

```
Web前端 (Vue/React)
    ↓ HTTP请求
服务端 (Express + Socket.IO)
    ↓ WebSocket (task事件)
客户端 (Electron)
    ↓ WebSocket (ack/progress/result事件)
服务端 (接收并存储结果)
    ↓ HTTP响应 或 WebSocket推送
Web前端 (显示结果)
```

---

## 任务结果存储（可选）

服务端可以将任务结果存储到数据库，供前端查询：

```javascript
const taskResults = new Map();

// 监听客户端结果
socket.on('result', (data) => {
  // 存储结果
  taskResults.set(data.taskId, {
    status: data.status,
    data: data.data,
    timestamp: data.timestamp
  });

  // 可以保存到数据库
  // await db.tasks.update({ taskId: data.taskId }, { result: data });
});

// 提供查询接口
app.get('/api/task/:taskId', (req, res) => {
  const { taskId } = req.params;
  const result = taskResults.get(taskId);

  if (!result) {
    return res.status(404).json({ error: '任务不存在' });
  }

  res.json(result);
});
```

---

## 总结

**服务端发送格式**:
```javascript
socket.emit('task', {
  taskId: '唯一任务ID',
  type: '任务类型',
  data: {
    // 任务参数
  }
});
```

**关键点**:
1. 使用 `socket.emit('task', ...)` 发送任务
2. `taskId` 必须唯一，用于追踪任务
3. `type` 对应客户端注册的处理器
4. `data` 包含任务所需的所有参数
5. 监听客户端的 `ack`、`progress`、`result` 事件获取反馈
