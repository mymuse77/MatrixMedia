# WebSocket 接口文档 - 高优先级核心功能

## 概述

本文档描述了 MatrixMedia 客户端通过 WebSocket 暴露的核心业务接口。这些接口允许 Web 端远程控制客户端进行账号管理、视频发布等操作。

**服务器地址**: `http://localhost:3000`  
**Socket.IO 路径**: `/api/socket`  
**完整连接地址**: `ws://localhost:3000/api/socket/?EIO=4&transport=websocket`

---

## 通用消息格式

### 请求格式（Web → 客户端）

所有任务请求通过 `task` 事件发送：

```javascript
socket.emit('task', {
  taskId: 'task-xxx',           // 唯一任务ID
  type: 'task_type',            // 任务类型
  data: {                       // 任务数据
    // 具体字段根据任务类型而定
  }
});
```

### 响应格式（客户端 → Web）

#### 1. 任务确认（ACK）
客户端收到任务后立即发送：
```javascript
socket.on('ack', (data) => {
  // data: { taskId: 'task-xxx', timestamp: 1234567890 }
});
```

#### 2. 进度更新
任务执行过程中实时上报：
```javascript
socket.on('progress', (data) => {
  // data: {
  //   taskId: 'task-xxx',
  //   progress: 50,           // 0-100
  //   message: '正在上传视频',
  //   timestamp: 1234567890
  // }
});
```

#### 3. 任务结果
任务完成后发送最终结果：
```javascript
socket.on('result', (data) => {
  // data: {
  //   taskId: 'task-xxx',
  //   status: 'success',      // 'success' | 'failed'
  //   data: { ... },          // 结果数据
  //   timestamp: 1234567890
  // }
});
```

---

## 接口列表

### 1. 新增媒体账号

**任务类型**: `add_account`

**描述**: 在客户端创建新的媒体平台账号记录。

**请求参数**:
```javascript
{
  taskId: 'task-001',
  type: 'add_account',
  data: {
    phone: '13800138000',     // 必填：手机号
    platform: '抖音'          // 必填：平台名称
  }
}
```

**支持的平台**:
- `抖音` (dy, douyin)
- `快手` (ks, kuaishou)
- `哔哩哔哩` (blbl, bilibili)
- `百家号` (bjh)
- `头条` (tt, toutiao)
- `视频号` (sph)
- `掘金` (juejin, jj)
- `小红书` (xhs)

**响应数据**:
```javascript
{
  taskId: 'task-001',
  status: 'success',
  data: {
    success: true,
    account: {
      phone: '13800138000',
      platform: '抖音',
      partition: 'persist:13800138000抖音',
      url: 'https://creator.douyin.com',
      createTime: 1234567890
    },
    message: '账号添加成功，请在客户端完成登录'
  }
}
```

**进度事件**:
- 10%: 正在创建账号
- 50%: 正在保存账号信息
- 100%: 账号创建成功

**错误示例**:
```javascript
{
  taskId: 'task-001',
  status: 'failed',
  data: {
    error: '不支持的平台: 微博'
  }
}
```

**使用示例**:
```javascript
const taskId = 'task-' + Date.now();

socket.emit('task', {
  taskId,
  type: 'add_account',
  data: {
    phone: '13800138000',
    platform: '抖音'
  }
});

socket.on('progress', (data) => {
  if (data.taskId === taskId) {
    console.log(`进度: ${data.progress}% - ${data.message}`);
  }
});

socket.on('result', (data) => {
  if (data.taskId === taskId) {
    if (data.status === 'success') {
      console.log('账号创建成功:', data.data.account);
    } else {
      console.error('创建失败:', data.data.error);
    }
  }
});
```

---

### 2. 查询账号列表

**任务类型**: `get_accounts`

**描述**: 获取客户端所有已添加的媒体账号列表。

**请求参数**:
```javascript
{
  taskId: 'task-002',
  type: 'get_accounts',
  data: {
    platform: '抖音'          // 可选：按平台筛选
  }
}
```

**响应数据**:
```javascript
{
  taskId: 'task-002',
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
        createTime: 1234567890,
        isLoggedIn: false       // 登录状态（待实现）
      },
      {
        id: 'acc-002',
        phone: '13900139000',
        platform: '快手',
        partition: 'persist:13900139000快手',
        url: 'https://cp.kuaishou.com',
        createTime: 1234567891,
        isLoggedIn: false
      }
    ],
    total: 2
  }
}
```

