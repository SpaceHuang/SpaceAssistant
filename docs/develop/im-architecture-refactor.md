# IM 接入架构重构方案

> 版本：v2.1（根据 v2 评审意见微调）
> 日期：2026-07-13
> 状态：草案
> 范围：架构重构（不引入新功能）
> 评审参考：[im-architecture-refactor-review.md](../review/im-architecture-refactor-review.md)

---

## 1. 背景与问题

SpaceAssistant 当前支持飞书和微信两个 IM 渠道接入。两者在 Electron 主进程中分别由 `electron/feishu/` 和 `electron/wechat/` 两套独立目录实现，部分共享逻辑已在 `electron/remote/` 和 `src/shared/` 中提取。

接入微信时以飞书实现为模板复制了一套，导致大量结构相同、仅平台前缀不同的平行代码。这种复制式架构带来三类问题：

1. **维护成本翻倍**--每次修改通用逻辑（限流、去重、确认超时、进度推送、审计日志轮转等）都要在两处同步修改，极易遗漏。
2. **设置项重复**--`FeishuConfig` 和 `WeChatConfig` 有约 15 个字段完全相同，用户在设置页需要为两个渠道分别填写相同的值。
3. **新增渠道成本高**--如果要接入第三渠道，需要再复制一整套文件。

**已有共享层**（v1.0 未充分反映，本次修正）：

项目并非"零共享"--`electron/remote/` 已有 14 个非测试模块承载进度协调、确认桥接、会话守卫、出站格式等逻辑；`src/shared/` 已有 `remoteProgressTypes.ts`（含 `RemoteProgressConfig` + `mergeRemoteProgressConfig`）、`remoteConfirmPolicy.ts`（含 `ResolvedRemoteConfirmPolicy = 'im_confirm' | 'remote_read_only'`）、`remoteSessionResolve.ts`、`remoteOutboundFormat.ts` 等成熟模块。本方案在此基础上增量扩展，**不新建平行目录**。

---

## 2. 重复清单

### 2.1 基础设施层（近乎完全重复）

| 模块 | 飞书文件 | 微信文件 | 重复率 | 差异点 |
|------|----------|----------|--------|--------|
| CLI 日志器 | `feishu/feishuCliLogger.ts` (112行) | `wechat/weChatCliLogger.ts` (112行) | ~95% | 日志文件名、事件前缀 |
| 已处理消息存储 | `feishu/feishuProcessedStore.ts` (59行) | `wechat/weChatProcessedStore.ts` (56行) | ~95% | JSON 文件名、日志函数 |
| CLI 日志字段 | `feishu/feishuCliLogFields.ts` (117行) | `wechat/weChatCliLogFields.ts` | ~60% | `contentHash`/`previewText` 完全相同；`preprocessXxxCliFields` 字段不同 |
| CLI 日志路径 | `feishu/feishuCliLogPaths.ts` | `wechat/weChatCliLogPaths.ts` | ~90% | 文件名前缀 |

**审计日志器**（重复率 ~70%，非 v1.0 所述 ~85%）：

| 差异 | 飞书 | 微信 |
|------|------|------|
| 文件大小上限 | 5MB | 10MB |
| 备份数 | 5 | 3 |
| 过期清理 | 无 | `purgeExpired` 30 天保留 |
| 查询返回 | `{ entries, truncated }` | `{ events, total }` |

差异足够显著，参数化时需保留 opts 差异，不强行统一返回结构。

### 2.2 流程逻辑层（结构相似，平台细节不同）

| 模块 | 飞书文件 | 微信文件 | 核心流程重复率 | 说明 |
|------|----------|----------|--------------|------|
| 远程 Agent | `feishuRemoteAgent.ts` (169行) | `weChatRemoteAgent.ts` (351行) | ~60% | 微信含 botService、inboundRaw、typing、更复杂 progress 初始化；平台胶水代码占比高 |
| 确认管理器 | `feishuConfirmManager.ts` (223行) | `weChatConfirmManager.ts` (178行) | ~70% | 匹配键(chatId vs userId)、提示构建、桌面确认(仅微信)、`requestConfirm` 签名不同 |
| 会话解析器 | `feishuSessionResolver.ts` | `weChatSessionResolver.ts` | ~75% | 元数据结构、匹配键(chatId vs userId)、workDirProfile 绑定 |
| 命令路由器 | `remoteCommandRouter.ts` (394行) | `weChatCommandRouter.ts` (364行) | ~40% | 公共骨架（限流/去重/claim/agent）约 40%；平台专属（消歧、媒体、inbound 解析）约 60% |
| 进度适配器 | `remote/feishuProgressAdapter.ts` | `remote/weChatProgressAdapter.ts` | ~75% | **已在 `electron/remote/`**，已依赖 `RemoteProgressAdapter` 接口 |
| 远程出站 | `feishuRemoteOutbound.ts` (42行) | `weChatRemoteOutbound.ts` (49行) | ~70% | 最大长度(4000 vs 2000)、截断后缀、回复机制 |

