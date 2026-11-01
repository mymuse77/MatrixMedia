# 抖音主题读取与互动任务运行时

由 websocketHandlers 注册 outreach_search、outreach_sync_covers、outreach_sync_comments、outreach_execute 和 outreach_cancel。输入经 schema 严格校验，账号 ID、名称和平台必须与本机记录完全匹配，不能默认选择首个账号。

搜索仅返回文字；封面和评论只处理显式选择的作品。reader.js 是待验证的可见 DOM 读取器，不访问隐藏接口，不导出 Cookie，不下载视频。当前评论结果始终标记 partial，选择器、翻页和楼中楼定位均需真实验证。

生产适配器的所有 supported/verified 标志默认 false；客户端仅公布 outreach.transport.v1，不公布任何 verified 平台能力。外发 execute 保持 UNVERIFIED 阻断，不能将队列和模拟测试当作真实关注、私信、评论或回复已实现。

搜索、封面及评论读取遇到可见验证码或扫码登录界面时，复用视频发布的 revealPublishVerificationWindow 恢复、置顶、显示并聚焦当前账号窗口。任务暂停在当前页面，最长等待 10 分钟；验证界面消失后在原页面继续只读采集，不自动点击验证码、不切换账号或重新提交动作。等待超时保留窗口并提示重新发起，取消任务会关闭窗口。验证通过后取消置顶。验证流程测试：`node scripts/test-outreach-verification.js`；使用模拟页面状态和真实弹窗方法，不触发平台验证码。

每个服务地址和 clientId 使用独立的原子日志文件，保留任务指纹、执行意图、逐项结果和 outbox。一个账号串行执行，与视频发布共用账号互斥锁；后续排队的视频发布优先。任何可能提交但未获得结果的动作在重启后保留待核对，不自动重发。取消只跳过尚未开始的动作，不伪造已在进行动作的取消结果。

只有 BS 提交事务后返回带 domain=outreach、committed=true、准确任务 ID 与执行令牌的回执，才移除 outbox。通用 ACK 或 success=true 不足以删除结果，断线期间保留记录并在连接恢复后重试回传。

验证命令：`node scripts/test-douyin-outreach.js`。默认测试使用替身适配器，不连接抖音、不执行任何真实外发。真实联调使用指定账号「开发测试抖音2」，需先明确测试作品、目标动作和文案。