**进度事件**:
- 50%: 正在查询账号列表
- 100%: 查询完成

**使用示例**:
```javascript
// 查询所有账号
socket.emit('task', {
  taskId: 'task-002',
  type: 'get_accounts',
  data: {}
});

// 查询指定平台账号
socket.emit('task', {
  taskId: 'task-003',
  type: 'get_accounts',
  data: {
    platform: '抖音'
  }
});
```

---

### 3. 删除媒体账号

**任务类型**: `delete_account`

**描述**: 删除指定的媒体账号记录。

**请求参数**:
```javascript
{
  taskId: 'task-004',
  type: 'delete_account',
  data: {
    id: 'acc-001',            // 必填：账号ID
    phone: '13800138000',     // 必填：手机号
    platform: '抖音',         // 必填：平台名称
    date: '2026-05-20'        // 必填：账号创建日期
  }
}
```

**响应数据**:
```javascript
{
  taskId: 'task-004',
  status: 'success',
  data: {
    success: true,
    message: '账号删除成功'
  }
}
```

**进度事件**:
- 50%: 正在删除账号
- 100%: 账号删除成功

**错误示例**:
```javascript
{
  taskId: 'task-004',
  status: 'failed',
  data: {
    error: '未找到 id=acc-001 的记录'
  }
}
```

---

### 4. 发布视频任务

**任务类型**: `publish_video`

**描述**: 发布视频到指定媒体平台账号。

**请求参数**:
```javascript
{
  taskId: 'task-005',
  type: 'publish_video',
  data: {
    phone: '13800138000',           // 必填：手机号
    platform: '抖音',               // 必填：平台名称
    partition: 'persist:13800138000抖音',  // 可选：会自动生成
    
    // 视频来源（二选一）
    videoUrl: 'http://example.com/video.mp4',  // 视频URL（暂不支持）
    videoPath: 'D:/videos/demo.mp4',           // 本地视频路径
    
    // 视频信息
    title: '视频标题',              // 必填：视频标题
    description: '视频描述',        // 可选：视频描述
    tags: '标签1 标签2',           // 可选：标签（空格分隔）
    coverPath: 'D:/covers/cover.jpg',  // 可选：封面图路径
    location: '北京'               // 可选：地理位置
  }
}
```

**响应数据**:
```javascript
{
  taskId: 'task-005',
  status: 'success',
  data: {
    success: true,
    message: '视频发布成功',
    data: {
      // 发布结果详情
    }
  }
}
```

**进度事件**:
- 5%: 准备发布任务
- 10%: 正在下载视频（如果是URL）
- 20%: 正在准备发布数据
- 30%: 正在启动发布流程
- 30-100%: 发布中（具体进度由 Puppeteer 上报）
- 100%: 发布成功

**错误示例**:
```javascript
{
  taskId: 'task-005',
  status: 'failed',
  data: {
    error: '视频文件不存在: D:/videos/demo.mp4'
  }
}
```

**使用示例**:
```javascript
socket.emit('task', {
  taskId: 'task-005',
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

socket.on('progress', (data) => {
  if (data.taskId === 'task-005') {
    console.log(`发布进度: ${data.progress}% - ${data.message}`);
    // 可以在UI上显示进度条
  }
});

socket.on('result', (data) => {
  if (data.taskId === 'task-005') {
    if (data.status === 'success') {
      console.log('视频发布成功！');
    } else {
      console.error('发布失败:', data.data.error);
    }
  }
});
```

**注意事项**:
1. 视频文件必须存在于客户端本地
2. 暂不支持从 URL 下载视频（待实现）
3. 发布前请确保账号已登录
4. 不同平台的字段要求可能不同

---

### 5. 查询发布历史

**任务类型**: `get_publish_history`

**描述**: 查询历史发布记录。

**请求参数**:
```javascript
{
  taskId: 'task-006',
  type: 'get_publish_history',
  data: {
    page: 1,                  // 可选：页码，默认1
    pageSize: 10,             // 可选：每页数量，默认10
    platform: '抖音',         // 可选：按平台筛选
    status: 'success'         // 可选：按状态筛选 (success|failed|publishing|scheduled)
  }
}
```

