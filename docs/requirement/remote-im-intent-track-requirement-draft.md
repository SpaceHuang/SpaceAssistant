# 远程 IM 意图归属与 Track 管理 — 需求初稿

> **状态：** 初稿 v0.3，吸收第二轮澄清协议评审意见，待讨论
> **日期：** 2026-10-11
> **适用范围：** 微信、飞书远程 IM；桌面链路可在后续阶段接入
> **评审记录：** [第一轮](../review/2026-10-11-remote-im-intent-track-requirement-review.md)、[第二轮](../review/2026-10-11-remote-im-intent-track-requirement-review-v2.md)
> **关联材料：** [微信消息处理流程与代码证据](../architecture/wechat-message-processing-flow-2026-10-11.html)、[远程会话上下文感知需求](./remote-session-context-awareness-requirement.md)、[远程 IM 异步审批安全模型](./remote-im-async-approval-security-requirement.md)、[确认系统顶层设计](./tool-confirmation-top-level-design-v2.md)

---

## 1. 概述

### 1.1 问题

微信、飞书提供的消息 ID 能标识单条平台消息；应用的 `sessionId` 用于保存一段对话历史；`requestId`、`turnId` 和 `toolUseId` 分别标识一次处理、Agent turn 和一次工具调用。它们都不能单独表达“这些消息共同属于用户提出的这项意图及其后续交互”。

当前系统因此在入口路由、会话解析、wake event、runtime、确认通道及出站适配器中分别传递和匹配部分字段。系统有一些局部关联，但没有统一的交互归属对象、状态 owner 和审计链。

本需求提出：在远程消息入口增加**意图归属**，把每条已接受消息判定为新意图、某个既有意图的延续或无法确定；然后由 Track 管理器创建或选定 Track，并将后续 turn、工具调用、确认、回复和回执统一关联到该 Track。

### 1.2 核心模型

```text
平台入站消息
  → 身份与消息有效性检查
  → 显式关联解析 / 意图归属
  → 新建或续接 Track
  → session / request / turn 执行
  → Track 下的一个或多个 toolUse
  → 每个需确认的 toolUse 创建独立 confirmation
  → 用户回复经归属校验后结算对应 confirmation 或继续 Track
  → 结果回执归属同一 Track
```

### 1.3 初稿的设计结论

1. **Track 表示一项用户意图及其跨消息交互，不替代 session。** 一个 session 可包含多个 Track；一个 Track 可关联多条用户消息、多个 request/turn、多个工具调用及多个回复。
2. **意图归属集中在入口决策。** 后续模块读取已确定的 `trackId`，不自行根据时间、文本或 session 猜测归属。
3. **语义关联与安全授权分离。** 意图识别可以判定“这条普通追问延续哪个 Track”；它不能批准工具、放宽权限或跳过确认匹配。
4. **确认是 Track 的子对象，不等于 Track。** 一个 Track 可以有多个并行或先后确认；每个 confirmation 必须唯一指向一个工具调用及一个确认提示。
5. **TrackID 是应用内部关联 ID。** 除非平台协议确实支持可靠的自定义消息元数据，否则不假设它能无形地透传到微信。跨平台消息关联依赖可靠引用映射，或明确的用户可见关联协议。
6. **终态 Track 不重开。** 完成后的续问创建 successor Track，并保留 `parentTrackId` 与经筛选的上下文来源；旧 Track 下的确认/授权永不因续问而复活。
7. **Track 不改变既有异步审批恢复契约。** Track 负责归属异步待办和恢复事件；待办的持久化、重启追认、撤销 fencing 与原调用恢复继续遵守异步审批需求。
8. **澄清句柄是明确的平台绑定降级协议。** 当前版本句柄和 owner 校验通过即可完成应用层关联；句柄模式不要求平台 messageId，但必须已有持久化 send attempt。
9. **澄清版本不可变。** 改变候选集合/顺序/含义时生成新句柄并先废弃旧版本；迟到回复只能 stale，不能按新版本重新解释。

---

## 2. 现状与代码证据

### 2.1 现有 ID 的边界

| 标识 | 当前语义 | 不应承担的语义 |
|---|---|---|
| `messageId` | 一条微信入站消息；去重键；部分确认提示上下文 | 一段意图的生命周期 |
| `sessionId` | Agent 对话历史容器，微信按 `userId` 和空闲时间选择/复用 | 单条用户意图或单次确认 |
| `requestId` | 一次远程处理/wake 请求 | 同一意图跨多条用户消息的稳定根 ID |
| `turnId` | runtime 执行 turn | 跨 turn 的交互归属 |
| `toolUseId` | 一次模型工具调用 | 用户意图或整个确认周期 |
| confirmation 内部 ID / 确认码 | 一项待确认操作的内部记录与用户输入句柄 | Track 本身或通用消息线程 |
| 平台引用消息 ID | 将用户回复指向一条已发送消息（若 SDK 提供） | 权限授予 |

代码证据：

- 微信 session 按 `userId` 选择候选项，并按空闲窗口决定复用；默认空闲窗口为 10 分钟。[`weChatSessionResolver.ts`](../../electron/wechat/weChatSessionResolver.ts)、[`imSessionResolver.ts`](../../electron/remote/imSessionResolver.ts)、[`remoteSessionResolve.ts`](../../src/shared/remoteSessionResolve.ts)
- 普通入站消息会创建新的 `requestId`，然后准备 turn；`remoteContext` 保留原始 `messageId`、`sessionId`、`requestId` 和 `turnId`。[`weChatCommandRouter.ts`](../../electron/wechat/weChatCommandRouter.ts)
- IM pending 保存了原始消息、session 和 request 信息；创建 pending 时未把 `toolUseId` 放入该对象，回复绑定日志也未记录回复消息 ID。[`invocationAssembler.ts`](../../electron/runtime/invocationAssembler.ts)、[`imChannel.ts`](../../electron/confirmation/imChannel.ts)、[`weChatImChannel.ts`](../../electron/wechat/weChatImChannel.ts)
- `wechat.inbound.confirm_resolved` 在确认解析器消费输入后记录；它可能是引用不匹配后的提示路径，不等同于批准或 waiter 结算。[`weChatCommandRouter.ts`](../../electron/wechat/weChatCommandRouter.ts)、[`imChannel.ts`](../../electron/confirmation/imChannel.ts)

