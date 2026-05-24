/**
 * WebSocket 客户端配置
 */

module.exports = {
  // WebSocket 服务器地址
  serverUrl: process.env.WS_SERVER_URL || 'http://localhost:3000',

  // Socket.IO 路径（如果服务器使用自定义路径）
  path: process.env.WS_SERVER_PATH || '/api/socket',

  // 客户端类型标识
  clientType: process.env.WS_CLIENT_TYPE || 'matrix_pc_client',

  // 重连配置
  reconnection: {
    enabled: true,
    delay: 1000, // 初始重连延迟（毫秒）
    delayMax: 5000, // 最大重连延迟（毫秒）
    attempts: 10, // 最大重连次数
  },

  // 连接超时（毫秒）
  timeout: 10000,

  // 心跳间隔（毫秒）
  heartbeatInterval: 30000,

  // 传输方式优先级
  transports: ['websocket', 'polling'],

  // 是否在启动时自动连接
  autoConnect: true,
};