### 2.3 配置与 UI 层

`FeishuConfig` 和 `WeChatConfig` 共享以下字段（定义和默认值相同）：

```
remoteEnabled, remoteNotifyOnReceive, remoteConfirmPolicy, remoteAllowLocalWrite,
remoteSessionIdleMinutes, remoteSessionMergeMinutes, remoteRateLimitPerMinute,
remoteDefaultModelId, remoteSenderAllowlist, remoteCommandPrefix,
remoteProgressMode, remoteProgressHeartbeatSec, remoteTypingEnabled,
remoteProgressMinIntervalSec, remoteProgressMaxChars, remoteProgressFallbackText
```

注意：进度相关 6 个字段已在 `src/shared/remoteProgressTypes.ts` 的 `RemoteProgressConfig` 中定义。`RemoteImCommonConfig` 应组合该类型，不重新定义。

平台专属字段：飞书有 `cliPath`、`appConfigured`、`userAuthorized`、`region`、`wakeWords`、`remoteGroupTrigger`、`integrationMode`、`larkCliDefaultTimeoutSec` 等；微信有 `loggedIn`、`botIdSuffix`、`displayName`、`remoteAckOnReceive`、`wechatSendRequiresConfirm` 等。

**设置 UI**--`FeishuSettingsTab.tsx` 和 `WeChatSettingsTab.tsx` 共享以下控件块：`remoteNotifyOnReceive`、`sessionIdle`、`remoteDefaultModel`、远程进度折叠面板、`remoteAllowLocalWrite`、`remoteConfirmPolicy`、`remoteSenderAllowlist`（仅微信有 UI）、`remoteRateLimitPerMinute`（仅微信有 UI）、审计抽屉按钮。

### 2.4 IPC 通道层

`feishu:*` 和 `wechat:*` 通道对以下功能有平行实现：
- `audit-tail` / `audit-query`
- `pending-confirms` / `cancel-confirm`（飞书）vs `confirm-response`（微信）
- `on-inbound-message` / `on-remote-agent-start` / `on-pending-confirm` / `on-agent-done`

平台专属 IPC（飞书 CLI 安装/认证/事件、微信扫码/轮询）差异本质，不纳入统一范围。

### 2.5 LLM 凭据解析重复（已确认的 bug 修复重复）

远程 Agent 获取 APIKey 的逻辑与桌面路径不一致。桌面路径（`appIpc.ts` ~L1398）使用 `resolveLlmCredentialsForModel(db, modelName, { hasApiKey 谓词, 按 model 选 service })`，能根据当前模型找到支持该模型且已配置 APIKey 的 LLM 服务。远程路径此前使用 `main.ts` 中注入的 `getActiveLlmService(db).getApiKey()`，仅取第一个激活服务的 Key，不考虑模型归属，导致多服务场景下远程指令获取不到 APIKey。

修复已分别在两个远程 Agent 中落地，代码逐行一致：

**`feishuRemoteAgent.ts` L107-110**：
```typescript
const routeModelName = ctx.getModel()
const creds = await resolveLlmCredentialsForModel(ctx.db, routeModelName, {})
const baseUrl = creds.baseUrl ?? ctx.getBaseUrl()
const getApiKey = creds.error ? ctx.getApiKey : creds.getApiKey
```

**`weChatRemoteAgent.ts` L215-218**：
```typescript
const routeModelName = ctx.getModel()
const creds = await resolveLlmCredentialsForModel(ctx.db, routeModelName, {})
const baseUrl = creds.baseUrl ?? ctx.getBaseUrl()
const getApiKey = creds.error ? ctx.getApiKey : creds.getApiKey
```

两段完全相同，后续如果凭据解析策略再变（如增加 `serviceId` 透传、vision 模型路由等），又需要同步修改两处。

### 2.6 范围外的技术债（重构时一并清理）

- **`shouldAcceptInbound` 在飞书目录内重复定义**：`feishuConfirmManager.ts` L18 与 `feishuInboundParser.ts` L74 各有一份相同实现；路由器实际 import 的是 parser 版本。confirmManager 中的副本应删除。
- **`truncateTitle` 跨平台重复**：`feishuConfirmManager.ts` L51 与 `weChatInboundParser.ts` L44 各有一份完全相同的 `truncateTitle(content, max=30)` 实现。飞书 `feishuSessionResolver.ts` 从 confirmManager import，微信从 parser import。Phase 1c 统一到 parser，Phase 3a 随 `imSessionResolver` 提取后两份均删除。
- **`runningRemoteAgentRegistry` 命名与位置不当**：微信从 `../feishu/runningRemoteAgentRegistry` 引用，语义上已是共享模块，应迁到 `electron/remote/`。

---

## 3. 设计原则