### 2.2 已观察到的运行日志

- 04:21:24、04:21:38 的确认回复没有 `ref_msg` / 引用消息 ID，绑定检查为不匹配；router 仍记录 `wechat.inbound.confirm_resolved`。这说明当前日志事件名和实际语义不一致，也说明当平台引用缺失时系统无法仅凭平台消息关系恢复归属。
- 04:21:05 同一 `requestId`、`sessionId` 和 `toolName` 下出现两条确认；Agent 日志中的工具调用有不同 `toolUseId`，但 IM 确认日志没有该字段，不能稳定地按日志连接具体确认与工具调用。
- 04:21、04:34、04:40 的确认提示发送调用 fulfilled，但消息关联为 unbound；对应工具调用返回 `CONFIRMATION_UNAVAILABLE`，MCP 未派发。
- 04:21、04:34、04:40 的 session shadow 日志报告 canonical history 不可用或快照无效，读取路径回退到 legacy。此项可能影响 Agent 上下文，应作为相邻调查项；本需求不预判它与意图归属问题存在因果关系。

完整时间线和字段证据见[流程网页](../architecture/wechat-message-processing-flow-2026-10-11.html)。

---

## 3. 目标与非目标

### 3.1 目标

| ID | 目标 | 优先级 |
|---|---|---|
| G1 | 每条被接受的远程用户消息都通过一个集中入口归属到新 Track、既有 Track 或“不确定”结果 | P0 |
| G2 | Track 跨越同一意图的多条消息及其 Agent 执行、确认和回执，并与 `sessionId` 解耦 | P0 |
| G3 | 各处理模块消费统一 Track 上下文，不各自推断消息归属 | P0 |
| G4 | 每个确认项明确属于某个 Track 和某个 `toolUseId`，回复结果可以审计回溯到确认提示及回复消息 | P0 |
| G5 | Track 生命周期统一处理完成、超时、取消、授权撤销、会话删除及迟到消息 | P0 |
| G6 | 对 SDK 未提供稳定消息 ID / 引用关系的情况定义明确的平台能力契约及安全降级 | P0 |
| G7 | 通过事件顺序矩阵验证归属、确认、取消及终态不变量，而非只补单个历史反例 | P0 |
| G8 | continuation 跨 session 时承接足够且仅属于目标 Track 的上下文；上下文缺失时不得盲目执行 | P0 |
| G9 | ambiguous 消息具有独立、可持久、一次性消费的 Clarification 回复闭环 | P0 |
| G10 | Track 关联不得改变同步 waiter、持久异步 todo 和已消费动作的既有恢复/撤销契约 | P0 |

### 3.2 非目标

- 不用 Track 替换 `sessionId`、`requestId`、`turnId`、`toolUseId` 或平台 `messageId`。
- 不允许语义分类器自行批准或拒绝工具确认、授予信任或改变权限。
- 不以 Track 归属替代发送者认证、owner 校验、授权代际、确认期限、引用校验或执行前策略复核。
- 不要求把内部 UUID 明文展示给用户。
- 不在本需求中重做 Agent 工具发现、MCP catalog 或 transcript/canonical history 存储；这些问题需独立诊断。
- 不预设意图识别必须由 LLM 实现。规则、模型或混合实现属于技术设计选择，但必须遵循本需求的输入/输出和失败契约。

---

## 4. 术语与对象

| 术语 | 含义 |
|---|---|
| **Track** | 单个用户意图及其后续交互的应用级聚合对象，由 `trackId` 标识。 |
| **意图归属** | 针对一条入站消息，判定创建新 Track、延续某个既有 Track，或暂时无法确定。 |
| **Track 事件** | 与 Track 相关的入站消息、Agent request/turn、出站消息、toolUse、confirmation、回复、取消及终态等事实。 |
| **平台消息映射** | `channel + externalMessageId → trackId + eventId` 的索引，供引用消息回溯归属。 |
| **confirmation** | Track 下针对一个具体工具调用的授权等待项；拥有自己的 ID、状态、期限及提示消息关联。 |
| **Track 上下文** | 由入口/Track 管理器确定并显式传给后续执行和出站能力的不可变关联信息。 |

建议的最小事件关联字段：

```ts
type TrackContext = {
  trackId: string
  channel: 'wechat' | 'feishu'
  externalUserId: string
  rootMessageId: string
  sessionId?: string
  parentEventId?: string
}

type TrackEventRef = TrackContext & {
  eventId: string
  eventKind: string
  messageId?: string
  requestId?: string
  turnId?: string
  toolUseId?: string
  confirmationId?: string
  parentEventId?: string
}
```

该类型是需求示意；字段命名、表结构及事件存储方式留待技术设计。

---

## 5. 功能需求 A：入口意图归属

### 5.1 入口处理顺序

已通过身份/渠道安全守卫且未被去重的入站消息必须经过同一个归属入口。建议顺序：

1. 解析平台消息身份、发送者、文本、原始引用和消息类型；保留原始入站 `messageId`。
2. 完成渠道、owner、allowlist、授权代际及去重校验。
3. 先处理可确定的显式关系：已知平台引用消息 ID、有效 Track 句柄、严格格式的确认协议。
4. 对普通对话消息查询该用户/通道下符合状态及期限条件的候选 Track，并执行意图归属。
5. 产生唯一归属结果，记录结果、候选项、依据、识别版本和时间；再进入 session 解析与 Agent 执行。