**响应数据**:
```javascript
{
  taskId: 'task-006',
  status: 'success',
  data: {
    success: true,
    data: {
      '2026-05-20': [
        {
          id: 'pub-001',
          platform: '抖音',
          phone: '13800138000',
          textOtherName: '视频标题',
          textType: 'local',
          selectedFile: 'demo.mp4',
          publishStatus: 'success',
          publishAttemptCount: 1,
          publishSuccessCount: 1,
          publishFailCount: 0,
          lastPublishMessage: '发布成功',
          lastPublishAt: 1234567890,
          createTime: 1234567890
        }
      ],
      '2026-05-19': [
        // ...
      ]
    },
    totalDays: 30,
    page: 1,
    pageSize: 10
  }
}
```

**进度事件**:
- 50%: 正在查询发布历史
- 100%: 查询完成

**使用示例**:
```javascript
// 查询所有发布记录
socket.emit('task', {
  taskId: 'task-006',
  type: 'get_publish_history',
  data: {
    page: 1,
    pageSize: 20
  }
});

// 查询抖音平台的成功记录
socket.emit('task', {
  taskId: 'task-007',
  type: 'get_publish_history',
  data: {
    platform: '抖音',
    status: 'success'
  }
});
```

---

### 6. 获取客户端状态

**任务类型**: `get_client_status`

**描述**: 获取客户端当前运行状态。

**请求参数**:
```javascript
{
  taskId: 'task-008',
  type: 'get_client_status',
  data: {}
}
```

**响应数据**:
```javascript
{
  taskId: 'task-008',
  status: 'success',
  data: {
    success: true,
    status: {
      isOnline: true,
      accounts: {
        total: 10,            // 总账号数
        loggedIn: 8,          // 已登录账号数（待实现）
        loggedOut: 2          // 未登录账号数
      },
      queue: {
        pending: 3,           // 待处理任务数（待实现）
        processing: 1         // 正在处理任务数（待实现）
      },
      lastHeartbeat: 1234567890
    }
  }
}
```

**进度事件**:
- 50%: 正在获取客户端状态
- 100%: 状态获取完成

**使用示例**:
```javascript
// 定期查询客户端状态
setInterval(() => {
  socket.emit('task', {
    taskId: 'task-status-' + Date.now(),
    type: 'get_client_status',
    data: {}
  });
}, 30000);  // 每30秒查询一次

socket.on('result', (data) => {
  if (data.taskId.startsWith('task-status-')) {
    const status = data.data.status;
    console.log('客户端状态:', status);
    // 更新UI显示
  }
});
```

---

## 完整使用示例

### Web 端完整示例

```javascript
const { io } = require('socket.io-client');

// 连接到客户端
const socket = io('http://localhost:3000', {
  path: '/api/socket',
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: 5
});

// 连接成功
socket.on('connect', () => {
  console.log('已连接到客户端:', socket.id);
  
  // 1. 查询账号列表
  queryAccounts();
});

// 任务确认
socket.on('ack', (data) => {
  console.log('任务已接收:', data.taskId);
});

// 进度更新
socket.on('progress', (data) => {
  console.log(`[${data.taskId}] ${data.progress}% - ${data.message}`);
  // 更新UI进度条
  updateProgressBar(data.taskId, data.progress, data.message);
});

// 任务结果
socket.on('result', (data) => {
  console.log(`[${data.taskId}] 完成:`, data.status);
  
  if (data.status === 'success') {
    handleSuccess(data);
  } else {
    handleError(data);
  }
});

// 断开连接
socket.on('disconnect', () => {
  console.log('与客户端断开连接');
});

// 查询账号列表
function queryAccounts() {
  const taskId = 'task-' + Date.now();
  
  socket.emit('task', {
    taskId,
    type: 'get_accounts',
    data: {}
  });
}

// 添加账号
function addAccount(phone, platform) {
  const taskId = 'task-' + Date.now();
  
  socket.emit('task', {
    taskId,
    type: 'add_account',
    data: { phone, platform }
  });
  
  return taskId;
}

// 发布视频
function publishVideo(phone, platform, videoPath, title, description) {
  const taskId = 'task-' + Date.now();
  
  socket.emit('task', {
    taskId,
    type: 'publish_video',
    data: {
      phone,
      platform,
      videoPath,
      title,
      description
    }
  });
  
  return taskId;
}

// 使用示例
setTimeout(() => {
  // 添加账号
  addAccount('13800138000', '抖音');
  
  // 等待账号添加完成后发布视频
  setTimeout(() => {
    publishVideo(
      '13800138000',
      '抖音',
      'D:/videos/demo.mp4',
      '我的视频',
      '视频描述'
    );
  }, 5000);
}, 2000);
```