1. **只做架构重构，不引入新功能**--所有现有行为保持不变。
2. **避免过度设计**--不建 God Interface、不建抽象基类；提取纯函数 + 参数化工厂，平台差异通过回调参数注入。
3. **增量迁移，保持绿色**--每个阶段独立可测、可合并。
4. **向后兼容**--DB 中已存的 `feishu` / `wechat` 配置键不做破坏性变更；统一字段通过 merge 函数兼容旧格式。
5. **扩展现有共享层**--新共享文件放 `electron/remote/`，不新建 `electron/im/` 目录，避免双共享层认知负担。
6. **测试先行**--每个提取的共享模块配套单元测试；重构前后行为通过现有测试回归验证。

---

## 4. 目标架构

### 4.1 目录策略

**扩展 `electron/remote/`，不新建 `electron/im/`。** `electron/remote/` 已承载进度协调、确认桥接、会话守卫等 IM 远程逻辑（14 个非测试模块），新提取的共享基础设施自然归入此目录。

```
electron/remote/                        # 共享 IM 远程基础设施（扩展现有）
├── imCliLogger.ts                      # [新] 参数化 CLI 日志器工厂
├── imProcessedStore.ts                 # [新] 参数化已处理消息存储
├── imAuditLogger.ts                    # [新] 参数化审计日志器（保留平台差异 opts）
├── imCliLogFields.ts                   # [新] 共享日志字段工具（contentHash、previewText 等）
├── imRemoteAgent.ts                    # [新] 共享远程 Agent 流程（含 LLM 凭据解析）
├── imRemoteOutbound.ts                 # [新] 统一出站消息截断与发送
├── imSessionResolver.ts                # [新] 共享会话解析函数
├── imRateLimit.ts                      # [新] 限流工具函数（从两个路由器提取）
├── remoteAgentRegistry.ts              # [迁] 从 feishu/runningRemoteAgentRegistry.ts 迁入
├── remoteConfirmBridge.ts              # [改] 消除 source 分支（Phase 5）
├── feishuProgressAdapter.ts            # [保留] 已在此目录
├── weChatProgressAdapter.ts            # [保留] 已在此目录
└── ...                                 # 其他现有模块保留

electron/feishu/                        # 飞书平台层（保留，瘦身）
├── feishuRemoteAgent.ts                # [改] 薄封装，委托 imRemoteAgent
├── feishuConfirmManager.ts             # [改] 删除 shouldAcceptInbound 副本
├── feishuSessionResolver.ts            # [改] 薄封装，委托 imSessionResolver
├── remoteCommandRouter.ts              # [改] 引用 imRateLimit
├── feishuIpc.ts                        # [保留] 平台专属 IPC
├── larkCliRunner.ts                    # [保留] 飞书专属
└── ...

electron/wechat/                        # 微信平台层（保留，瘦身）
├── weChatRemoteAgent.ts                # [改] 核心流程委托 runImRemoteAgent，平台胶水代码保留
├── weChatCommandRouter.ts              # [改] 引用 imRateLimit
├── weChatIpc.ts                        # [保留] 平台专属 IPC
├── weChatBotService.ts                 # [保留] 微信专属 SDK
└── ...

src/shared/
├── imTypes.ts                          # [新] RemoteImCommonConfig（组合 RemoteProgressConfig）
├── feishuTypes.ts                      # [改] 嵌入 RemoteImCommonConfig + 飞书专属字段
├── wechatTypes.ts                      # [改] 嵌入 RemoteImCommonConfig + 微信专属字段
└── ...                                 # 现有 remoteProgressTypes、remoteConfirmPolicy 等保留
```

### 4.2 平台差异处理--函数参数，非 God Interface

v1.0 的 `ImPlatformAdapter`（15+ 方法单接口）职责过宽，接近"第三渠道 SDK"形态。v2.0 不引入此接口，改为：

- **共享流程函数**接收平台差异作为**回调参数**（如 `buildSystemAppendix`、`createProgressAdapter`、`sendReply`）。
- **已有多态接口**直接复用：进度适配器已有 `RemoteProgressAdapter` 类型（`remoteProgressCoordinator.ts` L18-22），不新建。
- **确认管理器**提取 `PendingRequestRegistry<T>` 泛型工具管理 Map/resolver 生命周期，平台类内部组合使用，不继承基类。
- **命令路由器**提取 `checkRateLimit`、`tryClaimOrRelease` 等纯函数，两个路由器各自调用，不引入抽象基类。

### 4.3 配置统一

将两渠道共有的字段提取为 `RemoteImCommonConfig`，通过 **`extends RemoteProgressConfig`** 实现类型组合，不重定义进度字段，**保持 flat 布局**（零读取点变更、零 DB 结构变更）：

```typescript
// src/shared/imTypes.ts

import type { RemoteProgressConfig } from './remoteProgressTypes'

export type ImConfirmPolicy = 'inherit' | 'always' | 'remote_read_only' | 'im_confirm'

// extends RemoteProgressConfig 获得进度字段（flat），不嵌套子对象
export interface RemoteImCommonConfig extends RemoteProgressConfig {
  remoteEnabled: boolean
  remoteNotifyOnReceive: boolean
  remoteConfirmPolicy: ImConfirmPolicy
  remoteAllowLocalWrite: boolean
  remoteSessionIdleMinutes: number
  remoteSessionMergeMinutes?: number
  remoteRateLimitPerMinute: number
  remoteDefaultModelId?: string
  remoteSenderAllowlist?: string[]
  remoteCommandPrefix?: string
}
```