安全相关的确认回复应先走确定性的 confirmation 协议匹配；不得用普通语义归属结果绕过确认协议。

### 5.2 归属结果

```ts
type TrackAttribution =
  | { kind: 'new-track'; trackId: string; reason: string }
  | { kind: 'continuation'; trackId: string; confidence: number; evidence: string[] }
  | { kind: 'ambiguous'; candidates: Array<{ trackId: string; confidence: number }>; reason: string }
  | { kind: 'rejected'; reason: string }
```

结果必须是单值。多个高分候选不能按“最近 session”“最近消息”静默择一。

### 5.3 意图识别依据

归属模块可评估但不限于：

- 用户明确引用的助手/确认消息及其平台消息映射；
- 有效的用户可见 Track 句柄或确认协议标识；
- Track 当前状态（正在执行、等待用户信息、等待确认、已完成等）及创建时间；
- 发送者、通道和 owner 是否与 Track 完全一致；
- 新消息与 Track 摘要、近期用户/助手消息的语义关系；
- Track 是否已终结、取消、超时或因权限变化失效。

语义相似度只能作为普通消息归属证据之一。确认批准、拒绝、敏感操作的授权不能依赖语义相似度。

### 5.4 归属策略与歧义

初稿建议：

| 结果 | 建议行为 |
|---|---|
| 显式引用唯一命中活动 Track | 归属该 Track，并记录引用关系。 |
| 显式引用唯一命中 `completed` Track | 创建 successor Track 并记录 `parentTrackId`；不得重开父 Track 或恢复旧确认。 |
| 显式引用命中 `cancelled` / `expired` / `failed` Track | 不续接其执行上下文；按重新发起规则建新 Track，或明确提示该来源已失效。 |
| 高置信度匹配唯一活动 Track | 归属该 Track，并记录语义归属证据。 |
| 高置信度匹配唯一 `completed` Track（在候选窗口内） | 创建 successor Track，并记录语义归属证据及 `parentTrackId`。 |
| 多个候选接近或意图不确定 | 不静默绑定；若有可澄清的候选则创建独立 Clarification 并暂存原消息；没有合理候选时创建新 Track。 |
| 没有合适候选 | 创建新 Track。 |
| 明确的确认命令但无法唯一定位 confirmation | 不批准、不拒绝；提示引用/补充确认标识，原 confirmation 维持原状态直到正常终结。 |
| 意图识别服务超时、异常或输出非法 | 进入统一降级策略并记录失败原因，不把失败伪装成高置信度延续。 |

默认建议：对普通对话，歧义时优先“暂存并澄清”；只有没有可供选择的合理候选时才新建 Track。这样避免把一条可能是旧任务回复的消息误当新指令执行。对确认操作，必须 fail closed，绝不语义猜测批准对象。

### 5.5 澄清对象与回复闭环

歧义澄清不是普通 Track，也不是 confirmation。它是一个短生命周期、只用于确定原消息归属的独立控制对象 `Clarification`。

收到 ambiguous 消息时：

1. 以入站 `messageId` 幂等创建 Clarification，保存规范化原消息、发送者/通道/owner 代际、候选 Track 快照、候选标签、创建时间和截止时间；原消息进入 parked 状态，不运行 Agent、不创建重复的 user turn。
2. 每个待投递澄清版本必须先持久化不可变候选快照、`clarificationId`、单调递增的 `version`、独立随机句柄及唯一 `sendAttemptId`，再发出带版本句柄和明确选项的提示；回复格式为 `选择 <句柄> <选项>`。句柄只定位一个澄清版本，不是 TrackID、confirmation code、异步 todo 编号或授权凭据。句柄须在身份范围内唯一且不可预测，并在迟到回复拒绝窗口内不复用；它不承担授权功能。
3. 句柄协议是平台消息 ID 缺失时的**正式关联方式**，不要求同时取得平台消息绑定。严格解析器须精确匹配 `channel + identityKey + owner + authorizationGeneration + clarificationHandle + versionSnapshot + option`；句柄查表必须还原唯一不可变版本及候选含义。平台引用可作额外校验，但不是句柄模式的必要条件。
4. 句柄在该身份范围内全局唯一，并在澄清过期及迟到拒绝保留期内不复用；候选序号只在其不可变版本内有效。只有澄清记录和版本已持久化，且该版本的发送尝试已进入 `attempt-started` 后，才接受该句柄回复；不要求等待 send acknowledgement。因而用户回复可以先于发送 acknowledgement / echo 回调到达。
5. 收到精确匹配的当前版本句柄，且发送者、owner、授权代际及选项仍有效时，回复本身构成该句柄提示已到达用户的应用层证据。即使 SDK 返回“发送成功但无消息 ID”或发送结果暂时未知，也可原子消费 Clarification 和 parked 原消息；平台消息 ID 缺失不能永久阻断此句柄协议。即使某次 send attempt 后被标为 `send-rejected`，若随后收到当前版本的精确有效句柄回复，也以该回复证明用户实际取得该提示并允许结算；`send-rejected` 仅在尚无合法句柄回复时表示保留/重试。若发送从未尝试、句柄不存在/过期/已 superseded，或身份校验失败，则不得消费。
6. 合法选择原子地将 Clarification 从 `pending` 转为 `resolved`，并一次性消费原消息：若选中仍有效的活动 Track，则把原消息作为其 continuation 输入；若选中已完成 Track，则按 §6.3 创建 successor Track。澄清回复本身不作为第二条 Agent 指令。
7. 任一候选集合、候选顺序、选项含义或提示语义发生变化时，必须原子创建新版本、新句柄和新快照，并先将旧版本标记为 `superseded`，再发送新提示。旧句柄永久 stale；旧版本选项不得在新句柄下沿用或重新编号后被接受。若仅重试发送完全相同的不可变版本，可重用该版本句柄，但每次网络尝试须有独立 `sendAttemptId`。
8. 回复处理与版本更新必须串行化/原子竞争：回复先提交，则 Clarification 进入 resolved，新版本更新失败；版本先提交，则旧句柄回复为 stale/no-op，不能按新候选表重新解释。旧 send 回调仅能更新自身 `sendAttemptId + version` 的投递记录，不得覆盖当前版本或已 resolved 状态。
9. 重复选择为幂等 no-op；候选在等待期间关闭、授权被撤销或身份代际变化时，原选项不得指向其他 Track，必须发新版本或终结该 Clarification。重启后恢复当前版本及未过期的旧句柄 tombstone，以便旧提示回复得到 stale 结果；不得重排候选或复用句柄。
10. 发送确定失败、发送结果未知、发送成功无消息 ID、平台 ID 已绑定是不同投递事实。未收到合法句柄回复时，保留 parked 原消息并按期限重试；只有候选内容变化才生成新版本/新句柄。澄清过期、owner 撤销或候选全部失效时，原消息进入明确终态并向用户说明，不能静默丢弃或自动归到最近 Track。

