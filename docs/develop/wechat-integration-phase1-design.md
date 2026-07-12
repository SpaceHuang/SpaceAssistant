# 微信 iLink Bot 集成 — Phase 1/2 技术方案

> 版本：v1.0  
> 设计日期：2026-07-11  
> 状态：已实现  
> 需求来源：[wechat-integration-requirement.md](../requirement/wechat-integration-requirement.md) v1.2  
> 参考实现：飞书集成 [feishu-integration-phase1-design.md](./feishu-integration-phase1-design.md)

---

## 0. 设计总纲

### 0.1 范围

| 交付项 | 状态 |
|--------|------|
| Electron 35+（Node 22） | ✅ |
| `@wechatbot/wechatbot` SDK 封装 | ✅ |
| 入站遥控闭环（扫码→监听→Agent→摘要回复） | ✅ |
| 设置页 + IPC + 远程流桥接 | ✅ |
| `wechat_send` / `wechat_reply` 出站工具 | ✅ |
| 双通道 `RemoteStatusBar` + 审计抽屉 | ✅ |
| 会话合并、白名单、配对码 UI | ✅ |
| 富媒体入站（图片/文件下载） | ✅ |
| 进度心跳 + 微信 Y/N 确认（可选） | ✅ |
| Vitest 自动化测试（Mock SDK） | ✅ |

### 0.2 核心原则

1. **凭据不落 SQLite**：SDK 凭证存 `{userData}/wechatbot/`；DB 仅镜像 `loggedIn`、`displayName`、`botIdSuffix`。
2. **主进程驱动远程 Agent**：对标飞书 `feishuRemoteAgent`，复用 `runToolChatSession`。
3. **单实例锁**：`app.requestSingleInstanceLock()` + `{userData}/wechatbot/.lock`；多开时禁用 `remoteEnabled`。
4. **远程上下文泛化**：`evaluateRemoteToolBlock` 同时支持 `feishu` / `wechat` 来源。

### 0.3 目录结构

```
electron/wechat/
├── weChatBotService.ts       # SDK 单例：login/QR/poll/logout
├── weChatInboundParser.ts    # SDK → WeChatInboundMessage
├── weChatMediaInbound.ts     # bot.download → .wechat-inbound/
├── weChatProcessedStore.ts   # messageId 7 天去重
├── weChatCommandRouter.ts    # 限流/白名单/并发/触发 Agent
├── weChatRemoteAgent.ts      # runToolChatSession 编排
├── weChatReplyService.ts     # Markdown strip、2000 字分片
├── weChatConfirmManager.ts   # 桌面确认 + 可选微信 Y/N
├── weChatAuditLogger.ts      # wechat-audit.log
├── weChatSessionResolver.ts  # [微信] 会话创建/合并
├── weChatIpc.ts              # Bundle + IPC
└── __mocks__/wechatBotMock.ts

electron/tools/
├── weChatToolExecutor.ts
└── wechatExecutors.ts

src/shared/
├── wechatTypes.ts
└── wechatPrompts.ts

src/renderer/
├── components/Config/WeChatSettingsTab.tsx
├── components/DetailPanel/RemoteStatusBar.tsx
├── components/DetailPanel/WeChatRemoteStatusBar.tsx
└── services/wechatRemoteStreamService.ts
```

---

## 1. SDK 适配要点（@wechatbot/wechatbot v2.2.0）

| 项 | 说明 |
|----|------|
| 构造参数 | `botAgent`（非 `bot_agent`） |
| 消息 ID | `raw.client_id` |
| context token | `_contextToken` 或 `raw.context_token` |
| 回复 | `bot.reply(inboundMsg, content)` 必须传完整 `IncomingMessage` |
| 配对码 | `login({ callbacks: { onVerifyCode } })` 返回字符串 |
| 展示名 | `getCredentials()` 无 displayName；用 `userId` 前缀 |

---

## 2. 入站数据流

```
WeChatBot.onMessage
  → WeChatCommandRouter.handleSdkInbound
    → 去重 / 白名单 / 限流
    → [image/file] downloadWeChatInboundMedia
    → resolveWeChatSession（合并窗口）
    → runWeChatRemoteAgent
    → replyWeChatSummary（非 pendingConfirm）
```

### 2.1 富媒体（Phase 2）

- `bot.download(msg)` 写入 `{workDir}/.wechat-inbound/`
- 用户消息注入：`[微信图片已保存: .wechat-inbound/xxx.jpg]` + 可选 caption

### 2.2 进度心跳

- `remoteProgressHeartbeatSec`（默认 60s）定时 `bot.reply`「仍在处理中…」
- 与 `remoteTypingEnabled` 的 15s typing 独立

---

## 3. 出站工具

| 工具 | 执行器 | 限制 |
|------|--------|------|
| `wechat_send` | `executeWeChatSend` | 路径 `resolveSafePath`；图片 10MB / 文件 25MB |
| `wechat_reply` | `executeWeChatReply` | 需会话 `inboundRaw` 上下文 |

`filterBuiltinToolsForApi`：`wechat.enabled === false` 时不注入；远程只读拦截 `wechat_send`。

---

## 4. IPC 通道

**Invoke**：`detect-sdk`、`login-start/stop`、`logout`、`connection-status`、`poll-start/stop`、`audit-query/tail`、`send`、`reply`、`confirm-response`

**Push**：`qr-url`、`login-progress`、`inbound-message`、`confirm-request`、`polling-stats`、`remote-agent-start`、`agent-done`

`connection-status` 与 `WeChatConfig` 解绑时清空 `displayName`。

---

## 5. UI

- **WeChatSettingsTab**：绑定/解绑、QR（`qrcode.react`）、配对码、监听启停、安全折叠区
- **RemoteStatusBar**：飞书/微信双通道；Container Query 紧凑模式见 `styles.css`
- **会话列表**：`metadata.source === 'wechat'` 角标；标题前缀 `[微信]`

---

## 6. 测试策略

- 主进程：`electron/wechat/*.test.ts`，SDK 统一 `wechatBotMock`
- 渲染：`WeChatSettingsTab`、`RemoteStatusBar`、`RemoteAuditDrawer`、`wechatRemoteDisplayStatus`
- 不依赖真实微信账号；§17 手工验收作发布门禁

---

## 7. Phase 2 后续（非本 MVP）

- 群聊 @Bot / 指令前缀策略增强
- Vision 多模态直注（当前以路径引用 + read_file）
- 语音/视频入站转写