**为什么 flat extends 而非嵌套 `progress` 子对象**：进度字段当前以 flat 形式（`config.remoteProgressMode` 等）被 progress adapter、coordinator、两个 SettingsTab、RemoteAgent 等 5+ 个主进程文件和 UI 组件直接读取。嵌套为 `config.progress.remoteProgressMode` 会导致大量读取点变更、DB JSON 结构变化、Phase 4 UI 联动复杂化，与"只做架构重构"原则存在张力。`extends` 在类型层面实现组合（不重定义字段），在运行时保持 flat 布局（零破坏），是最小风险路径。`mergeRemoteImCommonConfig` 内部调用已有 `mergeRemoteProgressConfig` 处理进度字段。`pickFeishuProgressConfig` / `pickWeChatProgressConfig` 无需变更（仍从 flat config 提取字段）。

`FeishuConfig` 和 `WeChatConfig` 改为 `extends RemoteImCommonConfig`，各自保留平台专属字段。

**确认策略统一**：已有 `remoteConfirmPolicy.ts` 的 `ResolvedRemoteConfirmPolicy = 'im_confirm' | 'remote_read_only'` 作为运行时解析层。存储层将 `feishu_confirm` / `wechat_confirm` 统一为 `im_confirm`，merge 函数中做兼容映射。微信已有的 `resolveWeChatRemoteConfirmPolicy`、`remoteWechatConfirm` 废弃字段迁移逻辑保留复用。

**用户设置体验**：设置页新增"IM 远程通用设置"区域，通用字段在此统一设置，同时写入两个渠道配置。各平台 Tab 仅保留平台专属设置。

> **产品权衡**：双写意味着用户无法为飞书设 10 次/分钟、微信设 5 次/分钟。当前两渠道使用场景（飞书群聊 @触发 vs 微信私聊）确实有差异，但用户明确要求统一。方案采用双写策略满足"减少重复设置"的核心诉求；若未来需要 per-channel 差异，可在通用设置下方增加"各渠道覆盖"折叠区，作为后续增量。

---

## 5. 分阶段重构方案

### Phase 1：提取共享基础设施 + 快速清理（低风险）

#### 1a. CLI 日志器 / ProcessedStore / CliLogFields

1. **`imCliLogFields.ts`**--提取 `contentHash`、`previewText`、`urlHostOnly`（原 `authUrlHostOnly` / `qrUrlHostOnly` 的通用版）到共享模块。`feishuCliLogFields.ts` 和 `weChatCliLogFields.ts` 的 `preprocessXxxCliFields` 保留各自实现但复用共享工具函数。

2. **`imCliLogger.ts`**--将 CLI 日志器提取为工厂函数：

   ```typescript
   export interface ImCliLoggerConfig {
     channel: 'feishu' | 'wechat'
     logFileNamePrefix: string  // 'FeishuCli' | 'WeChatCli'
     preprocessFields: (fields: Record<string, unknown>) => Record<string, unknown>
   }
   export function createImCliLogger(config: ImCliLoggerConfig): ImCliLogger
   ```

   `feishuCliLogger.ts` / `weChatCliLogger.ts` 改为薄封装，保持导出函数签名不变。

3. **`imProcessedStore.ts`**--合并为参数化类：

   ```typescript
   export class ImProcessedStore {
     constructor(opts: { channel: 'feishu' | 'wechat'; userDataDir: string; logEvent: ImLogFn })
   }
   ```

#### 1b. 迁移 runningRemoteAgentRegistry

将 `electron/feishu/runningRemoteAgentRegistry.ts` 迁移到 `electron/remote/remoteAgentRegistry.ts`，更新所有引用方的 import 路径。纯文件移动 + import 路径更新，无逻辑变更。

受影响文件（10 处 import）：
- `electron/feishu/remoteCommandRouter.ts` + `.test.ts`
- `electron/wechat/weChatCommandRouter.ts` + `.test.ts`
- `electron/workDirBinding.ts` + `.test.ts`（`isRemoteAgentRunning`）
- `electron/appIpc.ts` + `appIpc.sessionUpdate.test.ts`（`isRemoteAgentRunning`）
- `electron/tools/workDirExecutors.test.ts`、`remoteSessionExecutors.test.ts`
- `electron/remote/remoteSessionSwitchGuard.test.ts`

#### 1c. 清理 feishu 内部 shouldAcceptInbound 重复

删除 `feishuConfirmManager.ts` 中重复的 `shouldAcceptInbound` 定义（路由器已从 `feishuInboundParser.ts` import）。