建议的归属状态：`pending → resolved | expired | invalidated`；每个版本另有 `current | superseded | expired` 状态；每次投递另记 `not-attempted | attempt-started | send-fulfilled | send-rejected | send-outcome-unknown` 及可选的平台绑定状态。平台消息绑定只对引用关联模式为必需；本需求的 Clarification 使用句柄模式，以持久化版本句柄和 owner 受限的精确回复作为关联闭环。

Clarification 最小字段语义如下，具体表结构可在技术设计中确定：

```ts
type Clarification = {
  clarificationId: string
  state: 'pending' | 'resolved' | 'expired' | 'invalidated'
  sourceMessageId: string
  parkedInputRef: string
  channel: 'wechat' | 'feishu'
  identityKey: string
  owner: string
  authorizationGeneration: number
  currentVersion: number
  expiresAt: number
  resolvedByMessageId?: string
}

type ClarificationVersion = {
  clarificationId: string
  version: number
  handle: string // 每个变更版本新生成；随机、不可预测、身份+保留期内唯一，不复用
  candidateSnapshot: Array<{ trackId: string; option: number; label: string; stateAtIssue: string }>
  snapshotHash: string
  state: 'current' | 'superseded' | 'expired'
}

type ClarificationSendAttempt = {
  sendAttemptId: string
  clarificationId: string
  version: number
  state: 'attempt-started' | 'send-fulfilled' | 'send-rejected' | 'send-outcome-unknown'
  platformMessageId?: string
}
```

---

## 6. 功能需求 B：Track 生命周期与 session 关系

### 6.1 生命周期

Track 至少应表达以下状态或等价信息：

```text
open → processing → waiting-user → processing → completed
                     └→ waiting-async-approval → resuming → processing
  ├──────────────→ cancelled
  ├──────────────→ expired
  └──────────────→ failed
```

状态转换必须由 Track 管理器统一结算并具备幂等性。Track 下可有多个 confirmation 子状态；Track 的聚合状态不能抹掉各 confirmation 的独立结果。`completed`、`cancelled`、`expired`、`failed` 是不可逆终态；不得把终态 Track 改回 `processing`。

### 6.2 与 session 的关系

- 一个 session 可以包含多个 Track；例如用户在同一段历史会话中提出多个独立问题。
- 一个 Track 可以关联多条入站消息，并在这些消息触发的执行中产生多个 `requestId` / `turnId`。
- 对未终结 Track 的 continuation，session 选择优先使用 Track 当前有效的 `originSessionId`；即使超过普通 idle 窗口也不应仅因 idle 超时丢掉该意图上下文。若仅因 idle 超时而需换 session，可按 §6.4 构造经过验证的 Track 上下文承接；若原 session/历史已删除或 Track 已因删除/授权策略失效，则不得从已删除来源重建上下文，必须要求用户重述或重新发起，不能在空白 session 中直接执行。
- 同一 Track 的 continuation 可能跨 session；session 是承载对话历史的存储/执行边界，Track 是归属与语义上下文边界。跨 session 时必须提供足以理解本 Track 的最小上下文包，不能只传播 `trackId`。
- 新 Track 可以在既有 session 中执行；创建新 Track 不自动等价于创建新 session。
- 删除 session、切换 owner 或撤销授权时，必须显式处理引用它的活动 Track 与 confirmation，不能留下可批准的孤儿 pending。

### 6.3 完成后的后续问与 successor Track

- Agent 最终回执已提交、执行已终结且没有等待输入/审批/恢复的工作后，Track 进入 `completed`。发送回执是否成功另记出站投递状态；不能因网络发送失败把已完成执行伪装成运行中，也不能因投递成功提前终结仍有 pending 的工作。
- 用户在完成后追问“把刚才结果导出 PDF”时，这是**新建 successor Track**，不是重开已完成 Track。新 Track 记录 `parentTrackId` 指向完成项，并根据显式引用或唯一高置信度语义关联继承可用上下文。普通续问是否选中某个完成 Track，受 continuation window 与候选唯一性约束；窗口外的普通消息新建无 parent 的 Track，显式引用仍可提出 successor 请求。
- 显式引用已完成 Track 的最终回复，或在 continuation window 内高置信度唯一匹配已完成 Track 的普通追问，可建立 successor Track；不修改父 Track 状态。若语义同时命中多个已完成 Track，则走 §5.5 澄清。
- 对 `cancelled` / `expired` / `failed` Track，普通语义延续不得恢复其执行上下文或 pending。用户明确要求重新开始时新建 Track，可记录 `parentTrackId` 作为来源；显式引用旧消息不能改变该规则。需要继续已取消/失败任务时，应作为新任务重新校验。
- 任何 successor Track 都不得继承父 Track 的 confirmation、授权决定、短码、待办消费状态或执行 permit。异步待办是否仍可追认只由既有待办状态和审批契约决定。

