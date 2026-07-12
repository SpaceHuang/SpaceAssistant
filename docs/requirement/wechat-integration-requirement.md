# 微信 iLink Bot 集成 — 产品需求文档

**版本：** 1.2  
**日期：** 2026-07-12  
**状态：** 评审修订  

> **⚠️ 版本迭代声明（开发人员必读）**  
> 本文档 §13.2 的**双通道合并状态栏（`RemoteStatusBar`）**设计已取代 [feishu-remote-status-sidebar-requirement.md](./feishu-remote-status-sidebar-requirement.md) 的独立飞书状态栏设计。  
> **跨需求文档冲突裁决：** 当本文档与飞书状态栏需求文档存在冲突时，**以本文档（v1.2）为准**。  
> **分期实施：** Phase 1 仅交付微信入站核心能力；双通道状态栏为 **Phase 2** 交付项；Phase 1 期间飞书状态栏暂按原文档实现，但需预留重构接口。

**参考来源：**
- [corespeed-io/wechatbot](https://github.com/corespeed-io/wechatbot) — 微信 iLink Bot SDK（Node.js / Python / Go / Rust）
- [@wechatbot/wechatbot npm 包](https://www.npmjs.com/package/@wechatbot/wechatbot) — Node.js SDK 文档
- [wechatbot docs/protocol.md](https://github.com/corespeed-io/wechatbot/blob/main/docs/protocol.md) — iLink Bot API 协议
- [wechatbot docs/architecture.md](https://github.com/corespeed-io/wechatbot/blob/main/docs/architecture.md) — SDK 架构
- [@wechatbot/pi-agent](https://github.com/corespeed-io/wechatbot/tree/main/pi-agent) — Pi 扩展参考实现（微信 ↔ Agent 桥接）
- [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) — 灵感来源（OpenClaw 微信插件）

**关联文档：**
- [feishu-integration-requirement.md](./feishu-integration-requirement.md) — 远程指令架构参考
- [feishu-remote-status-sidebar-requirement.md](./feishu-remote-status-sidebar-requirement.md) — 远程监听状态栏参考
- [tools-requirement.md](./tools-requirement.md)
- [settings-requirement.md](./settings-requirement.md)
- [system-tray.md](./system-tray.md)

---

## 目录

1. [概述](#1-概述)
2. [WeChatBot SDK 能力摘要](#2-wechatbot-sdk-能力摘要)
3. [现状分析与适配机会](#3-现状分析与适配机会)
4. [目标与非目标](#4-目标与非目标)
5. [用户故事](#5-用户故事)
6. [总体架构](#6-总体架构)
7. [能力一：手机微信远程指令（入站）](#7-能力一手机微信远程指令入站)
8. [能力二：Agent 主动发送微信消息（出站）](#8-能力二agent-主动发送微信消息出站)
9. [配置与设置界面](#9-配置与设置界面)
10. [Skill 与系统提示词](#10-skill-与系统提示词)
11. [数据模型设计](#11-数据模型设计)
12. [IPC 接口设计](#12-ipc-接口设计)
13. [UI 与交互设计](#13-ui-与交互设计)
14. [安全与权限](#14-安全与权限)
15. [非功能需求](#15-非功能需求)
16. [发布计划](#16-发布计划)
17. [验收标准](#17-验收标准)
18. [测试计划](#18-测试计划)
19. [待解决问题跟踪](#19-待解决问题跟踪)
20. [关联需求文档增量变更](#20-关联需求文档增量变更)
21. [相关文件](#21-相关文件)

---

## 1. 概述

### 1.1 背景

SpaceAssistant 已通过飞书 CLI 集成实现了「手机发指令 → 桌面 Agent 执行 → 结果回传」的远程协作闭环。然而，大量用户日常沟通仍依赖**微信**——个人助手、临时任务下发、外出时快速遥控桌面 Agent 等场景，微信往往是更自然的入口。

[WeChatBot](https://github.com/corespeed-io/wechatbot) 是面向 OpenClaw / AI Agent 的生产级微信 iLink Bot SDK，提供扫码登录、长轮询收消息、富媒体收发、`context_token` 生命周期管理等完整能力。其 [Pi Agent 扩展](https://github.com/corespeed-io/wechatbot/tree/main/pi-agent) 已验证典型桥接模式：

```
微信用户发消息 → SDK 长轮询 → Agent 处理 → bot.reply() 回传微信
```

SpaceAssistant 主进程基于 Node.js，与 `@wechatbot/wechatbot`（Node.js ≥ 22、零运行时依赖）天然契合，无需像飞书那样额外 spawn CLI 子进程即可完成协议层集成。

### 1.2 产品价值

| 价值 | 说明 |
|------|------|
| 移动遥控 | 用户在外出时通过微信向 SpaceAssistant Bot 发指令，桌面端自动执行并回复 |
| 低门槛接入 | 扫码即可绑定，无需企业开放平台应用配置（对比飞书 Bot 前置步骤更少） |
| 执行闭环 | Agent 可将结果、文件、截图直接发回微信对话 |
| 与本地能力协同 | 远程指令可触发本地文件读写、Shell、浏览器、Wiki 等已有工具 |
| 双通道互补 | 与飞书集成并存：企业协作走飞书，个人/轻量遥控走微信 |

### 1.3 核心原则

- **优先复用 `@wechatbot/wechatbot` SDK**，不自研 iLink 协议层；SpaceAssistant 负责生命周期托管、UI 桥接、安全策略与会话路由。
- **架构对齐飞书远程指令**：独立实现 `WeChatCommandRouter`，但遵循飞书远程指令的统一模式（去重、并发控制、会话映射、确认策略等），降低实现成本。后续迭代可提取通用基类。
- **用户无需理解 iLink 协议**；扫码登录、状态展示、错误提示均在设置页与应用内完成。
- **单账号优先**：第一期仅支持绑定一个微信 Bot 账号；多账号/多租户列为后续迭代。

---

## 2. WeChatBot SDK 能力摘要

> 以下内容整理自 wechatbot 仓库 README、protocol.md、architecture.md 与 nodejs/README.md。

### 2.1 SDK 选型

| SDK | 安装 | 适用性 |
|-----|------|--------|
| **Node.js** `@wechatbot/wechatbot` | `npm install @wechatbot/wechatbot` | **首选** — 与 Electron 主进程同栈，零运行时依赖 |
| Python `wechatbot-sdk` | `pip install wechatbot-sdk` | 不采用（需额外 Python 进程） |
| Go / Rust | 各自包管理器 | 不采用（跨语言 IPC 成本高） |

**Node.js SDK 要求：** Node.js ≥ 22（原生 fetch）；SpaceAssistant Electron 主进程需满足或 polyfill。

### 2.2 核心 API（Node.js）

| 类别 | API | 说明 |
|------|-----|------|
| 生命周期 | `new WeChatBot(options)` | 创建实例 |
| | `bot.login(options?)` | 扫码登录；凭证存在则自动恢复 |
| | `bot.start()` / `bot.run()` | 启动长轮询 |
| | `bot.stop()` | 优雅停止 |
| 接收 | `bot.onMessage(handler)` | 注册消息处理器 |
| | `bot.download(msg)` | 下载消息内媒体 |
| 发送 | `bot.reply(msg, content)` | 回复当前会话（自动注入 context_token） |
| | `bot.send(userId, content)` | 主动向指定用户发送 |
| | `bot.sendTyping(userId)` | 「对方正在输入中…」 |
| 事件 | `bot.on('login' \| 'session:expired' \| 'error' \| …)` | 生命周期监控 |
| 中间件 | `bot.use(mw)` | Express 风格管道（限流、过滤等） |

### 2.3 协议要点（iLink Bot API）

| 项 | 说明 |
|----|------|
| Base URL | `https://ilinkai.weixin.qq.com` |
| CDN | `https://novac2c.cdn.weixin.qq.com/c2c` |
| 认证 | QR 扫码 → `bot_token` 持久化；请求头 `Authorization: Bearer <bot_token>` |
| 收消息 | `POST /ilink/bot/getupdates` 长轮询（35s hold），游标 `get_updates_buf` |
| 发消息 | `POST /ilink/bot/sendmessage`，**必须**携带 inbound 的 `context_token` |
| 会话过期 | `errcode: -14` → 清状态并重新 login |
| 文本分片 | 单条上限约 2000 字，按段落/行/空格智能拆分 |
| 富媒体 | 图片/文件/语音/视频；CDN AES-128-ECB 加解密 |

### 2.4 登录流程

```
1. POST /get_bot_qrcode → 获取 QR URL
2. 展示 QR（SDK 不渲染 QR，由应用负责）
3. 轮询 /get_qrcode_status（2s 间隔）
4. confirmed → 持久化 bot_token 到 storageDir
5. expired → 刷新 QR
6. need_verifycode → 用户在手机微信输入配对码后重试
```

凭证默认存储于 `~/.wechatbot/`；SpaceAssistant 应改为 `{userData}/wechatbot/` 以实现多用户隔离。

### 2.5 Pi Agent 参考桥接（对标实现）

Pi 扩展 `@wechatbot/pi-agent` 的桥接逻辑可直接映射到 SpaceAssistant：

| Pi 行为 | SpaceAssistant 映射 |
|---------|---------------------|
| `/wechat` 显示 QR | 设置页 / 状态栏「连接微信」 |
| 微信消息 → `pi.sendUserMessage(text)` | 入站 → `WeChatCommandRouter` → `runWeChatRemoteAgent` |
| `agent_end` → `bot.reply(text)` | Agent 完成 → `WeChatReplyService.replySummary` |
| `bot.sendTyping()` while thinking | 远程 Agent 执行期间发送 typing |
| Markdown 输出 | SDK `stripMarkdown()` 或等价处理后再发送 |

### 2.6 Node.js SDK 独有能力（可复用）

| 能力 | 用途 |
|------|------|
| 可插拔 Storage | 文件 / 内存 / 自定义；默认 `{userData}/wechatbot/` |
| 中间件 | 内置限流 `rateLimitMiddleware`、类型过滤 `typeFilterMiddleware` |
| 结构化日志 | 对接 SpaceAssistant 主进程日志 |
| 远程 URL 发送 | `{ url: 'https://...' }` 自动下载并发送 |
| Markdown  stripping | AI 输出适配微信纯文本 |

---

## 3. 现状分析与适配机会

### 3.1 SpaceAssistant 现状

| 模块 | 现状 | 与微信集成的关系 |
|------|------|-----------------|
| 飞书远程指令 | 已实现 `FeishuEventService`、`feishuRemoteAgent`、`FeishuCommandRouter` | **可复用模式/约定**（去重、并发控制、会话映射、确认策略等），微信独立实现 `WeChatCommandRouter` |
| 主进程 | Node.js，可 import npm 包 | 可直接 `import { WeChatBot } from '@wechatbot/wechatbot'` |
| 内置工具 | 文件 / Shell / 浏览器 / `run_lark_cli` 等 | 需新增 `wechat_send` / `wechat_reply` 等微信出站工具 |
| 配置 | `AppConfig.feishu` | 需扩展 `AppConfig.wechat` |
| 系统托盘 | 需求已定义 | 后台监听依赖托盘或主进程常驻 |
| 设置 UI | `FeishuSettingsTab` | 可平行新增 `WeChatSettingsTab` |
| 远程状态栏 | 飞书监听状态栏需求已定义 | 可扩展或并列「微信监听状态栏」 |

### 3.2 与飞书集成的差异

| 维度 | 飞书 | 微信 |
|------|------|------|
| 集成方式 | 外部 CLI 子进程 | 主进程内嵌 SDK |
| 认证 | App ID/Secret + OAuth | 扫码登录 |
| 入站通道 | WebSocket NDJSON | HTTP 长轮询 |
| 回复凭据 | `message_id` + lark-cli reply | `context_token` + `bot.reply()` |
| 群聊 | 支持 @Bot / 前缀 | iLink Bot 以 **1:1 私聊** 为主（第一期） |
| 出站工具 | `run_lark_cli` | `wechat_send` / `wechat_reply`（SDK 封装） |
| 前置配置 | 飞书开放平台多项配置 | 仅需微信扫码 |

### 3.3 关键差距

1. **缺少 WeChatBot 生命周期服务**：无 login / poll / stop 托管。
2. **缺少入站消息路由**：微信消息尚未映射到本地 Agent 会话。
3. **缺少出站 Agent 工具**：模型无法主动发微信消息。
4. **缺少 QR 展示 UI**：SDK 只提供 URL，需应用渲染可扫描 QR 码。
5. **缺少 `context_token` 持久化策略**：跨重启回复需与 SDK Storage 对齐。

### 3.4 适配策略

采用 **「SDK 内嵌 + 远程桥接 + 专用工具」** 三层架构：

```
WeChatBot SDK（主进程）
    ├── WeChatBotService      — login / poll / 事件
    ├── WeChatCommandRouter   — 入站 → 会话 → Agent（独立模块，遵循飞书 RemoteCommandRouter 模式）
    ├── WeChatRemoteAgent     — 远程 Agent 执行 + typing + 回复
    └── WeChatToolExecutor    — Agent 出站工具
```

**架构复用说明**：微信与飞书远程指令各自独立实现 Router 和 RemoteAgent（`WeChatCommandRouter` / `FeishuCommandRouter`），但遵循统一的模式和约定（去重、并发控制、会话映射、确认策略等）。后续迭代可提取 `RemoteCommand` 基类或接口，统一飞书和微信的远程指令处理逻辑；同时将 `FeishuConfirmManager` 扩展为通用 `RemoteConfirmManager`，减少代码重复。

---

## 4. 目标与非目标

### 4.1 目标

| # | 目标 |
|---|------|
| G1 | SpaceAssistant 可安装/检测 `@wechatbot/wechatbot`，并在设置页完成扫码绑定 |
| G2 | 主进程后台长轮询接收微信消息，解析为统一入站模型 |
| G3 | 入站文本指令自动创建或路由本地 Agent 会话，执行完成后回复微信 |
| G4 | Agent 可通过专用工具向微信用户发送文本 / 图片 / 文件（Phase 2 交付） |
| G5 | 设置页提供：启用开关、连接状态、重新登录、监听启停、安全策略 |
| G6 | 远程指令支持确认策略、去重、审计日志，行为与飞书远程指令对齐 |
| G7 | 执行中展示「对方正在输入中…」提升微信侧体验 |
| G8 | 会话 metadata 标记 `source: 'wechat'`，桌面端可区分来源 |

### 4.2 非目标（第一期）

| 非目标 | 说明 |
|--------|------|
| 自研 iLink 协议 | 一律通过官方 SDK |
| 多微信账号 | 第一期单账号；多租户 Phase 2 |
| 微信群聊 @Bot | iLink Bot 第一期仅处理 1:1 私聊 |
| 语音消息 ASR / TTS | 第一期文本为主；语音可下载但不转写 |
| 微信小程序 / 公众号 | 不做小程序内嵌 UI |
| 替换微信官方 OpenClaw 插件 | 并存；不同产品形态 |
| 通过通用 Shell 调用 SDK | 仅实现专用工具，不开放任意 Node 脚本 |

---

## 5. 用户故事

### US-01：首次绑定微信（新手友好）

**作为** 刚接触 SpaceAssistant 的用户，**我希望** 在设置页看到清晰的价值引导，点击「绑定微信」后扫码确认即可完成绑定，**以便** 快速开启微信遥控能力，无需理解任何技术概念。

**验收标准：**
- 设置页显示「通过微信遥控桌面 Agent」的价值说明
- 点击「绑定微信」后自动显示二维码，无需额外步骤
- 扫码过程中显示清晰的进度提示（等待扫描 → 已扫描 → 绑定成功）
- 绑定成功后展示常用指令示例

### US-02：手机遥控桌面 Agent

**作为** 外出的用户，**我希望** 在微信里给 SpaceAssistant Bot 发「帮我在项目里跑测试并汇报结果」，**以便** 桌面端自动执行并把摘要发回微信。

### US-03：Agent 主动发微信

**作为** 桌面用户，**我希望** 对话中说「把这份报告发给微信上的张三」，**以便** Agent 通过工具发送文件/文本到指定微信联系人（需确认）。

**联系人解析范围（Phase 1）：**
- **支持**：历史交互过的 userId（从会话 metadata 获取）、配置的白名单 userId
- **暂不支持**：自然语言姓名解析（如「张三」→ userId）、备注名匹配
- **提示**：Agent 应引导用户使用 userId 或从历史会话中选择目标用户

**Phase 2 扩展：** 支持白名单备注名匹配；自然语言姓名解析列为 Phase 3 或视 SDK 能力决定。

### US-04：查看远程任务过程

**作为** 用户，**我希望** 回家后打开 SpaceAssistant 能看到微信触发的会话及完整工具调用链，**以便** 审计与继续对话。

### US-05：后台静默执行

**作为** 关闭主窗口的用户，**我希望** 应用在托盘后台仍能接收微信指令，**以便** 不保持窗口打开也能遥控。

### US-06：安全可控

**作为** 注重安全的用户，**我希望** 微信触发的本地写操作与出站发消息可配置确认策略，**以便** 防止误操作或被滥用。

### US-07：连接状态可见

**作为** 用户，**我希望** 在设置页或右侧栏看到「微信：已绑定 / 未绑定 / 会话过期」，**以便** 快速排查连接问题。

> **Phase 标注**：Phase 1 仅在设置页「微信遥控」Tab 展示连接状态；Phase 2 在双通道远程状态栏（右侧栏）展示。

---

## 6. 总体架构

```mermaid
flowchart TB
  subgraph Mobile["手机微信"]
    UserMsg[用户发送文本/图片给 Bot]
  end

  subgraph WeChatCloud["微信 iLink API"]
    iLink[ilinkai.weixin.qq.com]
    CDN[CDN 富媒体]
  end

  subgraph SA_Main["SpaceAssistant 主进程"]
    BotSvc[WeChatBotService<br/>@wechatbot/wechatbot]
    CmdRouter[WeChatCommandRouter]
    RemoteAgent[WeChatRemoteAgent]
    ToolExec[WeChatToolExecutor]
    ToolLoop[Tool Chat Loop]
  end

  subgraph SA_Renderer["渲染进程"]
    ChatUI[聊天界面]
    Settings[设置 - 微信 Tab]
    QrUI[二维码展示]
    Tray[系统托盘]
  end

  subgraph Agent["LLM Agent"]
    LLM[Claude / 其他模型]
  end

  UserMsg --> iLink
  iLink --> BotSvc
  BotSvc --> CmdRouter
  CmdRouter --> RemoteAgent
  RemoteAgent --> ToolLoop
  ToolLoop --> LLM
  LLM --> ToolExec
  ToolExec --> BotSvc
  BotSvc --> iLink
  ToolExec --> CDN
  RemoteAgent --> ChatUI
  CmdRouter --> ChatUI
  Settings --> BotSvc
  QrUI --> Settings
  Tray --> SA_Main
```

### 6.1 模块职责

| 模块 | 进程 | 职责 |
|------|------|------|
| `WeChatBotService` | Main | 封装 SDK：login、start/stop、onMessage、状态事件、QR 回调 |
| `WeChatCommandRouter` | Main | 过滤、去重、会话映射、触发远程 Agent、协调回复 |
| `WeChatRemoteAgent` | Main | 调用 `runToolChatSession`，typing、摘要回传 |
| `WeChatReplyService` | Main | 分片发送、Markdown 清理、context_token 管理 |
| `wechat_send` / `wechat_reply` | Main → Agent | 出站工具 |
| `WeChatConfig` | Main + Renderer | 启用、监听、安全策略 |
| `WeChatSettingsTab` | Renderer | 扫码、状态、策略配置 |

> **架构演进说明**：当前微信与飞书远程指令各自独立实现 Router 和 RemoteAgent。后续迭代可提取 `RemoteCommand` 基类或接口，统一飞书和微信的远程指令处理逻辑；同时将 `FeishuConfirmManager` 扩展为通用 `RemoteConfirmManager`，减少代码重复。

---

## 7. 能力一：手机微信远程指令（入站）

### 7.1 用户流程

```
用户在微信打开与 SpaceAssistant Bot 的 1:1 对话
    → 发送文本：「列出工作目录下的 md 文件」
    → WeChatBotService 长轮询收到 IncomingMessage
    → WeChatCommandRouter 解析 userId、text、context_token
    → 创建本地会话，标题 [微信] {content 前 30 字}
    → WeChatRemoteAgent 启动 Agent（本地工具 + 可选 wechat_reply）
    → 执行中 bot.sendTyping(userId)
    → 完成后 WeChatReplyService.reply(msg, summary) 回传微信
    → 桌面会话持久化，用户可查看完整过程
```

### 7.2 WeChatBotService

| ID | 需求 | 优先级 |
|----|------|--------|
| WX-SVC-01 | 主进程单例 `WeChatBotService`，`storageDir` 固定为 `{userData}/wechatbot/` | P0 |
| WX-SVC-02 | `bot_agent` 设为 `SpaceAssistant/{appVersion}`，便于协议侧识别 | P1 |
| WX-SVC-03 | `login()` 注册 `onQrUrl` / `onScanned` / `onExpired` 回调，经 IPC 推送到渲染进程 | P0 |
| WX-SVC-04 | 凭证存在时 `login()` 自动恢复；登录成功后从 SDK 获取 `displayName`（微信昵称），设置页展示「已绑定 · {displayName}」 | P0 |
| WX-SVC-05 | `start()` 启动长轮询；`stop()` 优雅停止并 `notifystop` | P0 |
| WX-SVC-06 | 监听 `session:expired`（errcode -14）自动触发重新 login 或通知 UI | P0 |
| WX-SVC-07 | 网络错误指数退避（SDK 内置 1s→10s）；连续失败更新 `lastError` | P0 |
| WX-SVC-08 | 应用退出时 `stop()` 并持久化游标 | P0 |
| WX-SVC-09 | 内置 `rateLimitMiddleware`：默认每用户 10 条/分钟（可配置） | P1 |
| WX-SVC-10 | 提供 `getStatus()`：`stopped \| connecting \| polling \| logged_out \| error` | P0 |

### 7.3 入站消息模型

```typescript
interface WeChatInboundMessage {
  messageId: string          // client_id 或 SDK 生成的稳定 ID
  userId: string             // 微信用户 ID（ilink 侧）
  text: string             // 纯文本（非文本类型可为空）
  type: 'text' | 'image' | 'voice' | 'file' | 'video'
  timestamp: string
  contextToken: string       // 回复必需，从 raw 提取
  images?: WeChatMediaRef[]
  files?: WeChatMediaRef[]
  voices?: WeChatMediaRef[]
  videos?: WeChatMediaRef[]
  quotedMessage?: { text?: string }
}
```

### 7.4 WeChatCommandRouter 规则

| ID | 需求 | 优先级 |
|----|------|--------|
| WX-RTR-01 | **私聊 Bot**：所有入站消息均视为潜在指令（iLink Bot 默认 1:1） | P0 |
| WX-RTR-02 | **类型过滤**：第一期仅自动处理 `type=text`；其他类型回复「暂仅支持文本指令，媒体已收到」 | P0 |
| WX-RTR-03 | **发送者白名单**（可选）：仅处理 `userId` 在白名单内的消息 | P1 |
| WX-RTR-04 | **去重**：同一 `messageId` 只处理一次（持久化 7 天） | P0 |
| WX-RTR-05 | **会话映射**：默认每条指令新建会话；`remoteSessionMergeMinutes > 0` 时同 `userId` 续接 | P1 |
| WX-RTR-06 | 会话 metadata：`source: 'wechat'`, `wechatUserId`, `wechatMessageId` | P0 |
| WX-RTR-07 | 指令长度上限 4000 字符（与飞书对齐），超出回复提示 | P0 |
| WX-RTR-08 | **并发控制**：微信与飞书远程指令共享全局 `maxParallelChatSessions` 上限 | P0 |
| WX-RTR-09 | **上限行为**：达到并行上限时拒绝新指令，微信侧回复「当前会话繁忙，请稍后再试」 | P0 |
| WX-RTR-10 | **优先级策略**：FIFO 先进先出，不区分微信/飞书优先级 | P1 |
| WX-RTR-11 | **指令前缀**（可选）：忽略不以 `/sa ` 开头的消息（可配置，默认关闭） | P2 |
| WX-RTR-12 | **默认 workDir**：Phase 1 远程指令使用全局默认 workDir（与本地会话一致）；多工作目录路由（`@项目名`）为 Phase 3 交付项 | P0 |

### 7.5 微信侧回复策略

| 阶段 | 行为 |
|------|------|
| 收到指令 | 可选立即回复「已收到，正在处理…」 |
| 执行中 | 层 A Typing（≈15s）；层 B 心跳（默认 60s）携带 **Activity 快照**；见 [remote-progress-activity-sync-requirement.md](./remote-progress-activity-sync-requirement.md) |
| 完成 | `reply(msg, summary)`；超 2000 字 SDK 自动分片 |
| 失败 | 回复错误原因 + 「请打开 SpaceAssistant 查看详情」 |
| 需确认 | **即时** reply 确认提示（含操作摘要 +「回复 Y 确认，N 取消」）；Agent 阻塞等待；桌面确认卡片并行（见 §7.5.1、[remote-progress-activity-sync-requirement.md](./remote-progress-activity-sync-requirement.md) §6.4） |
| Markdown | 发送前 strip Markdown（链接保留可读 URL） |

**回复摘要规则：**

| 项 | 规则 |
|----|------|
| 来源 | 默认取最后一条 assistant 消息的纯文本内容 |
| 最大长度 | 2000 字符（与飞书对齐）；超出时自动截断 |
| 截断策略 | 在段落边界截断，末尾添加「…」 |
| 引导文案 | 摘要末尾追加固定引导：「完整过程请查看 SpaceAssistant 桌面会话」 |
| 分片发送 | SDK 自动处理超长文本分片，微信侧顺序可读 |

> **第一期限制：** 默认 `wechat_confirm` 下远程写操作经 **IM Y/N** 确认；`remote_read_only` 为 **禁止远程写**，不自动执行。

### 7.5.1 远程确认端到端流程（与飞书对齐）

> **以 [remote-progress-activity-sync-requirement.md](./remote-progress-activity-sync-requirement.md) §6.4 为准。** 远程用户经 IM 操控 Agent 时，写操作确认 **必须** 在 IM 内可操作，不得依赖「仅桌面确认」。

```
微信用户发指令 → 远程 Agent 执行 → 工具调用触发确认请求
    → 微信侧 **即时** reply Y/N 确认提示（固定行为，无开关）
    → 桌面端 **可选** 同步展示确认卡片（用户碰巧开着应用时）
        ├─ IM 回复 Y（或桌面点击确认）→ 工具执行 → 摘要回微信
        └─ IM 回复 N / 超时 → 微信侧 reply「操作已取消」
```

**确认体验：**

| 元素 | 说明 |
|------|------|
| IM 确认（唯一产品路径） | `WeChatConfirmManager`：即时 Y/N；Agent 阻塞至 IM 决策 |
| 桌面确认卡片（可选） | 同一 pending 在桌面同步展示；**非**「关掉 IM 改走桌面」的备用方案 |
| 浮层通知 | `pending-confirm-floating-notification`，待确认数量与快速入口 |
| 超时策略 | 默认 5 分钟；超时后 IM reply「操作已取消（确认超时）」 |
| **禁止** | 未启用 IM 确认时 sole 回复「请打开桌面」并结束 Agent — 视为流程缺陷 |

**确认策略行为对照（与飞书 §8.5.1 统一，详见 [remote-progress-activity-sync-requirement.md](./remote-progress-activity-sync-requirement.md) §6.4.2）：**

| 策略 | 远程触发写操作 | 远程触发出站 | 桌面触发出站 |
|------|--------------|-------------|-------------|
| `wechat_confirm`（**默认，新增**） | IM Y/N 确认 + Agent 阻塞 | 需确认（IM） | 需确认（配置项） |
| `always` | 同 `wechat_confirm` | 需确认 | 需确认 |
| `remote_read_only` | **禁止**远程写（诚实拒绝，不引导桌面） | 禁止远程出站（现网过滤 `wechat_send`） | 需确认（配置项） |
| `inherit` | 远程会话下 **等效** `wechat_confirm` | 继承全局 | 继承全局 |

> **拉齐飞书：** 废弃 `remoteWechatConfirm`；默认 `wechat_confirm`。安全与策略见 [remote-progress-activity-sync-requirement.md](./remote-progress-activity-sync-requirement.md) §6.4.2 / §6.4.5；技术方案见 §附录 C。

### 7.6 消息边界处理

| 场景 | 处理策略 |
|------|---------|
| **超长文本（>4000 字符）** | 截断前 4000 字符，微信侧回复「指令过长，已截断处理」；完整内容保留在本地会话 |
| **空消息** | 过滤，不触发 Agent，不回复 |
| **特殊字符** | 转义处理（`<`、`>`、`&`、换行符等），防止注入风险 |
| **快速连续指令** | 速率限制（默认 10 条/分钟/用户），超限后回复「当前指令过于频繁，请稍后再试」，不启动 Agent |

### 7.7 富媒体入站（Phase 2 预留）

| 类型 | Phase 1 | Phase 2 |
|------|---------|---------|
| 图片 | 回复「暂不支持图片指令」 | `bot.download(msg)` → 注入 vision / 附件 |
| 文件 | 同上 | 下载到 `{workDir}/.wechat-inbound/` 后注入 |
| 语音 | 同上 | 下载；可选 SILK→WAV 转码 |
| 视频 | 同上 | 下载 + 摘要 |

### 7.8 与系统托盘协同

| ID | 需求 | 优先级 |
|----|------|--------|
| TRAY-WX-01 | 启用微信远程监听时，建议同时启用系统托盘 | P1 |
| TRAY-WX-02 | 收到远程指令时可选系统通知「微信：{摘要}」 | P1 |
| TRAY-WX-03 | 监听断开 / 会话过期时通知用户重新扫码 | P1 |

---

## 8. 能力二：Agent 主动发送微信消息（出站）

### 8.1 设计原则

微信出站不通过 Shell/CLI，而是主进程内 SDK 调用，Agent 通过**专用内置工具**访问，避免任意代码执行风险。

### 8.2 新增内置工具：`wechat_reply`

用于在**已有入站上下文**中回复（远程 Agent 内部也使用同一服务，但工具暴露给桌面会话）。

```json
{
  "name": "wechat_reply",
  "description": "向当前微信对话回复消息。仅在 source=wechat 的会话或明确提供 inboundContext 时使用。自动处理 context_token 与长文本分片。",
  "input_schema": {
    "type": "object",
    "properties": {
      "text": { "type": "string", "description": "回复文本" },
      "imagePath": { "type": "string", "description": "相对 workDir 的图片路径" },
      "filePath": { "type": "string", "description": "相对 workDir 的文件路径" }
    },
    "required": ["text"]
  }
}
```

| 规则 | 说明 |
|------|------|
| 上下文 | 必须存在有效 `context_token`（来自入站消息或会话 `wechatMeta`） |
| 确认 | **默认需用户确认**（写操作：向外部发送消息） |
| 路径 | 媒体路径限制在 `workDir` 内 |
| 输出 | 返回 `{ success, chunksSent }` |

### 8.3 新增内置工具：`wechat_send`

主动向指定 `userId` 发送（无 inbound 上下文时使用，能力受限）。

```json
{
  "name": "wechat_send",
  "description": "向指定微信用户 ID 主动发送消息。需要已知 userId（例如历史会话 metadata）。",
  "input_schema": {
    "type": "object",
    "properties": {
      "userId": { "type": "string" },
      "text": { "type": "string" },
      "imagePath": { "type": "string" },
      "filePath": { "type": "string" }
    },
    "required": ["userId", "text"]
  }
}
```

| 规则 | 说明 |
|------|------|
| 确认 | **一律需用户确认** |
| userId 来源 | 仅允许发给「历史交互过的 userId」或配置的白名单 | 
| 无 context_token | SDK `send()` 路径；若协议要求 token 且缺失则失败并提示 |

### 8.3.1 媒体出站限制

| 类型 | 支持格式 | 单文件大小上限 | 说明 |
|------|---------|--------------|------|
| 图片 | JPG、PNG、GIF、WebP | 10MB | 超过上限时工具返回错误 |
| 文件 | 任意格式 | 25MB | 超过上限时工具返回错误 |
| 语音 | SILK（SDK 原生格式） | 5MB | Phase 2 支持 |
| 视频 | MP4 | 50MB | Phase 2 支持 |

**发送失败时的用户可见错误分类：**

| 错误类型 | 用户提示 |
|---------|---------|
| 文件不存在 | 「文件不存在，请检查路径」 |
| 文件过大 | 「文件大小超过限制（最大 {limit}）」 |
| 文件不在 workDir | 「文件路径不在工作目录范围内」 |
| 格式不支持 | 「不支持此文件格式」 |
| 发送超时 | 「发送超时，请重试」 |
| 网络失败 | 「网络连接失败，请检查网络后重试」 |

### 8.4 工具可用性

| 条件 | 行为 |
|------|------|
| `wechat.enabled === false` | 工具不注入模型 |
| 未登录 / 未 start | 工具返回明确错误 + 引导设置页 |
| 远程只读策略 | 远程触发的 Agent 不可调用 `wechat_send`；`wechat_reply` 仅用于最终摘要（由 `WeChatReplyService` 内部调用，不暴露给模型二次发送） |

### 8.5 Agent 典型场景

| 场景 | 用户说法 | 预期行为 |
|------|---------|---------|
| 远程查询 | 微信发「今天 git log 摘要」 | 本地 git 工具 → 摘要 reply |
| 桌面转发 | 「把 README 发给刚才微信联系的用户」 | confirm → wechat_send + 文件 |
| 截图回传 | 「截个浏览器页面发回微信」 | browser 工具 → wechat_reply 图片 |
| 长文回复 | Agent 输出 5000 字 | 自动分 3 片发送 |

---

## 9. 配置与设置界面

### 9.1 设置 Tab 扩展

| Tab | 名称 | 内容 |
|-----|------|------|
| 微信 | 微信遥控 | 绑定微信、接收消息、安全设置 |

可与飞书 Tab 并列；`settings-requirement.md` Tab 列表需同步更新。

### 9.2 微信 Tab 布局（新手友好版）

**核心设计原则**：最小化认知负担，用用户易懂的语言替代技术术语。

```
┌─ 微信遥控 ─────────────────────────────────────┐
│                                                │
│ ┌─ 价值引导区 ────────────────────────────────┐ │
│ │ 💡 通过微信遥控桌面 Agent                    │ │
│ │    外出时发消息就能执行指令，结果自动回传      │ │
│ └─────────────────────────────────────────────┘ │
│                                                │
│ ┌─ 绑定状态区（核心）─────────────────────────┐ │
│ │                                             │ │
│ │    未绑定状态：                              │ │
│ │    ┌─────────────────┐                      │ │
│ │    │   [QR Code]     │  ← 默认隐藏，点击后显示│ │
│ │    └─────────────────┘                      │ │
│ │    [绑定微信]                              │ │
│ │                                             │ │
│ │    已绑定状态：                              │ │
    ● 已绑定 · {displayName}                   │ │
│ │    [重新绑定]  [解绑]                        │ │
│ │                                             │ │
│ └─────────────────────────────────────────────┘ │
│                                                │
│ ┌─ 功能开关 ──────────────────────────────────┐ │
│ │ [Switch] 接收微信消息（手机发指令到桌面）     │ │
│ │    状态：● 监听中  /  ○ 已停止              │ │
│ │    [ ] 收到消息时弹窗通知                    │ │
│ │    会话合并：__0__ 分钟内同用户消息续接       │ │
│ └─────────────────────────────────────────────┘ │
│                                                │
│ ┌─ 安全设置（折叠）───────────────────────────┐ │
│ │ [▼] 展开安全设置                             │ │
│ │    [ ] 允许远程指令修改本地文件              │ │
│ │    消息频率限制：__10__ 条/分钟/用户         │ │
│ │    发送者白名单：（可选，微信号列表）         │ │
│ └─────────────────────────────────────────────┘ │
│                                                │
│ ┌─ 高级（折叠）───────────────────────────────┐ │
│ │ [▼] 展开高级设置                             │ │
│ │    存储目录：{userData}/wechatbot/          │ │
│ │    [查看操作记录]                            │ │
│ └─────────────────────────────────────────────┘ │
│                                                │
└──────────────────────────────────────────────────┘
```

### 9.3 绑定流程优化

**简化后的绑定步骤**（从6步减少到3步）：

| 步骤 | 操作 | 界面反馈 |
|------|------|---------|
| 1 | 打开设置 → 切换到「微信遥控」Tab | 看到价值引导和「绑定微信」按钮 |
| 2 | 点击「绑定微信」 | 自动启用集成 + 显示二维码 + 提示「用手机微信扫码」 |
| 3 | 手机扫码并确认 | 二维码区域显示「正在确认…」→ 成功后显示「已绑定」 |

**绑定成功后的引导**：

```
✓ 绑定成功！现在可以用微信发指令了

试试这些常用指令：
• "帮我查看今天的 git 提交记录"
• "打开浏览器搜索 xxx"
• "把当前工作目录发给我"

收到消息时，桌面会自动创建会话并执行指令
```

### 9.4 术语替换（用户友好）

| 技术术语 | 用户用语 | 说明 |
|---------|---------|------|
| 启用微信集成 | 绑定微信 | 更直观 |
| 远程指令监听 | 接收微信消息 | 更易懂 |
| 已连接 / 未登录 | 已绑定 / 未绑定 | 更符合用户认知 |
| 轮询中 | 监听中 | 保持一致 |
| remote_read_only | 仅读取（不修改文件） | 更易懂 |

### 9.5 二维码 UI 优化

| ID | 需求 | 优先级 |
|----|------|--------|
| WX-UI-QR-01 | 渲染进程收到 `onQrUrl` 后使用 `qrcode.react`（^3.1.0）展示可扫描码 | P0 |
| WX-UI-QR-02 | QR 过期自动刷新；刷新失败时显示「二维码已过期，点击重新获取」 | P0 |
| WX-UI-QR-03 | `need_verifycode` 时展示说明：「请在手机微信输入配对数字 xxxx」 | P1 |
| WX-UI-QR-04 | 登录成功后面板收起，显示已绑定状态 + 成功引导 | P0 |
| WX-UI-QR-05 | 扫码过程中显示进度提示：「等待扫描」→「已扫描，请在手机确认」→「绑定成功」 | P0 |
| WX-UI-QR-06 | 网络失败时显示「网络连接失败，请检查网络后重试」，提供「重试」按钮 | P0 |

### 9.6 解绑/登出流程

| 步骤 | 操作 | 界面反馈 |
|------|------|---------|
| 1 | 点击「解绑」 | 弹出确认对话框：「确定要解绑微信吗？解绑后将停止接收微信消息。」 |
| 2 | 确认解绑 | 立即停止监听（`bot.stop()`），清除 `storageDir` 内的凭证文件，设置 `loggedIn: false`、`enabled: false` |
| 3 | 解绑完成 | 界面恢复到「未绑定」状态，显示「绑定微信」按钮 |

**数据清理范围：**

| 数据项 | 是否清理 | 说明 |
|--------|---------|------|
| SDK 凭证（`bot_token` 等） | 是 | `{userData}/wechatbot/` 目录内所有文件 |
| 微信配置（`WeChatConfig`） | 部分 | 仅重置 `loggedIn`、`botIdSuffix`；保留用户配置项（如安全策略、限流设置） |
| 历史会话（`source=wechat`） | 否 | 保留本地会话供用户查看 |
| 审计日志 | 否 | 保留操作记录 |
| 去重记录 | 否 | 保留已处理消息记录（避免重复处理旧消息） |

**重新绑定：** 解绑后用户可随时重新绑定，流程与首次绑定一致。

### 9.7 错误提示优化

| 场景 | 原提示 | 优化后提示 |
|------|--------|-----------|
| 二维码过期 | 已过期 | 二维码已过期，点击「重新获取」 |
| 网络失败 | 错误 | 网络连接失败，请检查网络后重试 |
| 未确认 | 等待确认 | 请在手机微信上点击「确认登录」 |
| 登录失败 | 登录失败 | 登录失败，请检查网络或重新扫码 |
| 账号异常 | 账号异常 | 账号异常，请稍后重试或更换微信号 |

---

## 10. Skill 与系统提示词

### 10.1 微信 Skill（可选）

| ID | 需求 | 优先级 |
|----|------|--------|
| SK-WX-01 | 提供内置 Skill `wechat-remote`，说明远程指令约束与回复规范 | P1 |
| SK-WX-02 | 当 `session.source === 'wechat'` 或用户意图含「发微信」时自动激活 | P1 |
| SK-WX-03 | Skill 内容包含：回复长度建议、避免 Markdown 表格、媒体发送方式 | P2 |

### 10.2 远程指令 System Prompt 片段

```xml
<wechat_remote_command>
来源：微信 iLink Bot 远程指令（手机微信）
回复要求：执行完成后由系统将摘要发回微信；不要假设用户能看到桌面界面
安全：当前会话 source=wechat，写操作确认策略见 wechat.remoteConfirmPolicy
输出：使用简洁中文纯文本，避免复杂 Markdown
</wechat_remote_command>
```

---

## 11. 数据模型设计

### 11.1 WeChatConfig（写入 AppConfig）

```typescript
interface WeChatConfig {
  enabled: boolean

  // 登录镜像状态（真实凭证在 storageDir）
  loggedIn: boolean
  botIdSuffix?: string              // 展示用（botId 末四位）
  displayName?: string              // 用户可见昵称（登录成功后从 SDK 获取）

  // 远程监听
  remoteEnabled: boolean
  remoteSenderAllowlist?: string[]  // userId，空=不限制
  remoteSessionMergeMinutes?: number // 0=每条新会话
  remoteNotifyOnReceive: boolean
  remoteCommandPrefix?: string      // 可选，如 '/sa '
  remoteRateLimitPerMinute: number  // 默认 10
  remoteDefaultModelId?: string     // 远程指令使用的模型；空=使用全局默认

  // 安全
  remoteConfirmPolicy: 'inherit' | 'always' | 'remote_read_only' | 'wechat_confirm'
  remoteAllowLocalWrite: boolean    // 默认 false

  // 体验
  remoteTypingEnabled: boolean      // 默认 true
  remoteProgressHeartbeatSec?: number // 默认 60，0=关闭
  remoteAckOnReceive: boolean       // 收到后是否立即回「已收到…」

  // 出站工具
  wechatSendRequiresConfirm: boolean // 默认 true
}

export const DEFAULT_WECHAT_CONFIG: WeChatConfig = {
  enabled: false,
  loggedIn: false,
  remoteEnabled: false,
  remoteNotifyOnReceive: true,
  remoteConfirmPolicy: 'wechat_confirm',
  remoteAllowLocalWrite: false,
  remoteSessionMergeMinutes: 0,
  remoteRateLimitPerMinute: 10,
  remoteDefaultModelId: undefined,
  remoteTypingEnabled: true,
  remoteProgressHeartbeatSec: 60,
  remoteAckOnReceive: true,
  wechatSendRequiresConfirm: true,
}
```

### 11.2 Session 扩展

```typescript
interface Session {
  // ...existing fields
  source?: 'local' | 'feishu' | 'wechat'
  isRemote?: boolean
  wechatMeta?: {
    userId?: string
    lastMessageId?: string
    lastContextToken?: string
    lastReplyAt?: number
  }
}
```

| 字段 | 说明 |
|------|------|
| `source` | 会话来源：`local`（本地）、`feishu`（飞书远程）、`wechat`（微信远程） |
| `isRemote` | 统一标记远程会话（飞书/微信共用），便于 UI 统一展示远程角标 |
| `wechatMeta.lastReplyAt` | 最后回复时间，用于会话合并判断（`remoteSessionMergeMinutes` 策略） |

### 11.3 已处理消息去重

与飞书集成保持一致，存储于 `{userData}/wechat-processed-messages.json`，实现参考 [feishuProcessedStore.ts](file:///e:/Develop/SpaceAssistant/electron/feishu/feishuProcessedStore.ts)：

```typescript
interface WeChatProcessedMessageEntry {
  messageId: string
  processedAt: number
}
```

| 策略 | 说明 |
|------|------|
| 保留期 | 7 天（`RETENTION_MS = 7 * 24 * 60 * 60 * 1000`） |
| 清理时机 | 每次加载时自动清理过期条目 |
| 写入方式 | 先写 `.tmp` 临时文件，再 rename 原子替换 |

### 11.4 依赖版本

| 包 | 版本策略 |
|----|---------|
| `@wechatbot/wechatbot` | 锁定 minor 版本；随应用发版更新 |
| QR 渲染（渲染进程） | 随渲染进程依赖 |

---

## 12. IPC 接口设计

| 通道 | 方向 | 说明 |
|------|------|------|
| `wechat:detect-sdk` | invoke | 检测 SDK 是否可加载，返回 `{ available, version? }` |
| `wechat:login-start` | invoke | 开始 login 流程 |
| `wechat:login-stop` | invoke | 取消进行中的 QR 流程 |
| `wechat:logout` | invoke | 清除凭证并断开 |
| `wechat:connection-status` | invoke | `{ loggedIn, botIdSuffix?, pollState, lastError? }` |
| `wechat:poll-start` | invoke | 启动监听（需已登录） |
| `wechat:poll-stop` | invoke | 停止监听 |
| `wechat:qr-url` | main → renderer | 推送 QR URL |
| `wechat:login-progress` | main → renderer | `waiting \| scanned \| confirmed \| expired \| verify_code` |
| `wechat:inbound-message` | main → renderer | 入站消息（UI 通知、会话列表刷新） |
| `wechat:audit-query` | invoke | 操作记录查询（对齐飞书 audit），参数 `{ since?: number; types?: string[]; limit?: number }`，返回 `WeChatAuditQueryResult` |
| `wechat:audit-tail` | invoke | 最新操作记录查询，参数 `{ limit?: number }`，返回 `WeChatAuditEvent[]` |
| `wechat:send` | invoke | Agent 工具调用主动发送，参数 `{ userId, text, imagePath?, filePath? }`，返回 `{ success, chunksSent? }` |
| `wechat:reply` | invoke | Agent 工具调用回复当前会话，参数 `{ text, imagePath?, filePath? }`，返回 `{ success, chunksSent? }` |
| `wechat:confirm-request` | main → renderer | 远程确认请求推送，参数 `{ requestId, type, description, timestamp }` |
| `wechat:confirm-response` | invoke | 桌面确认响应，参数 `{ requestId, approved: boolean }` |
| `wechat:polling-stats` | main → renderer | 轮询统计推送，参数 `{ processedCount, startedAt, lastInboundAt?, averageLatencyMs? }` |

配置读写复用 `config:get` / `config:set`，扩展 `wechat` 字段。

---

## 13. UI 与交互设计

### 13.1 聊天界面

| 元素 | 说明 |
|------|------|
| 会话列表 | `source=wechat` 显示微信图标角标 |
| 会话标题 | 前缀 `[微信]` |
| 首条消息 | 展示原始远程指令 + 发送者 userId（可脱敏） |
| 工具卡片 | `wechat_send` 展示目标 userId 与内容摘要；走确认流 |

### 13.2 远程监听状态栏（双通道合并，Phase 2）

> **交付阶段说明**：双通道合并状态栏为 **Phase 2** 交付项。Phase 1 微信状态仅在设置页「微信遥控」Tab 中展示；若飞书独立状态栏已实现，Phase 1 期间两者各自独立展示，互不影响。Phase 2 发布时，双通道合并状态栏 `RemoteStatusBar` 将替换原独立的飞书状态栏。

**关联文档说明**：本文档 §13.2 的双通道状态栏设计将 supersede [feishu-remote-status-sidebar-requirement.md](./feishu-remote-status-sidebar-requirement.md)。飞书独立状态栏需求在 Phase 2 实施前仍有效，实施时需按本文档设计合并。

将飞书与微信远程监听状态**合并为统一的「远程通道」状态栏**，替换原独立的飞书状态栏，避免垂直空间浪费。

#### 13.2.1 布局与位置

在右侧 `DetailPanel` 引用文件面板下方，保持原状态栏固定高度（32px），内部展示双通道状态：

```text
detail-panel-bottom
├── ReferencedFilesPanel（flex: 1; min-height: 0）
└── RemoteStatusBar（flex-shrink: 0; 固定高度 32px）
    ├── .remote-status-main（可点击，flex: 1; min-width: 0）
    │   ├── .remote-status-channels（双通道状态，横向排列）
    │   │   ├── [飞书] ● 监听中
    │   │   └── [微信] ● 未连接
    │   └── .remote-status-sub（副信息，可选）
    └── .remote-status-actions（flex-shrink: 0; 按钮组）
        ├── Button「启动」/「停止」（针对活动通道）
        └── Button「操作记录」
```

#### 13.2.2 双通道展示规则

**核心原则**：状态栏仅显示**正在工作的通道**，未连接/未启用的通道不占用空间。

| 通道状态组合 | 展示策略 |
|-------------|---------|
| 飞书监听中 + 微信轮询中 | 并排显示两个通道（图标 + 标签 + 指示点） |
| 飞书监听中 + 微信未连接 | **仅显示飞书通道**（微信隐藏） |
| 飞书未连接 + 微信轮询中 | **仅显示微信通道**（飞书隐藏） |
| 飞书监听中 + 微信出错 | 显示飞书通道 + 微信错误指示（红色） |
| 飞书出错 + 微信轮询中 | 显示微信通道 + 飞书错误指示（红色） |
| 两者均未启用/未连接 | 显示灰色提示「远程监听未启用」→ 点击打开设置 |
| 两者均出错 | 并排显示两个错误状态 |

**「工作中」判定标准**：

| 状态 | 是否视为「工作中」 |
|------|-------------------|
| 监听中 / 轮询中 | 是 |
| 正在连接 | 是（显示脉冲动画） |
| 已停止但已启用 | 否（隐藏） |
| 未启用 / 未登录 | 否（隐藏） |
| 出错 | 是（显示错误状态，但允许隐藏在紧凑模式下） |

**用户体验说明**：
- 用户只关心正在工作的通道，未连接的通道在设置页管理即可
- 若用户需要查看所有通道状态，可点击状态栏打开设置页查看完整信息

#### 13.2.3 通道状态指示

每个通道的状态指示与各自独立状态栏一致：

| 通道 | 状态 | 指示点颜色 | 文案 |
|------|------|-----------|------|
| 飞书 | 未配置 | 灰色 | `飞书：未配置` |
| 飞书 | 已停止 | 灰色 | `飞书：已停止` |
| 飞书 | 监听中 | 绿色（connecting 时脉冲） | `飞书：监听中` |
| 飞书 | 出错 | 红色 | `飞书：出错` |
| 微信 | 未启用 | 灰色 | `微信：未启用` |
| 微信 | 未登录 | 灰色 | `微信：未连接` |
| 微信 | 轮询中 | 绿色（connecting 时脉冲） | `微信：监听中` |
| 微信 | 出错 | 红色 | `微信：出错` |

#### 13.2.4 交互设计

| 用户操作 | 目标区域 | 行为 |
|----------|----------|------|
| 单击 | 状态栏主体 | 打开设置 Modal；若仅一个通道启用则自动选中对应 Tab；若两个都启用则选中上次打开的 Tab 或默认飞书 |
| 单击 | 飞书通道区域 | 打开设置 → 飞书 Tab |
| 单击 | 微信通道区域 | 打开设置 → 微信 Tab |
| 悬停 | 出错通道 | 显示对应通道的完整错误 Tooltip |
| 悬停 | 监听中通道 | 显示副信息（如「已处理 12 条」） |
| 单击 | 「启动」/「停止」 | 针对当前活动通道执行操作；若两通道均在监听中，则停止按钮影响两通道；若仅一个在监听中，启停按钮仅影响该通道 |
| 单击 | 「操作记录」 | 打开当前选中通道的操作记录；若两通道均启用，可切换显示 |

#### 13.2.5 按钮启用规则

| 场景 | 启动按钮 | 停止按钮 | 说明 |
|------|---------|---------|------|
| 两通道均未配置/未启用 | 禁用 | 禁用 | 需先在设置中启用 |
| 仅飞书在监听中 | 禁用（飞书） | 启用（飞书） | 启停按钮仅控制飞书 |
| 仅微信在轮询中 | 禁用（微信） | 启用（微信） | 启停按钮仅控制微信 |
| 两通道均在监听中 | 禁用 | 启用（双通道） | 停止按钮同时停止两通道 |
| 飞书监听中 + 微信已停止 | 启用（微信） | 启用（飞书） | 启动按钮控制微信，停止按钮控制飞书 |

#### 13.2.6 组件重构

| 组件 | 职责 |
|------|------|
| `RemoteStatusBar`（新增） | 双通道状态聚合、轮询、Tooltip、点击跳转设置、启停与操作记录按钮 |
| `FeishuRemoteStatusBar`（改造） | 抽取为飞书单通道状态渲染组件 |
| `WeChatRemoteStatusBar`（新增） | 微信单通道状态渲染组件 |
| `FeishuAuditDrawer`（复用） | 飞书操作记录 |
| `WeChatAuditDrawer`（新增） | 微信操作记录 |
| `useFeishuRemoteDisplayStatus`（复用） | 飞书状态判定与数据刷新 |
| `useWeChatRemoteDisplayStatus`（新增） | 微信状态判定与数据刷新 |

#### 13.2.7 宽度适配策略

由于未工作通道自动隐藏，宽度压力大幅降低，仅需两级适配：

| 宽度阈值 | 展示策略 | 说明 |
|---------|---------|------|
| ≥ 240px | 正常展示 | 单通道完整展示；双通道并排展示（仅两通道同时工作时） |
| < 240px（窗口过窄） | 紧凑模式 | 图标替代文字标签，隐藏副信息和操作记录 |

**正常模式（≥ 240px）：**

| 场景 | 展示内容 | 示例 |
|------|---------|------|
| 单通道工作 | 通道标签 + 指示点 + 状态 + 副信息 + 按钮组 | `飞书 ● 监听中 · 已处理 12 [启动] [停止] [操作记录]` |
| 双通道工作 | 双通道标签 + 指示点 + 状态 + 按钮组 | `飞书 ● 监听中 微信 ● 轮询中 [启动] [停止] [操作记录]` |

**紧凑模式（< 240px）：**

| 元素 | 正常模式 | 紧凑模式 |
|------|---------|---------|
| 通道标签 | 「飞书」「微信」文字 | 飞书图标 + 微信图标 |
| 状态指示 | 指示点 + 文字 | 仅指示点（状态文字隐藏） |
| 副信息 | 「已处理 12 条」 | 隐藏 |
| 按钮组 | 启动/停止/操作记录 | 启动/停止（图标化，操作记录隐藏） |

**CSS Container Query 方案：**

```css
.remote-status-bar {
  container-type: inline-size;
  container-name: remote-status;
}

/* 紧凑模式：窗口过窄时 */
@container remote-status (max-width: 239px) {
  .remote-status-channel-label { display: none; }
  .remote-status-channel-icon { display: inline-flex; }
  .remote-status-label-value { display: none; }
  .remote-status-sub { display: none; }
  .remote-status-action-audit { display: none; }
  .remote-status-action-btn { padding: 0 4px; font-size: 0; }
}
```

#### 13.2.8 双通道操作记录设计

**核心原则**：使用统一的操作记录抽屉，支持通道切换标签页；单通道时直接打开对应通道记录，双通道时默认显示上次选中的通道。

#### 13.2.8.1 抽屉布局

```text
RemoteAuditDrawer
├── Drawer.header
│   ├── title: "远程操作记录"
│   └── Tabs: [飞书] [微信]  ← 通道切换
├── Drawer.body
│   └── Table（根据选中通道显示对应记录）
└── Drawer.footer（或 extra）
    └── Button「刷新」
```

#### 13.2.8.2 通道切换规则

| 场景 | 打开行为 |
|------|---------|
| 仅飞书启用 | 直接打开飞书记录，不显示切换标签 |
| 仅微信启用 | 直接打开微信记录，不显示切换标签 |
| 两通道均启用 | 显示切换标签，默认选中上次打开的通道（或飞书） |
| 从状态栏点击操作记录 | 自动选中当前状态栏展示的通道（若双通道则选中第一个） |

#### 13.2.8.3 微信审计事件类型

| 类型 | 字段 | 说明 |
|------|------|------|
| `inbound` | messageId, chatId, senderId, accepted, reason?, ts | 入站消息 |
| `agent_start` | sessionId, messageId, ts | Agent 启动 |
| `agent_done` | sessionId, success, summaryLen, ts | Agent 完成 |
| `send` | sessionId, targetId, len, success, ts | 主动发送 |
| `reply` | sessionId, targetId, len, success, ts | 回复消息 |
| `confirm_request` | confirmId, decision?, ts | 确认请求 |
| `rate_limit` | senderId, ts | 速率限制 |

#### 13.2.8.4 表格列设计

| 列 | 飞书记录 | 微信记录 |
|----|---------|---------|
| 时间 | `ts` → 本地化时间 | `ts` → 本地化时间 |
| 类型 | 事件类型标签 | 事件类型标签 |
| 详情 | 飞书专用渲染 | 微信专用渲染 |
| 通道标识 | 隐藏（单通道） | 隐藏（单通道） |

**详情列渲染规则：**

| 事件类型 | 飞书渲染 | 微信渲染 |
|---------|---------|---------|
| `inbound` | `✓/✗ reason` | `✓/✗ reason` |
| `agent_start` | `sessionId` | `sessionId` |
| `agent_done` | `✓/✗ summaryLen 字` | `✓/✗ summaryLen 字` |
| `lark_cli` | `✓/✗ args` | - |
| `send` | - | `✓/✗ targetId` |
| `reply` | `✓/✗ len 字` | `✓/✗ len 字` |
| `confirm_request` | `decision/pending` | `decision/pending` |
| `rate_limit` | `senderOpenId` | `senderId` |

#### 13.2.8.5 组件重构

| 组件 | 职责 |
|------|------|
| `RemoteAuditDrawer`（新增） | 统一操作记录抽屉，包含通道切换 Tabs |
| `FeishuAuditDrawer`（改造） | 抽取为飞书单通道记录渲染组件（原抽屉内容） |
| `WeChatAuditDrawer`（新增） | 微信单通道记录渲染组件 |

#### 13.2.8.6 IPC API 设计

```typescript
// 微信审计查询（与飞书对齐，命名与 §12 IPC 通道保持一致）
wechat:audit-query: (opts: { since?: number; types?: string[]; limit?: number }) => Promise<WeChatAuditQueryResult>
wechat:audit-tail: (limit?: number) => Promise<WeChatAuditEvent[]>
```

#### 13.2.9 与飞书远程状态栏需求的差异

| 维度 | 原飞书独立状态栏 | 新双通道状态栏 |
|------|-----------------|---------------|
| 高度 | 32px | 32px（保持不变） |
| 位置 | 引用文件面板下方 | 引用文件面板下方（保持不变） |
| 单通道展示 | 完整展示（标签 + 指示 + 副信息 + 按钮） | 简化展示（图标 + 标签 + 指示点） |
| 双通道展示 | 不支持 | 并排显示（含三级宽度适配） |
| 按钮组 | 启动/停止/操作记录 | 启动/停止/操作记录（根据宽度动态显示） |
| 点击跳转 | 打开飞书设置 | 根据点击区域打开对应通道设置 |

### 13.3 通知

| 事件 | 通知内容 |
|------|---------|
| 收到远程指令 | 「微信：{指令摘要}」 |
| 任务完成 | 「微信任务已完成：{sessionTitle}」（窗口未聚焦时） |
| 会话过期 | 「微信登录已过期，请重新扫码」 |
| 监听停止 | 「微信监听已停止」 |

### 13.4 空状态引导

未连接时，设置 Tab 展示三步：启用集成 → 扫码连接 → 启动远程监听。

---

## 14. 安全与权限

### 14.1 威胁模型

| 威胁 | 缓解 |
|------|------|
| 未授权用户发远程指令 | 可选 userId 白名单；Bot 仅绑定用户自己的微信 |
| 远程恶意写本地文件 | 默认 `remoteAllowLocalWrite=false` |
| 远程滥用发微信 | `remote_read_only` + 出站工具需确认 |
| 消息重放 | messageId 去重 |
| 速率滥用 | SDK 中间件 + 配置化限流 |
| 凭证泄露 | 存 `{userData}/wechatbot/`，敏感字段（如 `bot_token`）参考 API Key 加密方式使用 Electron `safeStorage` API 加密；不入 SQLite 明文；日志脱敏 |
| 多实例游标冲突 | 单进程单实例 poll；启动时检测重复实例并提示 |
| 路径注入 | `wechat_send` / `wechat_reply` 的媒体路径需经过 [pathSecurity.ts](file:///e:/Develop/SpaceAssistant/electron/pathSecurity.ts) 的安全校验，确保在 `workDir` 范围内 |

### 14.2 多开实例检测

**产品行为：**

| 场景 | 行为 |
|------|------|
| 检测到重复实例 | 弹出警告对话框：「检测到 SpaceAssistant 已在运行。微信遥控功能仅支持单实例运行，多实例可能导致消息重复处理或游标冲突。」 |
| 用户选择继续 | 允许启动，但微信监听自动禁用（`remoteEnabled` 强制设为 `false`） |
| 用户选择切换到已有实例 | 聚焦已有窗口并关闭新实例 |

**检测机制：** 使用 Electron `app.requestSingleInstanceLock()` + 共享文件锁（`{userData}/wechatbot/.lock`）。

### 14.3 工具权限配置

扩展 `ToolsConfig.allowedTools`，新增 `wechat_reply`、`wechat_send`。`wechat.enabled === false` 时不注入。

### 14.4 审计

| 事件 | 记录 |
|------|------|
| inbound | messageId、userId、accepted、reason |
| agent_start / agent_done | sessionId、success、summaryLen |
| wechat_send / wechat_reply | userId、writeOp、success |
| login / logout / session:expired | ts、botIdSuffix |

写入 `{userData}/logs/wechat-audit.log`（JSON Lines 格式，与飞书 audit 保持一致），设置页可统一查询。

**审计日志保留策略：**

| 项 | 策略 |
|----|------|
| 保留期 | 30 天 |
| 单文件大小上限 | 10MB |
| 轮转策略 | 达到上限时自动轮转，保留最近 3 个备份文件（`.1`、`.2`、`.3`） |
| 最大条数 | 无硬限制（按大小轮转） |
| 清理时机 | 每次启动时自动清理过期日志 |

### 14.5 合规提示

设置页需展示说明：

- 微信 iLink Bot 为个人辅助通道，请遵守微信用户协议与本地法律法规。
- 勿将 Bot 用于 spam、未授权代发、收集他人隐私等用途。
- SpaceAssistant 不存储微信聊天全量历史于云端，仅本地会话与审计。

---

## 15. 非功能需求

| 类别 | 要求 |
|------|------|
| 性能 | 长轮询使用非阻塞实现（SDK 内置 worker_threads），主线程不阻塞 UI；单条远程指令首响 < 5s（不含 LLM） |
| 可靠性 | 网络断开后 SDK 退避重试；`-14` 自动 re-login 或提示扫码 |
| 兼容 | Windows / macOS / Linux；Node ≥ 22 |
| 离线 | 无网络时监听暂停，UI 显示断开 |
| 存储 | `storageDir` 随 userData 迁移；卸载时可选手动清除 |
| 国际化 | 设置与通知 zh-CN；i18n key 命名遵循 `settings.wechat.*` 前缀 |
| 与飞书并存 | 两通道独立配置、独立状态栏、共享 RemoteAgent 模式但不共享会话 |

### 15.1 i18n key 清单

| Key | 中文值 | 位置 |
|-----|--------|------|
| `settings.wechat.tabTitle` | 微信遥控 | 设置页 Tab 名称 |
| `settings.wechat.description` | 通过微信遥控桌面 Agent | 价值引导区 |
| `settings.wechat.bindButton` | 绑定微信 | 未绑定状态按钮 |
| `settings.wechat.boundStatus` | 已绑定 · {displayName} | 已绑定状态文本 |
| `settings.wechat.rebindButton` | 重新绑定 | 已绑定状态按钮 |
| `settings.wechat.unbindButton` | 解绑 | 已绑定状态按钮 |
| `settings.wechat.unbindConfirm` | 确定要解绑微信吗？解绑后将停止接收微信消息。 | 解绑确认对话框 |
| `settings.wechat.receiveMessages` | 接收微信消息（手机发指令到桌面） | 功能开关标签 |
| `settings.wechat.statusListening` | 监听中 | 状态文本 |
| `settings.wechat.statusStopped` | 已停止 | 状态文本 |
| `settings.wechat.notifyOnReceive` | 收到消息时弹窗通知 | 复选框标签 |
| `settings.wechat.sessionMerge` | 会话合并：__{minutes}__ 分钟内同用户消息续接 | 会话合并设置 |
| `settings.wechat.allowLocalWrite` | 允许远程指令修改本地文件 | 安全设置 |
| `settings.wechat.rateLimit` | 消息频率限制：__{limit}__ 条/分钟/用户 | 速率限制设置 |
| `settings.wechat.senderAllowlist` | 发送者白名单：（可选，微信号列表） | 白名单设置 |
| `settings.wechat.qrExpired` | 二维码已过期，点击重新获取 | QR 过期提示 |
| `settings.wechat.networkFailed` | 网络连接失败，请检查网络后重试 | 网络错误提示 |
| `settings.wechat.waitingScan` | 等待扫描 | 扫码进度 |
| `settings.wechat.scannedConfirm` | 已扫描，请在手机确认 | 扫码进度 |
| `settings.wechat.boundSuccess` | 绑定成功 | 绑定成功提示 |
| `settings.wechat.loginFailed` | 登录失败，请检查网络或重新扫码 | 登录失败提示 |
| `settings.wechat.accountError` | 账号异常，请稍后重试或更换微信号 | 账号异常提示 |
| `settings.wechat.sessionExpired` | 微信登录已过期，请重新扫码 | 会话过期提示 |
| `settings.wechat.policyReadOnly` | 仅读取（不修改文件） | 安全策略描述 |
| `notifications.wechat.received` | 微信：{指令摘要} | 收到指令通知 |
| `notifications.wechat.completed` | 微信任务已完成：{sessionTitle} | 任务完成通知 |
| `notifications.wechat.sessionExpired` | 微信登录已过期，请重新扫码 | 会话过期通知 |
| `notifications.wechat.listeningStopped` | 微信监听已停止 | 监听停止通知 |

---

## 16. 发布计划

### Phase 1 — MVP（入站 + 内部回复）

**核心交付范围：** 入站指令完整闭环，远程触发的 Agent 执行完成后通过内部服务自动回复摘要；Agent 可调用的出站工具推迟到 Phase 2。

| 交付项 | 说明 |
|--------|------|
| `@wechatbot/wechatbot` 依赖集成 | 主进程 WeChatBotService |
| 设置页微信 Tab | QR 登录、启停监听、解绑流程 |
| WeChatCommandRouter | 文本指令、去重、新会话 |
| WeChatRemoteAgent | typing + 内部摘要 reply（`WeChatReplyService`） |
| `wechat_confirm` 策略（**默认**） | 远程写操作 IM Y/N 确认 + Progress 快照心跳 |
| `remote_read_only` 策略 | 禁止远程写；诚实拒绝文案 |
| 基础审计日志 | 入站/执行/回复事件记录 |

**依赖关系：**
```
Phase 1 微信入站
  ├─ 强依赖：@wechatbot/wechatbot 可用（OQ-WX-1）
  ├─ 软依赖：系统托盘（无托盘时见 §16.4）
  └─ 与飞书：共享 maxParallelChatSessions（需求已决策）
```

### Phase 2 — 增强

| 交付项 | 说明 |
|--------|------|
| `wechat_send` / `wechat_reply` 桌面工具 | Agent 可调用，含确认流 |
| 富媒体入站 | 图片/文件下载注入 Agent |
| 会话合并 | 同 userId 续聊 |
| 发送者白名单 | |
| 远程状态栏 | 双通道合并 `RemoteStatusBar`，替换飞书独立状态栏 |
| 配对码 UI | verify_code 流程 |
| 微信内写操作 IM 确认 | 与 [remote-progress-activity-sync-requirement.md](./remote-progress-activity-sync-requirement.md) Phase A 交付（**非** Phase 2 可选项） |

### Phase 3 — 可选

| 交付项 | 说明 |
|--------|------|
| 多工作目录路由 | 指令内 `@项目名` |
| 语音转写 | silk-wasm |
| 多账号 | storageDir 隔离 + UI 切换 |
| 与 OpenClaw 插件互导配置 | |

### 16.4 系统托盘依赖与降级行为

| 场景 | 行为 |
|------|------|
| **托盘已实现** | 主窗口关闭后自动转入后台，继续长轮询接收微信指令 |
| **托盘未就绪**（Phase 1 降级） | 主窗口关闭后监听暂停；重新打开窗口时自动恢复监听；设置页提示「请保持窗口打开以接收微信指令」 |
| **托盘开发中** | 建议并行开发；若 Phase 1 发布时托盘未完成，采用上述降级行为 |

---

## 17. 验收标准

### 17.1 连接与监听

- [ ] 设置页扫码后显示「已绑定 · {微信昵称}」，重启应用无需重新扫码（凭证有效时自动恢复）
- [ ] 启动监听后 `connection-status` 为 polling
- [ ] 停止监听后不再处理新消息
- [ ] 会话过期（-14）后 UI 提示重新登录

### 17.2 入站（手机遥控，Phase 1）

- [ ] 手机微信向 Bot 发送「列出工作目录下的 txt 文件」可触发 Agent 并收到文本摘要
- [ ] 桌面自动创建 `[微信]` 标记会话，可查看工具调用过程
- [ ] 重复 messageId 不重复执行
- [ ] 远程触发的写操作在 `wechat_confirm` 下收到 IM Y/N 提示，回复 Y 后继续执行
- [ ] `remote_read_only` 下写操作被拒绝，文案不引导「请打开桌面」
- [ ] Agent 执行期间微信侧可见「对方正在输入中…」（可配置关闭）
- [ ] 主窗口关闭后（托盘后台）仍可接收并处理指令；若无托盘则监听暂停，重新打开窗口自动恢复

### 17.3 内部回复（Phase 1）

- [ ] 入站指令完成后，微信侧收到摘要回复（默认取最后一条 assistant 消息文本）
- [ ] 摘要超 2000 字自动分片，微信侧顺序可读
- [ ] 摘要末尾附引导文案「完整过程请查看 SpaceAssistant 桌面会话」

### 17.4 出站（Agent 工具，Phase 2）

- [ ] 桌面会话中「把 x.txt 发给微信用户 xxx」经确认后成功发送
- [ ] 禁用微信集成后工具不可调用

### 17.5 安全

- [ ] `bot_token` 不出现在 SQLite 消息正文或聊天 UI
- [ ] 审计日志不含用户消息全文（可配置摘要长度）
- [ ] 速率超限后回复 throttled 提示且不启动 Agent

---

## 18. 测试计划

### 18.1 测试策略

参考飞书集成的测试模式（[feishuRemoteAgent.test.ts](file:///e:/Develop/SpaceAssistant/electron/feishu/feishuRemoteAgent.test.ts)），采用 Vitest 进行单元测试和集成测试。

### 18.2 测试文件规划

| 文件 | 测试内容 | 环境 | 阶段 |
|------|---------|------|------|
| `electron/wechat/weChatBotService.test.ts` | SDK 封装层：login、start/stop、事件回调 | node | Phase 1 |
| `electron/wechat/weChatCommandRouter.test.ts` | 路由逻辑：过滤、去重、会话映射、并发控制 | node | Phase 1 |
| `electron/wechat/weChatRemoteAgent.test.ts` | 远程 Agent 执行：typing、摘要回传、错误处理 | node | Phase 1 |
| `electron/wechat/weChatReplyService.test.ts` | 回复服务：分片发送、Markdown 清理 | node | Phase 1 |
| `electron/tools/weChatToolExecutor.test.ts` | 工具执行：路径安全校验、确认策略 | node | Phase 2 |

### 18.3 核心测试场景

| 场景 | 测试要点 |
|------|---------|
| **登录流程** | QR URL 获取、扫码状态轮询、凭证持久化、自动恢复 |
| **入站路由** | 文本指令解析、类型过滤、去重、并发上限拒绝 |
| **远程执行** | Agent 启动、typing 发送、摘要回传、失败处理 |
| **出站工具** | 路径安全校验、确认策略、长文本分片 |
| **会话合并** | `remoteSessionMergeMinutes` 策略验证 |
| **安全策略** | `remote_read_only` 拒绝写操作、速率限制 |
| **异常恢复** | 网络断开重连、会话过期 re-login |

### 18.4 测试环境要求

- 测试环境不依赖真实微信账号，使用 Mock SDK
- Mock SDK 需模拟：login、onMessage、reply、send、session:expired 等核心 API
- 数据库使用内存 SQLite（`better-sqlite3` 内存模式）

---

## 19. 待解决问题跟踪

| ID | 问题 | 当前状态 | 建议/决策 |
|----|------|---------|-----------|
| OQ-WX-1 | Electron 主进程 Node 版本是否 ≥ 22？ | **P0 待验证** | 构建链验证；不足则评估 SDK 降级或 fetch polyfill |
| OQ-WX-2 | `@wechatbot/wechatbot` 打包方式：dependencies vs optional？ | **P1 已决策** | 默认 dependencies；体积与许可证 MIT 已确认 |
| OQ-WX-3 | 主动 `wechat_send` 无 context_token 时协议是否允许？ | **P1 待实测** | Phase 1 仅 reply；Phase 2 实测 `send()` 能力边界 |
| OQ-WX-4 | 远程指令默认模型是否与飞书共用 `remoteDefaultModelId`？ | **P0 已决策** | 在 `WeChatConfig` 中新增 `remoteDefaultModelId` 配置项，空=使用全局默认 |
| OQ-WX-5 | 飞书与微信远程同时启用时的并行上限如何分配？ | **P1 已决策** | 共享全局 `maxParallelChatSessions` 上限，FIFO 先进先出 |
| OQ-WX-6 | QR 展示在设置页 vs 独立 Modal？ | **P2 已决策** | Phase 1 设置页内嵌；连接中可从状态栏跳转 |
| OQ-WX-7 | iLink Bot 是否支持群聊？ | **P2 待确认** | 第一期按 1:1 设计；协议确认后 Phase 2 扩展 |
| OQ-WX-8 | 是否与 `@wechatbot/pi-agent` 共享 storageDir？ | **已决策** | ✅ 禁止共用；SpaceAssistant 独立目录避免冲突 |
| OQ-WX-9 | Phase 1 是否必须交付双通道 `RemoteStatusBar`，还是仅设置页展示微信状态？ | **P0 已决策** | Phase 1 仅设置页展示；双通道状态栏为 Phase 2 交付项 |
| OQ-WX-10 | 远程指令默认 `workDir` 与多工作目录 Profile 的 Phase 1 行为 | **P0 已决策** | Phase 1 使用全局默认 workDir；多工作目录路由为 Phase 3 交付项 |
| OQ-WX-11 | 微信远程确认 | **P1 已决策（v1.7 更新）** | 远程写操作 **IM Y/N**（`wechat_confirm`）；桌面卡片可选同步；见 remote-progress §6.4 |
| OQ-WX-12 | 「发给张三」类自然语言目标的合法解析范围（仅历史会话 / 白名单备注名 / 不支持） | **P1 已决策** | Phase 1 仅支持历史 userId（从会话 metadata 获取）；Phase 2 支持白名单备注名匹配；自然语言姓名解析暂不支持 |

---

## 20. 关联需求文档增量变更

### 20.1 settings-requirement.md 增量

| 变更项 | 说明 | 优先级 |
|--------|------|--------|
| 新增微信 Tab | Tab 列表新增「微信遥控」，内容包含绑定状态、监听开关、安全策略 | P0 |
| 设置 Modal 打开指定 Tab | 支持从状态栏或通知直接打开设置并定位到微信 Tab | P1 |
| 双通道状态栏联动 | 远程状态栏点击跳转设置时自动选中对应通道 Tab | P2 |
| 工具权限项扩展 | 安全设置中展示 `wechat_send` / `wechat_reply` 的确认策略配置 | P1 |

### 20.2 tools-requirement.md 增量

| 变更项 | 说明 | 优先级 |
|--------|------|--------|
| 新增工具定义 | 注册 `wechat_send` 和 `wechat_reply` 工具 schema | P0 |
| 工具可用性规则 | `wechat.enabled === false` 时不注入；远程只读策略下限制调用 | P0 |
| 确认策略归类 | 将微信出站工具纳入远程确认策略管理 | P1 |

### 20.3 feishu-remote-status-sidebar-requirement.md

本文档 §13.2 的双通道合并状态栏设计将 supersede 飞书独立状态栏需求。**已在飞书状态栏文档文首加注废弃声明与 Phase 2 迁移说明**（状态标记为「已废弃」），开发人员应以本文档为准。

---

## 21. 相关文件

| 类型 | 路径（规划） |
|------|-------------|
| 微信服务 | `electron/wechat/weChatBotService.ts` |
| 入站路由 | `electron/wechat/weChatCommandRouter.ts` |
| 远程 Agent | `electron/wechat/weChatRemoteAgent.ts` |
| 回复 | `electron/wechat/weChatReplyService.ts` |
| 工具执行 | `electron/tools/weChatToolExecutor.ts` |
| 配置类型 | `src/shared/wechatTypes.ts` |
| IPC | `electron/wechat/weChatIpc.ts`、`electron/preload.ts` |
| 设置 UI | `src/renderer/components/Config/WeChatSettingsTab.tsx` |
| 参考实现 | `electron/feishu/*`（飞书远程指令） |
| 上游 SDK | https://github.com/corespeed-io/wechatbot |

---

**文档结束**