`truncateTitle` 迁移：当前 `feishuSessionResolver.ts` 从 `feishuConfirmManager` import `truncateTitle`，但 `feishuInboundParser.ts` 不含此函数（微信侧 `weChatInboundParser.ts` L44 有相同实现）。将 `truncateTitle` 从 `feishuConfirmManager.ts` 移到 `feishuInboundParser.ts`，同步更新 `feishuSessionResolver.ts` 的 import 路径为 `./feishuInboundParser`。Phase 3a 创建 `imSessionResolver.ts` 后，两平台的 `truncateTitle` 副本统一删除。

#### 1d. 参数化 AuditLogger

提取 `ImAuditLogger`，**保留平台差异 opts**：

```typescript
export class ImAuditLogger {
  constructor(opts: {
    channel: 'feishu' | 'wechat'
    userDataDir: string
    maxFileBytes: number
    maxBackups: number
    retentionMs?: number  // 微信 30 天，飞书 undefined
    logMirror: (event) => void
  })
  // 查询返回统一为 { entries: T[]; truncated: boolean }
  // 微信 query 做适配层映射
}
```

不强行统一微信的 `purgeExpired` 和不同查询返回结构；`retentionMs` 为可选参数，微信启用、飞书不传。查询返回统一为 `{ entries, truncated }`，微信侧加适配映射。

**测试**：每个共享模块配套 `.test.ts`，覆盖 init/log/flush/reset/rotate/purge/has/mark/query。原平台测试保持通过。

**预估**：2 天

---

### Phase 2：统一配置类型（中等风险）

1. **新增 `src/shared/imTypes.ts`**--定义 `RemoteImCommonConfig`（组合 `RemoteProgressConfig`）、`ImConfirmPolicy`、`ImChannel`。

2. **重构 `feishuTypes.ts`**--`FeishuConfig extends RemoteImCommonConfig`。`FeishuRemoteConfirmPolicy` 改为 `ImConfirmPolicy` 别名（`feishu_confirm` -> `im_confirm` 兼容映射在 merge 函数中处理）。`mergeFeishuConfig` 调用共享的 `mergeRemoteImCommonConfig` + 已有 `mergeRemoteProgressConfig`。

3. **重构 `wechatTypes.ts`**--同理。复用已有 `resolveWeChatRemoteConfirmPolicy` 和 `remoteWechatConfirm` 迁移逻辑，不重写。

4. **DB 兼容**--merge 函数中加入字段兼容映射：旧 DB 中的 `feishu_confirm` -> `im_confirm`、`wechat_confirm` -> `im_confirm`。不修改 DB schema。

5. **进度字段**--通过 `RemoteImCommonConfig extends RemoteProgressConfig` 在类型层面组合，运行时保持 flat 布局。`FeishuConfig` / `WeChatConfig` 中的 `remoteProgressMode` 等 6 个字段位置不变，无需迁移读取点或 DB 结构。

**测试**：
- `imTypes.test.ts`--测试 `mergeRemoteImCommonConfig` 默认值合并、allowlist 数组深拷贝、进度配置组合。
- `feishuTypes.test.ts` / `wechatTypes.test.ts`--测试旧策略值迁移（`feishu_confirm` / `wechat_confirm` -> `im_confirm`）、`RemoteImCommonConfig extends RemoteProgressConfig` 类型组合正确性。
- 现有 `domainTypes` 相关测试回归。

**预估**：1.5 天

---

### Phase 3a：提取高重复流程逻辑（中等风险）

提取重复率最高、改动面最明确的模块。低重复率模块（命令路由器、确认管理器）暂缓到 Phase 3b。

#### 3a.1 远程 Agent + LLM 凭据解析

**`imRemoteAgent.ts`**--提取公共流程为共享函数：

```typescript
export async function runImRemoteAgent(args: {
  db: AppDatabase
  sessionId: string
  userMessage: string
  requestId: string
  workDir: string
  workDirManager: WorkDirManager
  userDataDir: string
  getMainWebContents: () => WebContents | null
  getApiKey: () => Promise<string | null>
  getBaseUrl: () => string
  getModel: () => string
  remoteContext: RemoteContext
  getToolsConfig: () => ToolsConfig
  getBrowserConfig?: () => BrowserConfig
  getWikiConfig?: () => WikiConfig
  getShellConfig?: () => ShellConfig
  // 平台差异通过回调注入
  createProgressAdapter: (getSessionId: () => string) => RemoteProgressAdapter
  buildSystemAppendix: (args: { confirmPolicy: string; browserRemoteHint?: string }) => string
  progressDefaults: Required<RemoteProgressConfig>
  progressConfig: RemoteProgressConfig
  onFinally?: () => void  // 微信用来 stopTyping
}): Promise<{ summary: string; pendingConfirm: boolean; ok: boolean }>
```

**LLM 凭据解析收敛**（对应 §2.5）：以下逻辑从两个 Agent 提取到 `runImRemoteAgent` 共享流程中：