### 6.4 跨 session 上下文承接

当归属结果为 continuation/successor，而执行 session 与 Track 的原 session 不同，Agent 必须收到经 Track Manager 组装并标注来源的 `TrackContextPackage`。最低要求：

```ts
type TrackContextPackage = {
  trackId: string
  parentTrackId?: string
  summary: string
  relevantEvents: Array<{ eventId: string; kind: string; contentOrRef: unknown }>
  userConstraints: string[]
  unresolvedQuestions: string[]
  completedActions: string[]
  artifactRefs: Array<{ ref: string; version?: string }>
  sourceSessionIds: string[]
  completeness: 'complete' | 'partial' | 'unavailable'
}
```

字段只是需求级语义示意，具体格式由技术设计确定。上下文包应只包含该 Track 的相关事件、用户约束、必要结果和可验证产物引用；不得把同一 session 中其他 Track 的摘要或工具授权带入。原始消息可在权限允许且确有必要时引用，不要求复制整段 session transcript。

承接前必须校验：当前 sender/owner/authorizationGeneration 仍有效；来源 session/Track 未因删除策略失效；工作目录/profile 和相关资源引用仍可访问；上下文来源可追溯。权限和 confirmation 永不从上下文包继承。

若上下文包为 `partial`，必须向用户说明缺失部分并在执行依赖该信息的动作前补齐；若为 `unavailable`、校验失败或原历史已删除，则不执行依赖该上下文的操作，回复用户需要重述/重新发起。不得仅创建新 session 后把 Track 标识传给 Agent，假定上下文已承接。

### 6.5 超时与终态

- Track 超时与某个同步 confirmation 超时、异步 todo TTL、澄清 TTL 是不同层级；各自终结不能抹掉其他对象的审计结果。
- Track 已关闭后到达的旧引用不得重开父 Track，不得重新激活同步 confirmation 或恢复失效授权；可按 §6.3 形成新的 successor Track。
- Track 下存在合法异步审批 todo 时，Track 保持 `waiting-async-approval`（应用可没有活跃 Agent waiter）；应用重启后按既有待办契约恢复。用户收到“等待审批”的出站回执不等于 Track 已 completed；只有待办终结、原调用/结果完成或明确取消后才能结算 Track。
- 超时期限、用户显式结束方式及活动 Track 数量上限作为待讨论项，见 §13。

---

## 7. 功能需求 C：消息传播与出站关联

### 7.1 内部传播

- 每个已归属消息产生的 `requestId`、`turnId`、工具调用、确认项、回复和回执都必须携带同一 `trackId`。
- 下游模块不得重新分类 Track，也不得从 session、时间或正文哈希推导 Track。
- 并发、异步回调、wake event 和重试必须显式持有其 Track 上下文；禁止使用可被不同请求覆盖的全局“当前 Track”。
- 出站消息由统一发送边界记录 `trackId + eventId + platformMessageId` 映射。

### 7.2 平台引用能力

平台适配器必须声明并验证：

1. 发送成功时能否返回稳定的出站消息 ID；
2. 用户回复时能否提供被引用的原消息 ID；
3. 回显可能早于/晚于发送 acknowledgement 到达时如何关联；
4. SDK 重启、重复回调、缺字段或发送结果不确定时如何报告。

如果出站 ID 与入站引用无法可靠闭环，适配器不得声称引用关联成功。系统必须采用可见关联协议或请求用户澄清；不能静默把消息归到“最近一个” Track。

TrackID 默认不要求以原始 UUID 显示给用户。若需要用户可输入的短句柄，必须满足足够的唯一性/防重放要求，并在 Track 关闭后保留迟到消息拒绝能力；两位确认码不能直接作为长期 Track 标识。

---

## 8. 功能需求 D：确认与安全边界

### 8.1 三类需要区分的对象

本需求中的“确认”不能把同步 waiter、持久异步审批待办和已经消费但尚未确定派发结果的动作压成一个状态机。

| 对象 | 与 Track 的关系 | 应用重启后的行为 |
|---|---|---|
| **同步 confirmation waiter** | Track 下的短期执行等待项，绑定一个 `toolUseId`、提示及当前 Agent turn | 按同步确认现有契约失效/取消；不得在新进程恢复成可批准 waiter。记录终态和关联 Track。 |
| **持久异步审批 todo** | Track 下可长期挂起的独立待办；绑定原 `invocationId`、通知版本、`originSessionId` 及安全快照 | **沿用**[异步审批安全需求](./remote-im-async-approval-security-requirement.md)：合法 pending 跨重启存活；启动先完成 epoch/撤销/执行日志对账，再按 TTL 和关联校验允许追认。Track 重构不得缩短、取消或放宽该契约。 |
| **已消费但未确定派发的动作** | Track 中 todo 的执行子状态，不是可再次批准的 confirmation | **沿用**异步审批恢复协议：只有日志可证明尚未派发且 permit/授权仍有效时，按同一 `invocationId` 恢复；未知结果不得重放或回到 pending。撤销 fencing 优先。 |

同步确认状态 `invalidated-on-restart` 不得级联删除合法异步 todo。异步 todo 的 `todoId`、通知关联、编号版本、授权 epoch、撤销事实和原调用 envelope 按既有持久契约管理；Track 仅增加不可变的 `trackId` 关联字段及事件引用。旧数据没有 Track 字段时按迁移策略标为 legacy/unattributed，不得因此擅自失效合法待办或猜测补绑。

