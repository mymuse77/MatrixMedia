# 人工验证通知接口

统一入口：`notifyVerificationRequired(event)`。目前接入抖音主题搜索、封面读取、评论读取，以及视频发布最终确认阶段的验证提示。弹窗继续使用原有发布方法；通知异步发送，失败不打断人工验证或平台任务。

事件包含 source、taskId、clientId、account、challengeType 和 windowShown。challengeType 为 qr_login、login、sms、captcha 或 verification。没有验证码、二维码图片、Cookie、执行令牌、抓取正文或平台提供的 URL。手机号形式的账号显示名脱敏。邮件和短信只提醒用户到运行客户端的电脑完成验证。

默认仅启用系统桌面通知。邮件和短信已提供可注入适配器接口，尚未接入具体供应商、配置界面或真实收件人。它们不是 HTTP 控制接口；服务配置仅允许由可信主进程代码设置，不能从抓取页面、任务请求或 Cookie 中选择接收地址。

## 接入邮件或短信服务商

在主进程初始化中调用一次配置函数。以下是开发接入示例，供应商函数和账号收件人映射须由项目的可信配置提供，不是现成凭据：

```js
import {configureVerificationNotifications} from './verificationNotifications';
const {createEmailTransport, createSmsTransport} = require('./verificationNotifications/core');

configureVerificationNotifications({
  enabledChannels: ['desktop', 'email', 'sms'],
  transports: {
    email: createEmailTransport(sendEmailFromConfiguredProvider),
    sms: createSmsTransport(sendSmsFromConfiguredProvider),
  },
  resolveRoutes: event => [
    {channel: 'desktop'},
    ...(trustedRoutesByAccount.get(event.accountKey) || []),
  ],
});
```

路由示例：`{channel: 'email', recipient: 'ops@example.test'}` 或 `{channel: 'sms', recipient: '+8613800000000'}`。只为配置中明确绑定的发送账号设置收件人；没有绑定时不回退到其他用户。accountKey 是平台与本地规范账号名称的 SHA-256，用于读取和发布流程共用去重；account.id 在调用方可提供时一并保留。

邮件供应商收到 `{to, subject, text, eventId, idempotencyKey, signal}`；短信供应商收到 `{to, params: {account, platform, verification}, eventId, idempotencyKey, signal}`。短信模板编号、签名和密钥留在供应商适配器的可信配置中。供应商应处理 AbortSignal，并返回 `{accepted: true}` 表示服务商已接收请求；不等同于邮件或短信最终送达。

## 去重和失败处理

每个账号、渠道、收件人 5 分钟内最多尝试一次，每小时最多 6 次；在途调用不重复。不同渠道独立执行，一个渠道失败不阻塞其他渠道。单次通知默认 5 秒超时，不自动重试，避免响应丢失后重复计费。结果状态包括 accepted、failed、timeout、suppressed、rate_limited、disabled 和 unconfigured；供应商错误原文不会进入任务回执或日志。

频率记录目前保存在客户端进程内，重启会清空；没有持久化通知队列、送达回执或跨客户端去重。后续具体服务商接入时可使用 idempotencyKey 并补充其回执能力。不要将业务任务 outbox 当作通知发送队列。

本地验证：`node scripts/test-verification-notifications.js` 和 `node scripts/test-outreach-verification.js`。使用模拟邮件/短信供应商，不产生真实外发或费用。

## 操作日志

统一 JSONL 日志位于 `app.getPath('userData')/logs/operations.jsonl`，每行一条结构化事件。单文件默认 5 MiB，轮转保留 5 份历史文件。日志包含时间、任务/追踪/通知/动作 ID、脱敏账号、平台、操作来源、状态和错误码。收件人仅记录 SHA-256 摘要，不记录通知正文、验证码、二维码、Cookie、令牌或服务商密钥。日志写入失败会输出明确的控制台错误，不伪装记录成功，不阻断人工验证。

覆盖读取开始/完成/失败/取消、验证检测/窗口显示/验证界面消失、窗口保留、通知请求/发送尝试/各渠道结果（含去重、限流和未配置）、任务接收/执行/完成、互动动作意图/结果、取消请求和服务端持久回执。视频发布的验证检测、弹窗和平台确认也会记录；原有任务账本继续负责幂等与重启恢复，文本日志用于排查，不替代账本，也不是防篡改审计系统。

验证命令：`node scripts/test-operation-audit.js`，检查重开可读、关联字段、脱敏、轮转及磁盘写入失败。