```typescript
// imRemoteAgent.ts 内部，在调用 runToolChatSession 之前
const routeModelName = args.getModel()
const creds = await resolveLlmCredentialsForModel(args.db, routeModelName, {})
const baseUrl = creds.baseUrl ?? args.getBaseUrl()
const getApiKey = creds.error ? args.getApiKey : creds.getApiKey
```

提取后，`feishuRemoteAgent.ts` 和 `weChatRemoteAgent.ts` 不再各自调用 `resolveLlmCredentialsForModel`，只需传入 `db`、`getModel`、`getApiKey`、`getBaseUrl` 和平台专属回调。

**公共流程**：设置进度适配器 -> start/stop progress session -> 解析工作目录（敏感检查）-> 构建消息 -> 构建系统附录 -> **解析 LLM 凭据** -> runToolChatSession -> 提取文本 -> 错误处理 -> finally（进度清理 + 平台 onFinally）。

#### 3a.2 出站截断发送

**`imRemoteOutbound.ts`**--参数化截断逻辑：

```typescript
export async function sendImOutbound(args: {
  reply: (text: string) => Promise<void>  // 平台回复函数
  body: string
  sessionId?: string
  maxLen: number        // 飞书 4000, 微信 2000
  truncationSuffix: string
  formatSummary?: (raw: string) => string  // 微信有 stripMarkdown
  touch?: { db: AppDatabase; sessionId: string }
}): Promise<void>
```

#### 3a.3 会话解析器

**`imSessionResolver.ts`**--提取公共函数，平台差异通过回调注入：

```typescript
export async function resolveImSession(args: {
  db: AppDatabase
  config: RemoteImCommonConfig
  defaultModel: string
  availableModelNames?: string[]
  // 平台差异
  channel: 'feishu' | 'wechat'
  getInboundIdentity: (msg: unknown) => string
  getIdentityFromSession: (s: Session) => string | undefined
  buildSessionMetadata: (msg: unknown) => Record<string, unknown>
  buildSessionTitle: (msg: unknown) => string
  getActiveWorkDirProfileId?: () => string
}): Promise<{ sessionId: string; isNew: boolean }>
```

#### 3a.4 限流工具

**`imRateLimit.ts`**--提取 `checkRateLimit` 纯函数（两个路由器中完全相同）：

```typescript
export function createRateLimiter() {
  const senderRateMap = new Map<string, number[]>()
  return {
    check: (senderId: string, limit: number): boolean => { ... }
  }
}
```

**测试**：
- `imRemoteAgent.test.ts`--LLM 凭据解析成功/失败 fallback；敏感目录阻断；进度 session 生命周期；平台回调调用。
- `imRemoteOutbound.test.ts`--截断、后缀、touch 调用。
- `imSessionResolver.test.ts`--新建/合并/空闲超时/模型回退。
- `imRateLimit.test.ts`--限流窗口、边界值。
- 各平台 Agent/Router 测试回归。

**预估**：3 天

---

### Phase 3b：确认管理器 + 命令路由器（低优先，可延后）

此阶段重复率较低（确认管理器 ~70%，命令路由器 ~40%），且平台差异较大。采用**纯函数提取 + 泛型工具**，不引入抽象基类。

#### 3b.1 确认管理器

提取 `PendingRequestRegistry<T>` 泛型工具管理 Map/resolver/timeout 生命周期：

```typescript
export class PendingRequestRegistry<T extends { id: string; sessionId: string; expiresAt: number }> {
  private pending = new Map<string, T>()
  private resolvers = new Map<string, (v: 'y' | 'n' | 'timeout') => void>()

  listPending(): T[]
  hasPendingForSession(sessionId: string): boolean
  countPending(): number
  cancel(id: string): boolean
  cancelAllPending(): void
  register(item: T, timeoutMs: number): Promise<'y' | 'n' | 'timeout'>
  resolve(id: string, decision: 'y' | 'n' | 'timeout'): void
}
```

`FeishuConfirmManager` 和 `WeChatConfirmManager` 内部组合 `PendingRequestRegistry`，各自实现 `tryResolveFromInbound`（匹配逻辑不同）和提示构建。不继承公共基类。

#### 3b.2 命令路由器

不提取抽象基类。两个路由器保持独立，但共享以下纯函数：
- `imRateLimit.check`（Phase 3a.4 已提取）
- `tryClaimOrRelease`（封装 `remoteAgentRegistry` 的 claim/release + busy/parallel 消息选择）
- `processInboundCommon`（限流 -> 去重 -> 确认解析 -> claim 的骨架函数，平台通过回调注入 accept 逻辑和 agent 触发）

飞书独有的工作目录消歧、微信独有的媒体下载保持在各自路由器中。

**预估**：2 天（可在 Phase 3a 完成后视实际重复程度决定是否执行）

---

### Phase 4：统一设置 UI（低风险）

1. **新增 `RemoteImCommonSettings.tsx`**--共享设置组件，渲染通用控件（notifyOnReceive、sessionIdle、remoteDefaultModel、进度折叠面板、allowLocalWrite、confirmPolicy、rateLimit、senderAllowlist）。