### 8.2 关联与安全要求

- 每个同步 confirmation 必须且只能属于一个 Track，并绑定一个 `toolUseId`、工具参数摘要、创建 request/turn、owner、授权代际、期限和提示消息映射。
- 每个异步 todo 必须且只能关联一个创建时确定的 Track；追认恢复原 `invocationId` 和原 `originSessionId`，不得把执行迁移到当前 session 或 successor Track。
- 用户确认/追认回复必须先精确定位相应 confirmation 或 todo，再运行其既有发送者、owner、授权代际、期限、通知版本、引用和提交状态校验。
- Track 意图归属成功不等于 confirmation/todo 命中；Track 命中也不等于批准。
- 同一 Track 下多个待确认项必须由各自命名空间的协议唯一定位；不得只按 `sessionId + toolName` 选择，也不得把澄清句柄、同步确认码和异步 todo 编号混用。
- 同步 confirmation、异步 todo 与动作派发结果分别结算；每个对象只有一个合法终态，重复或乱序事件按其自身幂等协议处理。
- confirmation/todo 通知发送 fulfilled 但关联未建立时，保留“发送事实”和“绑定事实”的区别。异步待办按既有契约可 pending + 未投递并在身份/epoch/TTL 复核后补发；同步 waiter 不得仅因发送 fulfilled 就开放批准。
- Track 取消、owner 撤销、session 删除、任务取消和渠道关闭分别按各自的既有级联范围执行；不能用 Track 的通用关闭动作覆盖异步审批撤销/恢复 fencing。session 删除仍按异步审批需求对 origin session todo 执行失效。
- 意图分类和澄清选择不能更改 pending todo 的不可变调用、执行上下文、授权事实或批准范围。

---

## 9. 功能需求 E：事件、日志与审计

### 9.1 统一关联字段

与 Track 相关的结构化事件应按适用性记录：

```text
trackId, eventId, parentEventId,
channel, externalUserId, inboundMessageId, outboundMessageId,
sessionId, requestId, turnId, toolUseId, confirmationId,
attributionKind, attributionConfidence, attributionEvidence,
state, terminalReason
```

敏感消息正文和确认参数遵循现有脱敏规则；不为追踪关联而记录完整密钥、用户隐私或不必要的工具参数。

### 9.2 事件语义

- 事件名必须准确反映事实。例如“消息被确认解析器消费”“confirmation 已批准”“waiter 已结算”是不同事实，不得共用 `confirm_resolved`。
- 归属决策、confirmation 终态、工具派发、最终用户回执应可按 `trackId` 查询并按 `parentEventId` 还原顺序。
- 日志缺少 join 字段时，应明确记录 `unavailable` / `unbound` 和原因；禁止用 `sessionId` 或最近时间窗口假装完成精确关联。

---

## 10. 异常与降级矩阵

| 场景 | 要求行为 |
|---|---|
| 同一入站消息重复投递 | 按平台 `messageId` 幂等处理，不重复创建 Track / request。 |
| 同一用户有多个活动 Track，普通消息语义命中多个 | 有合理候选则进入 parked Clarification；无合理候选才新建 Track，不静默选最近一个。 |
| 存在可选候选但意图分类 ambiguous | 持久化 Clarification 和原消息 parked 状态；发送独立句柄/选项；只有严格匹配的选择回复才能一次性恢复原消息。 |
| 澄清回复为裸 `1` / “第一个”或句柄错误 | 不归属任何 Track、不执行；提示使用本条澄清句柄格式，原 Clarification 仍 pending。 |
| 同一用户并行发起多次澄清，回复乱序或重复 | 按各自 `clarificationHandle` 独立结算；每个原消息最多消费一次，重复答复幂等 no-op。 |
| Clarification send fulfilled 但无平台消息 ID，用户提交当前版本有效句柄 | 若该版本已持久化且 send attempt 已开始，按 owner/代际/句柄/不可变候选快照精确匹配并消费一次；无需平台消息 ID。 |
| Clarification 回复先于 acknowledgement/echo 回调 | 若句柄版本已登记、send attempt 已开始且解析/提交先赢，先原子 resolve；迟到 send 回调只能更新该 attempt，不得回滚或改写终态。 |
| Clarification 提示确定未尝试/发送失败/结果未知，尚无合法句柄回复 | 保留 parked 原消息；按相同 immutable version 重试，或在内容改变时创建新版本；不得静默执行或清除。 |
| Clarification 候选改变、重排或 owner/授权代际变化 | 创建新版本和新句柄，先 supersede 旧版本再发送；旧版本任何选择为 stale/no-op，不能用新候选表解释。 |
| 新版本更新与旧选择并发 | 原子先提交的一方决定：选择先赢则禁止更新；更新先赢则旧句柄 stale。 |
| 旧 send callback 在新版本发布后到达 | 只更新匹配 `sendAttemptId + version` 的历史投递事实，不得更改当前版本/候选映射。 |
| 重启后收到旧版本句柄回复 | 从持久 tombstone 判定 stale/no-op；当前版本不重排选项、不复用旧句柄。 |
| 微信 SDK 未提供引用字段 | 仅靠语义归属普通消息；确认操作不得仅凭语义结算。需要时请求可验证的引用/句柄。 |
| 出站消息已发送但未取得可用平台消息 ID | Track 可以保留发送事实，但引用关联状态为 unavailable；不得开放依赖该引用的确认。 |
| 意图识别超时或异常 | 使用明确的降级结果；记录原因为 classifier-unavailable，不伪造 continuation。 |
| 应用重启时 Track 下有同步 waiter、异步 todo、已消费未派发动作 | 同步 waiter 失效；合法异步 todo 按既有 24h TTL/持久 epoch/撤销与 checkpoint 协议恢复；消费后恢复按原 invocation 和 dispatch fencing 对账。三者不得被一个 Track 终态统一清除。 |
| 完成 Track 后用户追问 | 归属到明确的完成 Track 候选后创建 successor Track；父 Track 保持 completed，旧 confirmation/todo 不被复制或复活。 |
| 活动 Track 跨 idle 窗口续接且原 session 不可用 | 选新/其他 session 前构造 TrackContextPackage；完整性不够时先澄清或要求重述，不得空上下文执行。 |
| 同一目标 session 同时包含其他 Track | 只向 Agent 提供当前 continuation 的 Track-scoped 必要上下文；不得因 session 相同把其他 Track 的状态/授权并入。 |
| session 被删除 | 取消或失效依赖该 session 的执行和 pending；保留满足审计/防迟到所需的最小 tombstone，遵循数据删除规则。 |
| 用户撤销绑定 / owner 改变 | 关联 Track 与 confirmations 立即进入失效流程，旧用户消息不能复活它们。 |
| 迟到的引用或旧短码 | 返回 stale/expired；不能命中新建或复用后的其他对象。 |
| 多个 confirmation 并行发送，回显乱序 | 每个 confirmation 独立绑定；乱序不得串码或提前开放其他项。 |