---

## 错误处理

### 常见错误码

| 错误信息 | 原因 | 解决方法 |
|---------|------|---------|
| `不支持的平台: xxx` | 平台名称错误 | 使用支持的平台名称 |
| `缺少必填字段: xxx` | 请求参数不完整 | 检查并补充必填参数 |
| `视频文件不存在: xxx` | 视频路径错误 | 确认视频文件存在 |
| `未找到 id=xxx 的记录` | 账号不存在 | 先查询账号列表确认ID |
| `添加账号失败` | 数据保存失败 | 检查客户端日志 |

### 错误处理示例

```javascript
socket.on('result', (data) => {
  if (data.status === 'failed') {
    const error = data.data.error || '未知错误';
    
    // 根据错误类型处理
    if (error.includes('不支持的平台')) {
      alert('平台名称错误，请选择正确的平台');
    } else if (error.includes('视频文件不存在')) {
      alert('视频文件不存在，请检查路径');
    } else if (error.includes('缺少必填字段')) {
      alert('请填写完整信息');
    } else {
      alert('操作失败: ' + error);
    }
  }
});
```

---

## 最佳实践

### 1. 任务ID管理
```javascript
// 使用时间戳 + 随机数生成唯一ID
function generateTaskId() {
  return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
```

### 2. 进度跟踪
```javascript
const taskProgress = new Map();

socket.on('progress', (data) => {
  taskProgress.set(data.taskId, {
    progress: data.progress,
    message: data.message,
    timestamp: data.timestamp
  });
  
  // 更新UI
  updateUI(data.taskId);
});
```

### 3. 超时处理
```javascript
function sendTaskWithTimeout(taskData, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('任务超时'));
    }, timeout);
    
    socket.emit('task', taskData);
    
    socket.once('result', (data) => {
      if (data.taskId === taskData.taskId) {
        clearTimeout(timer);
        if (data.status === 'success') {
          resolve(data.data);
        } else {
          reject(new Error(data.data.error));
        }
      }
    });
  });
}
```

### 4. 批量操作
```javascript
async function batchPublishVideos(videos) {
  const results = [];
  
  for (const video of videos) {
    try {
      const taskId = generateTaskId();
      const result = await sendTaskWithTimeout({
        taskId,
        type: 'publish_video',
        data: video
      });
      results.push({ success: true, video, result });
      
      // 间隔5分钟
      await sleep(5 * 60 * 1000);
    } catch (error) {
      results.push({ success: false, video, error: error.message });
    }
  }
  
  return results;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

---

## 附录

### 平台配置参考

| 平台 | 别名 | 上传地址 |
|-----|------|---------|
| 抖音 | dy, douyin | https://creator.douyin.com |
| 快手 | ks, kuaishou | https://cp.kuaishou.com |
| 哔哩哔哩 | blbl, bilibili | https://member.bilibili.com |
| 百家号 | bjh | https://baijiahao.baidu.com |
| 头条 | tt, toutiao | https://mp.toutiao.com |
| 视频号 | sph | https://channels.weixin.qq.com |
| 掘金 | juejin, jj | https://juejin.cn |

### 发布状态说明

| 状态 | 说明 |
|-----|------|
| `scheduled` | 已定时，等待发布 |
| `publishing` | 发布中 |
| `success` | 发布成功 |
| `failed` | 发布失败 |

---

## 更新日志

### v1.0.0 (2026-05-20)
- ✅ 新增媒体账号
- ✅ 查询账号列表
- ✅ 删除媒体账号
- ✅ 发布视频任务
- ✅ 查询发布历史
- ✅ 获取客户端状态

### 待实现功能
- [ ] 账号登录状态检查
- [ ] 从URL下载视频
- [ ] 任务队列状态统计
- [ ] 发布文章任务
- [ ] 批量发布视频
- [ ] 定时发布管理