2. **在 `ConfigModal` 中新增"IM 远程通用设置"区域**，其修改通过 `configSlice.updateRemoteImCommon` action 同时写入 `feishu` 和 `wechat` 配置。

3. **瘦身平台 Tab**--`FeishuSettingsTab.tsx` 仅保留 CLI/认证/事件/群聊触发/区域；`WeChatSettingsTab.tsx` 仅保留 SDK/扫码/轮询。

4. **i18n**--新增通用设置相关的翻译 key。

**文件变更补充**：若 Phase 2 采用 flat extends（推荐），`useFeishuRemoteDisplayStatus.ts` / `useWeChatRemoteDisplayStatus.ts` / `feishuRemoteDisplayStatus.ts` / `wechatRemoteDisplayStatus.ts` 等 DetailPanel 状态 hook 的 config selector 无需变更（config 结构不变）。

**测试**：
- `RemoteImCommonSettings.test.tsx`--控件渲染和回调。
- 平台 Tab 回归测试。
- `configSlice` 测试验证双写。

**预估**：1 天

---

### Phase 5：统一确认桥接（低风险）

依赖 Phase 3a 完成 + 确认管理器 `requestConfirm` API 收敛方案确定。不阻塞于 Phase 3b 的 `PendingRequestRegistry` 内部重构--桥接统一的核心是让 `requestRemoteConfirm` 通过统一签名调用 `confirmManager.requestConfirm`，与 registry 提取可并行。

1. **重构 `RemoteContext`**--将 `FeishuRemoteContext` 和 `WeChatRemoteContext` 统一，平台专属字段保留为可选。

2. **重构 `remoteConfirmBridge.ts`**--`requestRemoteConfirm` 不再按 source 分支，统一调用 `remoteContext.confirmManager` + 回调。

3. **`evaluateRemoteToolBlock`**（`toolChatLoop.ts`）--约 4-5 处平台分叉收敛为平台回调或统一策略查表。

**测试**：
- `remoteConfirmBridge.test.ts`--统一确认流程。
- `toolChatLoop` 相关测试回归。

**预估**：1 天

---

## 6. 测试方案

### 6.1 测试分层

| 层级 | 覆盖范围 | 文件命名 | 环境 |
|------|---------|---------|------|
| 单元测试 | 共享基础设施模块 | `electron/remote/im*.test.ts` | node |
| 单元测试 | 平台瘦身后的薄封装 | `electron/feishu/*.test.ts`、`electron/wechat/*.test.ts` | node |
| 单元测试 | 共享类型和配置 | `src/shared/imTypes.test.ts` | node |
| 组件测试 | 共享设置 UI | `src/renderer/components/Config/*.test.tsx` | jsdom |

共享模块测行为，平台测试仅测平台差异和 IPC 边界，避免双倍集成测试。

### 6.2 关键测试用例

**基础设施**：
- CLI 日志器：init -> logEvent -> flush -> 文件内容验证；轮转；reset。
- 已处理消息存储：mark -> has；重复幂等；purgeExpired；文件不存在降级。
- 审计日志器：append -> tail；query 过滤；轮转；微信 purgeExpired；查询返回适配。

**配置**：
- `mergeRemoteImCommonConfig`：null 返回默认；allowlist 深拷贝；进度字段通过 `mergeRemoteProgressConfig` 合并。
- 旧策略值迁移：`feishu_confirm`/`wechat_confirm` -> `im_confirm`。
- `RemoteImCommonConfig extends RemoteProgressConfig` 类型组合：进度字段 flat 继承，无结构变更。

**远程 Agent LLM 凭据**：
- `resolveLlmCredentialsForModel` 成功 -> 使用 service-specific apiKey 和 baseUrl。
- 返回 error -> fallback 到 `ctx.getApiKey`。
- `creds.baseUrl` 为 undefined -> fallback 到 `ctx.getBaseUrl()`。
- 飞书/微信 Agent 不再自行调用 `resolveLlmCredentialsForModel`。

**会话解析器**：
- 无历史 -> 新建，isNew=true。
- 活跃会话（< idle）-> 合并，isNew=false。
- 过期会话 -> 新建。
- remoteDefaultModelId 不在可用列表 -> 回退。

**限流**：
- 同 sender 超 limit -> 拒绝。
- 窗口过期后恢复。

**设置 UI**：
- 通用设置修改 -> onChange 被调用。
- `updateRemoteImCommon` 同时更新两个渠道。
- 平台 Tab 瘦身后仍正确渲染专属控件。

### 6.3 回归策略

- 重构前运行全量测试 `npm test`，记录基线。
- 每个 Phase 完成后运行全量测试，确保无回归。
- 重点关注 `toolChatLoop` 相关测试和两个路由器测试。

---

## 7. 迁移与风险

### 7.1 DB 兼容