---

## 11. 组件职责建议

| 组件 | 负责 | 不负责 |
|---|---|---|
| 意图归属入口 | 读取规范化消息和活动 Track 摘要；输出唯一 attribution 结果及依据 | 批准工具、写授权、执行工具 |
| Track Manager | 创建/选定 Track；维护状态、事件父子关系、并发与取消；解析平台消息到 Track 的索引 | 解析各 SDK 私有 wire；替代 session 历史存储 |
| Channel Adapter | 解析平台身份/引用，发送消息并回报真实消息 ID/结果事实 | 自行猜测 Track 或修改确认策略 |
| Session Resolver | 依现有会话政策选择/创建历史容器 | 用 session 相同推断 Track 相同 |
| Runtime / Tool Loop | 消费 TrackContext，创建 request/turn/toolUse 子事件，执行现有策略 | 独立匹配旧 Track |
| Confirmation Manager | 创建 Track 子 confirmation，校验并结算授权，传播取消与超时 | 把 Track 匹配当作批准 |
| 日志 / 审计 | 按统一事件引用记录事实并支持链路回放 | 从缺失字段中推测事实 |

---

## 12. 验收标准

### 12.1 归属不变量

1. 每条接受的入站消息恰好归属一个 Track，或以可审计原因进入 ambiguous/rejected；不得静默丢失归属。
2. 同一用户不同通道、不同 owner/授权代际的 Track 不得互相候选或复用。
3. 已显式引用一个有效 Track 消息时，归属结果可重复、可审计；引用已失效时不得落到另一 Track。
4. 新意图与旧意图延续均有明确判定记录；session 相同本身不能作为延续的充分依据。
5. 重复入站、重复回显、迟到回调不得重复创建 Track、释放错误确认码或改变已结算状态。
6. 完成 Track 不可重开；合法后续问创建 successor 并引用父 Track；取消/过期/失败 Track 不因语义相似而恢复执行状态。
7. ambiguous 原消息被 parked 且仅能由匹配的 Clarification 一次性消费；澄清选择回复不作为新的 Agent 用户指令。
8. 延续跨 session 时 Agent 获得可验证的 TrackContextPackage；包不可用时不会在缺失上下文下执行依赖动作。
9. 每个句柄只能解析到唯一不可变澄清版本；平台消息 ID 缺失时，有效句柄仍可闭环；superseded 句柄永不按新版本解释。

### 12.2 确认不变量

1. 每个 pending confirmation 只绑定一个 Track 和一个 `toolUseId`。
2. 无精确 confirmation 归属的语义消息不得批准或拒绝任何确认。
3. 每个 confirmation 最多一个终态；超时、取消、批准、拒绝和发送失败的先后顺序由统一 reducer/settlement owner 决定。
4. 平台引用缺失或发送消息未绑定时，确认行为按明确定义安全降级，且日志保留发送与绑定的独立事实。
5. 同步 waiter 重启失效；合法异步 todo 按既有契约跨重启存活；已消费未派发动作按同一 invocation 的 fencing 恢复，未知派发结果不重放。
6. Track 终结或 successor 创建不重开旧 Track 的同步 confirmation，也不复制或重置异步 todo；撤销、session 删除与渠道关闭按异步审批需求规定的持久级联处理。

### 12.3 事件顺序矩阵

测试至少覆盖以下事件排列与并发：

- 新指令先到；分类结果先/后到；重复消息先/后到；
- 用户引用消息先于 send acknowledgement 回调到达；
- 两个确认并行创建、回显反序、用户回复反序；
- 回复到达时 confirmation 正在发送、已绑定、已超时或刚取消；
- 旧 Track 终结后短码/引用迟到，新 Track 开始并使用另一码；
- session 删除、owner 撤销、应用重启与确认提交竞争；
- 意图分类器超时、异常、零候选、唯一候选和多候选；
- 同一 session 内新意图与旧意图延续交错发生。
- 合法异步 todo 处于 pending 时重启可追认；撤销已提交/epoch 改变后重启不可追认；已 consumed 未派发恢复原 invocation，outcome_unknown 不自动重放；同 Track 的同步 waiter 则重启失效。
- 已完成 Track 的显式引用续问、窗口内高置信度无引用续问都建立 successor；父 Track 保持 completed，旧确认和授权不转移。
- continuation 跨过 idle timeout 仍带齐必要 Track 上下文；当前 session 已含其他 Track 时不混入其状态；原历史不可用时停止并请求重述。
- send fulfilled 但无平台 messageId 后收到当前句柄、合法句柄回复早于 send callback、send outcome unknown/rejected 后收到合法句柄、send 从未尝试但收到伪造句柄；分别验证可结算与拒绝边界。
- v1 `handle+option→A/B` 发布后，v2 将选项重排为 `handle2+option→B/C`；迟到的 v1 选择必须 stale，不能落到 v2 的 B；旧句柄即使 option 恰好相同也不得通过。
- v2 更新与 v1 选择原子竞争（选择先赢/更新先赢）；旧 callback 在 v2 发布后抵达；应用重启后收到 v1 回复；均不得改变当前版本映射或终态。
- 相同候选内容的投递重试可复用当前版本句柄但独立记录 attempt；任一候选/顺序/含义改变必须换句柄，过期句柄永不复用。
- 两个 Clarification 交错、裸选项、错误句柄、重复选择、候选关闭及选择时撤销 owner；均验证原始消息只执行一次或明确终结。

验收看所有排列是否维持上述不变量，不以单个历史反例转绿作为完成标准。

---

## 13. 分阶段建议与待讨论项

### 13.1 分阶段建议

1. **设计定稿：** 确认 Track 定义、意图归属规则、歧义策略、状态模型、平台能力契约和 session 删除行为。
2. **影子归属：** 记录 classifier 对新旧 Track 的判断与依据，不改变现有路由；评估误归属、歧义率和成本。
3. **Track 事件骨架：** 引入 Track/事件关联及统一日志，保持当前执行与确认语义不变，验证跨模块 join 完整性。
4. **入口切换：** 由归属入口为微信/飞书消息赋 Track；Router、wake 和 Runtime 只传播上下文。
5. **确认迁移：** confirmation 成为 Track 子对象，补齐 toolUse 与平台消息映射、统一取消/超时/终态。
6. **收敛旧逻辑：** 移除各模块重复推断与含混事件名；逐通道验收平台引用能力。

### 13.2 待讨论项

| ID | 问题 | 本稿建议默认值 |
|---|---|---|
| Q1 | 完成后续问的默认候选窗口多长？ | 生命周期规则已定：终态不重开，完成 Track 命中后创建 successor；窗口长度和候选排序仍需讨论。 |
| Q2 | 哪些 ambiguous 场景澄清、哪些直接新建？ | 有合理且有限的候选就创建 Clarification 并暂存原消息；无候选或分类器不可用时新建/澄清的阈值待讨论。确认类消息永不靠语义消歧批准。 |
| Q3 | 意图识别用规则、模型还是混合？ | 先固定协议和离线/影子评估接口，再根据误归属率、时延、成本决定实现。 |
| Q4 | 模型不可用时降级？ | 不做推测性 continuation；显式引用仍可确定归属，否则按统一规则新建或建立 Clarification。 |
| Q5 | Track/Clarification 超时及保留期限？ | 与同步 confirmation TTL、异步 todo 24h TTL、session idle 分开定义；异步 todo 必须继续遵守既有 TTL。 |
| Q6 | 用户删除 session 后的 Track？ | 对 origin session 的异步 todo 按既有契约失效；其他 Track 事件按数据删除策略清理/留最小 tombstone，不能复活已删除历史。 |
| Q7 | 是否需要用户可见 Track 句柄？ | 普通归属仍优先意图识别；Clarification 若引用能力不稳必须有独立句柄。Track UUID 不展示，所有句柄命名空间隔离且不能承担授权。 |
| Q8 | 是否把桌面消息也纳入 Track？ | 先在远程 IM 验证模型；若 Track 要成为跨渠道交互根，再规划桌面接入，不能默认跨渠道自动续接。 |
| Q9 | 活动 Track 数量与同用户并发策略？ | 限制候选集并按 owner 隔离；多个 Track 可同时等待，但具体 Agent 执行并发继续遵守 session lease。 |
| Q10 | 活动 Track / Clarification 的落盘与重启恢复边界？ | Track/Clarification 的归属事实应可恢复；同步 waiter 失效；异步 todo 与消费后派发状态严格沿用既有持久恢复契约。 |

---

## 14. 初步验证指标

- 意图归属结果的覆盖率、ambiguous 比例、classifier unavailable 比例。
- 用户纠正“你接错上下文”或重新说明上下文的比例，作为误续接信号。
- 每条 Track 的入站、出站、request、turn、toolUse、confirmation 关联完整率。
- confirmation 回复无法绑定、迟到、重复和跨项拒绝的数量。
- 发送 fulfilled 但平台消息 ID 缺失/回显无法关联的比例。
- Track 创建至终态的时长、取消原因和重启恢复结果。

指标不得通过记录不必要的原始用户正文实现；语义分类的可解释证据应脱敏或摘要化。

---

## 15. 明确需要进一步验证的事实

1. 微信 iLink SDK 的 `send()` / `sendRaw()` acknowledgement 中实际 `message_id` 字段结构，以及 adapter 未提取到它的具体原因。
2. 微信 Poller 是否稳定回送本应用发出的 BOT 消息，回显是否携带可与 send 请求关联的 client ID / server message ID。
3. 用户在微信客户端执行“引用回复”时，哪些消息类型和发送路径会在原始 wire、SDK 对象中保留引用字段；当前日志已出现引用字段缺失样例。
4. 飞书引用消息的 ID 与权限语义是否能提供同等关联契约。
5. 意图分类所需的候选 Track 摘要、跨消息上下文范围、成本/延迟目标及隐私保留策略。

在上述平台契约验证完成前，需求可讨论 Track 与意图归属，但不得宣称外部引用关联已可靠闭环。