- 不修改 DB schema。
- 配置读取时通过 merge 函数做字段兼容映射。
- 进度字段通过 `RemoteImCommonConfig extends RemoteProgressConfig` 保持 flat 布局，无嵌套迁移，DB JSON 结构不变。

### 7.2 IPC 兼容

- `feishu:*` 和 `wechat:*` IPC 通道名不变。
- `window.api.feishu*` / `window.api.wechat*` 接口签名不变。
- 内部实现改为调用共享模块，外部 API 表面不变。

### 7.3 风险矩阵

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 配置字段迁移遗漏导致旧配置读取失败 | 中 | 高 | merge 函数 fallback；配置读取测试覆盖旧格式 |
| 配置字段迁移遗漏导致旧配置读取失败 | 中 | 高 | merge 函数 fallback；配置读取测试覆盖旧格式（flat extends 无嵌套风险） |
| 确认管理器行为差异导致超时/匹配回归 | 中 | 高 | `PendingRequestRegistry` 只管生命周期；匹配逻辑保留在平台类 |
| `toolChatLoop` 对 RemoteContext 类型依赖断裂 | 低 | 高 | Phase 5 最后做；先确保类型定义完整 |
| 设置 UI 双写导致 per-channel 配置丢失 | 低 | 中 | 文档标注权衡；未来可增加覆盖区 |

### 7.4 回滚策略

- 每个 Phase 独立 commit，可单独 revert。
- 共享模块新增文件不删除原文件（原文件改为薄封装），回滚时恢复原文件实现。

---

## 8. 不做什么（避免过度设计）

1. **不新建 `electron/im/` 目录**--扩展 `electron/remote/`，避免双共享层。
2. **不引入 `ImPlatformAdapter` God Interface**--平台差异通过回调参数注入，不建 15+ 方法的单接口。
3. **不引入 `ImCommandRouter` 抽象基类**--提取纯函数，路由器保持独立。
4. **不合并 `feishuEventService.ts` 和 `weChatBotService.ts`**--技术栈完全不同（lark-cli 子进程 vs @wechatbot SDK）。
5. **不合并 `larkCliRunner.ts` / `weChatMediaInbound.ts`**--纯平台专属，无重复对象。
6. **不强行统一审计日志器返回结构**--参数化 opts 保留差异，查询返回加适配层。
7. **不抽象 IPC 通道注册**--平台专属 IPC 差异本质，强行统一增加复杂度。
8. **不引入新依赖**--仅使用现有 TypeScript / Vitest 技术栈。
9. **不为假想第三渠道预留扩展点**--所有抽象基于飞书和微信两个真实渠道的需求。

---

## 9. 实施顺序与预估

| 阶段 | 内容 | 预估工时 | 依赖 | 优先级 |
|------|------|---------|------|--------|
| Phase 1a | CLI Logger / ProcessedStore / CliLogFields | 1.5 天 | 无 | 立即 |
| Phase 1b | 迁移 remoteAgentRegistry -> electron/remote/ | 0.5 天 | 无 | 立即 |
| Phase 1c | 清理 feishu shouldAcceptInbound 重复 | 0.5 天 | 无 | 立即 |
| Phase 1d | 参数化 AuditLogger | 1 天 | 无 | 立即 |
| Phase 2 | 统一 RemoteImCommonConfig | 1.5 天 | 无 | 立即 |
| Phase 4 | 设置 UI 统一 | 1 天 | Phase 2 | 可并行 |
| Phase 3a | 远程 Agent + LLM 凭据 + 出站 + 会话 + 限流 | 3 天 | Phase 1, 2 | 第二批 |
| Phase 3b | 确认管理器 + 命令路由器纯函数 | 2 天 | Phase 3a | 可延后 |
| Phase 5 | 统一 remoteConfirmBridge | 1 天 | Phase 3a | 第三批 |
| **合计** | | **12 天** | | |

Phase 1 和 Phase 2 可并行。Phase 4 可在 Phase 2 完成后并行于 Phase 3a。Phase 3b 可延后到独立迭代。

---

## 10. 预期收益

| 指标 | 重构前 | 重构后 |
|------|--------|--------|
| IM 基础设施文件数 | 10 个（5 对） | 4 个共享 + 10 个薄封装 |
| LLM 凭据解析重复 | 2 处逐行相同 | 1 处共享 |
| 限流函数重复 | 2 处完全相同 | 1 处共享 |
| 出站截断重复 | 2 处 | 1 处参数化 |
| 配置重复字段数 | 15 个 x 2 渠道 | 15 个共享 + 平台专属 |
| 设置页重复控件块 | 7 个 x 2 渠道 | 7 个共享 + 平台专属 |
| `toolChatLoop` 中 source 分支 | ~4-5 处 | 0 处（Phase 5 后） |
| `remoteAgentRegistry` 位置 | `feishu/` 下，微信跨目录引用 | `remote/` 下，语义正确 |
| `shouldAcceptInbound` 重复 | 飞书目录内 2 份 | 1 份 |
