# 产物决策远程 IM 入站接线技术方案

> 版本：v1.2  
> 日期：2026-07-18  
> 状态：待评审  
> 对应需求：[artifact-decision-remote-im-requirement.md](../requirement/artifact-decision-remote-im-requirement.md)  
> 适用渠道：飞书私聊、微信私聊

## 1. 方案目标

本文给出产物决策在飞书、微信远程会话中的出站、入站、并发隔离和生命周期接线方案。方案复用现有：

- `electron/remote/artifactDecisionRemote.ts` 的编号选项编解码；
- `electron/artifacts/artifactDecisionBridge.ts` 的 pending、waiter 与桌面提交入口；
- `electron/artifacts/toolLoopArtifactFlow.ts` 的多轮 `decision_required → resume` 流程；
- 飞书、微信现有私聊 guard、出站 adapter、去重、审计和工具 Y/N 确认能力。

本期不引入 IM 富文本卡片，不持久化待决策队列，不改造工具 Y/N 确认协议，也不改变产物决策本身的选项语义。

最终链路为：

```text
远程 tool loop 产生 decision_required
  → bridge 注册 request + waiter + RemoteArtifactDecisionOwner
  → 桌面 IPC（可选）与 IM 文本出站
  → 用户从桌面或对应 IM 私聊作答
  → 同一原子提交入口先到先得
  → waiter 恢复，resolver 进入 ready 或下一轮 decision_required
```

## 2. 现状约束与差距

### 2.1 可直接复用的实现

| 能力 | 当前文件 | 处理 |
|---|---|---|
| 决策创建与恢复 | `electron/artifacts/toolLoopArtifactFlow.ts` | 保留循环与 intent 传递，只把 `onDecisionRequired` 改为异步 |
| pending registry | `electron/artifacts/decisionRegistry.ts` | 继续生成 UUID、校验 binding、生成 user-decision provenance |
| 桌面等待与提交 | `electron/artifacts/artifactDecisionBridge.ts` | 扩展 Owner 索引和结果协议，桌面与 IM 共用 |
| 远程文本编解码 | `electron/remote/artifactDecisionRemote.ts` | 扩展 UUID 前缀协议，作为唯一 codec |
| 远程上下文 | `electron/tools/types.ts` | 增加固定目标的决策出站 callback 与审计 callback |
| 飞书入站 | `electron/feishu/remoteCommandRouter.ts` | guard 后、工作区消歧/普通指令前插入处理 |
| 微信入站 | `electron/wechat/weChatCommandRouter.ts` | guard 后、普通指令前插入处理 |
| 平台文本出站 | `sendFeishuRemoteOutbound`、`sendWeChatRemoteOutbound` | 由构建 `RemoteContext` 的平台层封装，不让 tool loop 分渠道 |

### 2.2 当前实现必须修正的问题

1. `submitArtifactDecisionResponse` 返回 `void`，且在 binding 不匹配时可能依赖 registry 抛错，不适合作为 router 控制流。
2. timeout/abort 只删除 waiter，没有同步删除 request 和 registry pending，会留下短期幽灵状态。
3. bridge 没有渠道、绑定用户和私聊目标索引，无法安全地从 IM 入站找到候选决策。
4. `resolveArtifactToolWriteWithDecision.onDecisionRequired` 是同步回调，不能等待 IM 出站，也不能把出站失败反馈给 tool loop。
5. codec 不识别 UUID 前缀，且 `requiresInput` 缺值时仍会产生纯编号 choice。
6. 两个 router 尚无共享的产物决策入站处理器；若直接在平台文件拆词，会形成两套协议。

## 3. 设计原则

1. **一个协议实现**：UUID 抽取、编号解析、输入值编码、用法示例全部位于 `artifactDecisionRemote.ts`。
2. **一个消费入口**：桌面 IPC 和远程 IM 都调用 `submitArtifactDecisionResponse`，只有返回 `resolved` 的调用方成功。
3. **先认证再匹配**：IM 决策处理只能接收已通过私聊和绑定 guard 的 `source/authOwner/privateChatTarget`，不得全局按 decisionId 查找。
4. **Owner 与 pending 同寿命**：注册、成功消费、timeout、abort、请求取消和出站失败都通过 bridge 的统一清理函数更新全部内存结构。
5. **平台固定出站目标**：`RemoteContext.sendDecisionText` 在 router 构建时闭包绑定本次私聊，业务层不能传入收件人。
6. **失败关闭等待**：IM 文本发送失败后取消本轮决策，桌面卡也立即失效，避免幽灵 waiter。
7. **不创建新 Agent 请求**：命中 choice、hint、ambiguous、stale 或 unknown id 后必须直接返回；只有 `not_decision`，以及无 UUID 且零候选的 `no_candidates`，才进入后续路由。

## 4. 总体架构

### 4.1 模块职责

```text
toolChatLoop.ts
  └─ resolveArtifactToolWriteWithDecision(...)
       ├─ artifactDecisionBridge.ts
       │    ├─ registry / requests / waiters
       │    └─ RemoteArtifactDecisionOwner 索引
       └─ remoteContext.sendDecisionText(serialize(...))

remoteCommandRouter.ts / weChatCommandRouter.ts
  └─ artifactDecisionImBridge.ts
       ├─ 按 owner key 查询候选
       ├─ artifactDecisionRemote.ts（UUID + body 编解码）
       ├─ authorizeBeforeSubmit()（同步授权重验证）
       ├─ submitArtifactDecisionResponse(...)
       └─ replyText / audit
```

新增 `electron/remote/artifactDecisionImBridge.ts`，承载渠道无关的候选消歧、提示和提交编排。两个 router 提供已认证身份、原始 guard snapshot、同步授权重验证闭包及平台 reply/audit callback。最终授权检查由共享处理器在原子 submit 的紧前一步执行，router 不能只在调用共享处理器之前预检。

### 4.2 依赖方向

- `electron/artifacts/` 不依赖飞书或微信 SDK；Owner 的 `source` 只使用共享枚举。
- `electron/remote/` 可依赖 artifact bridge 和共享类型，但不依赖具体 router。
- 平台 router 依赖共享 IM bridge，并注入出站能力。
- `toolChatLoop` 只判断 `remoteContext` 是否存在，不按 `source` 选择发送实现。

## 5. 核心数据模型

### 5.1 RemoteContext 扩展

在 `electron/tools/types.ts` 增加：

```ts
export type RemoteArtifactDecisionAuditEvent =
  | 'prompt'
  | 'prompt_failed'
  | 'resolved'
  | 'hint'
  | 'stale'
  | 'binding_mismatch'
  | 'invalid'
  | 'ambiguous'
  | 'unknown_id'
  | 'authorization_revoked'

export interface RemoteContext {
  // 现有字段省略
  sendDecisionText?: (text: string) => Promise<void>
  appendArtifactDecisionAudit?: (
    event: RemoteArtifactDecisionAuditEvent,
    fields: Record<string, unknown>
  ) => void | Promise<void>
}
```

`sendDecisionText` 不接收 target：

- 飞书闭包固定 `runner + messageId/chatId`，调用既有文本出站函数；
- 微信闭包固定 `bot + inboundRaw/userId`，调用既有文本出站函数；
- 不通过 `run_lark_cli`、`lark_*` 或 `wechat_reply` 工具，因而不会触发嵌套工具确认。

私聊目标统一归一化为：飞书 `chatId`，微信 `userId`。构建 Owner 时若 `authOwner`、目标、`originSessionId` 或 `requestId` 为空，远程注册直接失败，不能降级为宽松匹配。

### 5.2 Owner 与索引

```ts
export type RemoteArtifactDecisionOwner = {
  source: 'feishu' | 'wechat'
  authOwner: string
  privateChatTarget: string
  originSessionId: string
  requestId: string
  decisionId: string
}
```

bridge 新增：

```ts
const ownersByDecisionId = new Map<string, RemoteArtifactDecisionOwner>()
const decisionIdsByInboundOwner = new Map<string, Set<string>>()

function inboundOwnerKey(owner: Pick<RemoteArtifactDecisionOwner,
  'source' | 'authOwner' | 'privateChatTarget'>): string
```

key 使用长度前缀编码或稳定 JSON 编码，禁止简单用可出现在字段内的分隔符拼接。查询只暴露：

```ts
listArtifactDecisionCandidates(identity): ArtifactDecisionCandidate[]
```

候选包含 `owner` 和只读 `request` 快照，按注册时间排序仅用于稳定提示，不用于“猜测最近一条”。调用方无法获得其他 owner key 下的 pending。

### 5.3 bridge 状态单元

建议把当前三张 Map 的离散对象合并为按 `decisionId` 保存的状态单元：

```ts
type ActiveArtifactDecision = {
  request: ArtifactDecisionRequest
  owner?: RemoteArtifactDecisionOwner
  waiter?: Waiter
  state: 'registered' | 'waiting'
}

const activeByDecisionId = new Map<string, ActiveArtifactDecision>()
const decisionIdByWaiterKey = new Map<string, string>()
```

`requestId + toolUseId` 在单次 tool loop 中串行，只能对应一个活跃 decision。若重复建立 waiter，旧 waiter 应先以 `null` 关闭并完整清理，测试中视为编程错误并记录日志。

## 6. bridge API 与原子消费

### 6.1 注册与等待

将注册与远程 Owner 绑定合并为一次同步调用：

```ts
registerArtifactDecisionRequest(request, ownerInput?): ArtifactDecisionRequest
waitForArtifactDecisionResponse(decisionId, signal?): Promise<ArtifactDecisionWaitResult | null>
```

Owner 的 `decisionId` 由 registry 创建后填入，调用方不能自行指定。注册函数在同一个同步调用栈内依次创建 registry pending、active state 和 owner index；任一步校验失败则回滚已创建状态。

等待 API 改用 `decisionId`，避免仅凭 `(requestId, toolUseId)` 找 waiter。timeout 与 abort 都调用：

```ts
settleArtifactDecision(decisionId, null, 'timeout' | 'abort')
```

该函数删除 registry pending、active state、waiter key 和 Owner 两级索引，再异步 resolve。`AbortSignal` listener 在所有结束路径中移除，避免长期持有闭包。

### 6.2 提交结果

```ts
export type ArtifactDecisionSubmitResult =
  | 'resolved'
  | 'stale'
  | 'binding_mismatch'
  | 'invalid'

submitArtifactDecisionResponse(payload): ArtifactDecisionSubmitResult
```

判定顺序：

1. 校验 payload 必填字符串、`attempt` 非负整数、choice 非空；失败返回 `invalid`。
2. 按 `decisionId` 读取 active state；不存在或没有活跃 waiter，返回 `stale`。
3. 同步比较 `requestId/sessionId/toolUseId/attempt`；任一不符返回 `binding_mismatch`，不修改状态。
4. 调用 registry 的非抛出 consume；其“不存在”映射 `stale`，“binding 不符”映射 `binding_mismatch`，其他非法映射 `invalid`。
5. 在任何 `await` 或异步调度前同步删除 active、waiter 和 Owner 索引。
6. `setImmediate` resolve waiter，返回 `resolved`。

Electron 主进程 JavaScript 在同一事件循环中执行同步临界区。步骤 2–5 不包含 `await`，因此桌面与 IM 近同时提交时，第一方完成删除后第二方只能看到 `stale`，恰好一次 resolve。无需 mutex；后续若状态迁移到异步存储，才需要事务或互斥。

`decisionRegistry.consumeAsUserDecision` 建议同时改成判别联合/结果枚举，而不是以异常表达正常竞态；若暂时保持抛错，bridge 必须捕获并映射，绝不能让异常冒泡到 IPC 或 router。

### 6.3 清理 API

保留请求级和会话级入口，但都复用单个 `settleArtifactDecision`：

```ts
cancelArtifactDecision(decisionId, reason): boolean
cancelArtifactDecisionsForRequest(requestId): number
clearArtifactDecisionsForSession(sessionId): number
```

超时、abort、chat cancel、紧急停止、远程出站失败和测试 reset 均删除 registry/request/waiter/Owner。清理后任何迟到提交返回 `stale`。

### 6.4 桌面 IPC 兼容

`artifactIpc.decisionResponse` 保留现有路径值校验，再返回 bridge 结果。IPC handler 应把结果回传 renderer；renderer 对非 `resolved` 将卡片标记为“已处理或已失效”，不重复提交。

若当前 preload API 是单向 `send`，第一阶段可保持签名并由主进程发送 `artifact:decision-response-result`；推荐后续改为 `invoke` 直接取得结果。无论 UI 是否立即消费结果，主进程原子语义必须先落地。

## 7. 唯一编解码协议

### 7.1 API 调整

在 `artifactDecisionRemote.ts` 增加独立前缀抽取，平台 router 不自行拆词：

```ts
type ExtractedRemoteDecisionReply = {
  replyDecisionId?: string
  body: string
  hadUuidPrefix: boolean
}

extractArtifactDecisionReplyPrefix(raw): ExtractedRemoteDecisionReply
parseArtifactDecisionReplyBody(body, options):
  | { kind: 'choice'; choice: string }
  | { kind: 'usage_hint' }
  | { kind: 'not_decision' }
```

UUID 使用大小写不敏感的完整 `8-4-4-4-12` 正则，归一化为小写。组合 API 可保留 `parseArtifactDecisionRemoteReply` 名称以兼容既有调用，但其内部必须调用上述两个函数。

### 7.2 body 解析规则

- 首 token 非正整数：无 UUID 前缀时为 `not_decision`；有前缀时为 `usage_hint`。
- 编号越界为 `usage_hint`。
- 选项有 `requiresInput` 而剩余值为空时为 `usage_hint`，不得返回纯编号 choice。
- `rename` 编码为 `rename:<value>`；`directory` 统一反斜杠、去末尾 `/` 后编码为 `change-directory:<value>`。
- 不需要输入的选项后若带额外文本，返回 `usage_hint`，避免误吞普通指令。
- `1 <uuid> path` 没有 UUID 前缀；当选项需要目录时，其 value 含 UUID。为满足需求“不得得到合法 directory choice”，codec 应识别 value 首 token 为 UUID 或包含尾部 `#UUID` 的非法后缀并返回 `usage_hint`。

最终路径的越界、symlink 和字面路径安全仍由现有 artifact resolver 校验，codec 只负责协议结构。

### 7.3 出站格式

`serializeArtifactDecisionForRemote(request)` 输出：

```text
产物决策：<标题>
决策 ID：<真实 decisionId>
1. <选项>（需附带目录）
2. <选项>

单条待决时可回复：1 或 1 reports/final
若本私聊有多条待决，请回复：<真实 decisionId> 1
带值示例：<真实 decisionId> 1 reports/final
```

示例根据实际 `requiresInput` 选项生成，不能固定写 `2 review-v2.md` 导致编号与当前选项不一致。完整选项默认只发送一次；hint 使用短文案，并在多候选时列出真实 decisionId 的可复制命令。

## 8. 出站流程

### 8.1 tool loop 时序

`resolveArtifactToolWriteWithDecision` 的 callback 改为：

```ts
onDecisionRequired?: (pending) => void | Promise<void>
```

每轮流程：

1. `prepareArtifactToolWrite` 已在 bridge 注册 request；远程场景同时写入 Owner。
2. 立即建立 waiter，确保发送期间桌面提交或极快 IM 回复不会丢失。
3. 若主窗口存在，发送 `artifact:decision-request`。
4. `await onDecisionRequired(pending)`；远程 callback 调用统一 serialize，再 `await remoteContext.sendDecisionText(text)`。
5. 发送成功后 `await waiter`。
6. 收到 choice 后按当前逻辑 resume；下一轮创建新的 decisionId 与 Owner。

为使步骤 1 能拿到 remote identity，给 `resolveArtifactToolWriteWithDecision` 增加可选 `remoteDecisionOwner`，由 `toolChatLoop` 从 `remoteContext` 构造。不要让 `artifactDecisionBridge` 读取整个 `RemoteContext`，以保持层间解耦。

### 8.2 出站失败

`onDecisionRequired` 抛出时：

1. 记录 `prompt_failed`，错误只保留分类和截断摘要；
2. 调用 `cancelArtifactDecision(decisionId, 'outbound_failed')`；
3. `resolveArtifactToolWriteWithDecision` 返回 `kind: 'error'`，错误文案为“产物决策发送失败，本次写入已取消，请稍后重试”；
4. 已显示的桌面卡随后提交只会得到 `stale`；
5. 外层远程 Agent 的正常失败摘要负责让用户看到最终失败，不再保留五分钟等待。

若远程上下文缺少 `sendDecisionText`，视为配置/接线错误并走同一失败路径，不能静默退回仅桌面等待。

## 9. 入站处理

### 9.1 共享处理器接口

```ts
type ArtifactDecisionInboundResult =
  | { handled: false; reason: 'not_decision' | 'no_candidates' }
  | { handled: true; reason:
      'resolved' | 'usage_hint' | 'ambiguous' | 'unknown_decision_id' |
      'stale' | 'binding_mismatch' | 'invalid' | 'authorization_revoked' }

type AuthorizeBeforeArtifactDecisionSubmit = () =>
  | { ok: true }
  | { ok: false; reason: 'authorization_revoked' }

handleArtifactDecisionInbound({
  raw,
  identity: { source, authOwner, privateChatTarget },
  authorizeBeforeSubmit,
  replyText,
  audit
}): Promise<ArtifactDecisionInboundResult>
```

`authorizeBeforeSubmit` 由各 router 构造，闭包持有本条入站在首次 guard 时得到的原始 `ImAuthSnapshot` 和动态配置读取函数：飞书传 `getConfig`，微信传 `getConfig + isLoggedIn`。callback 内调用 `revalidateImInboundGuard` 并把任意失败归一化为 `authorization_revoked`。

该 callback 是提交安全边界的一部分，必须满足以下约束：

- 类型和实现均为**同步函数**，不得发送消息、写日志或执行任何 I/O；
- 共享处理器在构造完 payload 后、调用 `submitArtifactDecisionResponse` 的紧前一条语句调用它；
- `authorizeBeforeSubmit()` 与同步原子 submit 之间不得出现 `await`、回调调度或其他可重入调用；
- 失败时不 submit、不消费 pending、不发成功回执，返回 `handled: true/authorization_revoked`；审计与失败提示在此后执行；
- router 不得把调用共享处理器前的 revalidate 当作该 callback 的替代品。

当前 `revalidateImInboundGuard` 是同步配置快照校验，因此“同步重验证 + 同步原子 submit”构成不可插入异步授权变化的提交边界。如果未来重验证需要网络或其他异步 I/O，本接口不得直接改成 `Promise`；必须把授权 generation/epoch 纳入 bridge 的同步消费条件，由 bridge 在删除 waiter 前读取当前 generation 并一起比较，或使用包含授权状态的事务。否则会重新引入 `await authorize → submit` 的 TOCTOU 窗口。

共享处理器必须先调用 codec 抽取 UUID 前缀，再判断候选数，不能以“零候选”提前返回：

- 有合法 UUID 前缀时，该消息明确属于产物决策协议。命中同 owner tombstone 返回 `handled: true/stale`；否则无论 active 候选是否为 0，都返回 `handled: true/unknown_decision_id`，不得进入工作区消歧或 Agent。
- 无 UUID 前缀且候选数为 0 时，返回 `handled: false/no_candidates`。因此普通纯数字消息仍兼容后续路由。

为满足迟到回复得到 stale，可维护一个有界、短 TTL（建议 10 分钟）的 tombstone，仅保存 `decisionId + owner key + endedAt`，不保存 choice 或输入。匹配同 owner tombstone 时回复“该决策已处理或已失效”；跨 owner tombstone 不可见。进程重启后 tombstone 丢失，此时带合法 UUID 前缀的迟到回复返回 unknown id，但仍被消费，不会创建新 Agent 任务。

### 9.2 候选消歧算法

1. 调用 codec 抽取 UUID 前缀，得到 `replyDecisionId? + body`。
2. 按已认证 identity 查询 active 候选和同 owner tombstone；查询范围始终受 owner key 限制。
3. 有 UUID 前缀：
   - UUID 属于 active 候选：选中该 request；
   - UUID 属于同 owner tombstone：回 `handled/stale`；
   - 否则回 `handled/unknown_decision_id`，即使 active 候选数为 0 也不得进入 Agent。
4. 无 UUID 前缀：
   - 候选为 0：回 `handled: false/no_candidates`，不解析纯编号；
   - body 不像编号：回 `handled: false/not_decision`；
   - 候选恰为 1：选中唯一候选；
   - 候选不少于 2：回 `handled/ambiguous`，列出每个真实 id 的示例，不消费。
5. 对选中 request 的 options 解析 body。usage hint 不提交。
6. choice 经 `resolveRemoteArtifactDecisionChoice` 转换后，使用 request/owner 快照构造完整 payload。
7. 紧邻 submit 同步调用 `authorizeBeforeSubmit()`；若授权已撤销，记录 `authorization_revoked`，不 submit，pending 保持等待且本消息不进入 Agent。
8. 授权通过后不经任何 `await`，立即调用原子 `submitArtifactDecisionResponse(payload)`。
9. 仅 `resolved` 回极短成功消息；其他结果分别回失效、绑定不匹配或格式错误，不伪报成功。

tombstone 只为用户体验服务，不参与提交正确性；提交正确性仍完全由 active waiter 决定。tombstone 采用数量上限（建议每 owner 100 条）和 TTL 双重清理，避免长期增长。

### 9.3 Router 挂点与优先序

最终逻辑顺序必须是：

```text
平台基础接收校验 / 文本提取
  → 工具 ConfirmManager.tryResolveFromInbound
  → 私聊 + 绑定用户 guard
  → rate limit
  → processedStore.tryClaim(messageId)
  → guard revalidate
  → 产物决策 handleArtifactDecisionInbound
  → 工作区消歧等已认证特殊状态
  → 普通 Agent 指令（沿用同一 processed claim）
```

现有飞书 `tryResolveFromInbound` 位于完整 guard 之前，可保留其内部身份校验以避免破坏确认链；产物决策必须放到共享 `evaluateImInboundGuard` 成功且 revalidate 成功之后。微信同理。

本方案明确选择：**产物决策回复与普通远程指令共用现有入站 rate limit**。理由是 hint、ambiguous、unknown-id 等分支也会产生平台出站和审计，若绕过限流可被合法 owner 高频触发。工具 Y/N 确认继续保持当前优先位置，不受本次选择影响。被限流的消息不 claim、不进入决策处理器；用户稍后可用新 messageId 重试。

决策回复不是新 Agent 请求：

- 不创建 user/assistant message；
- 不解析或切换工作区；
- 不占用新的 remote session lease；
- 仍应使用 processed store 去重，避免平台重投造成重复提示。

router 必须在 guard 与 rate limit 通过后、决策处理前执行唯一一次 `processedStore.tryClaim(messageId)`。claim 失败立即 return，不调用共享处理器、不发送提示、不写决策审计。claim 成功后再次 revalidate guard，再进入共享处理器：若结果 `handled: true`，以 `artifact_decision_<reason>` 完成 claim；若 `handled: false`，沿用同一个 claim 继续特殊状态或普通指令，不能二次 claim。该顺序是唯一规范，前述流程图与平台实现均以此为准。

`authorization_revoked` 也是 handled 终态：router 必须以 `artifact_decision_authorization_revoked` 完成 processed claim 后 return。pending 保持活跃是为了允许仍合法的桌面端或重新通过 guard 的同 owner 后续消息作答，不代表本条已撤销授权的消息可以重试提交。

飞书当前工作区消歧在共享 guard 之前，应调整为 guard 后按以下次序处理：产物决策优先于工作区消歧。配对窗口是尚未建立 owner 的特殊状态，仍可在上述流程之前由严格配对协议消费且不进入 rate limit、processed claim 或产物决策；它不属于流程图中的“已认证特殊状态”。

### 9.4 授权重验证

产物决策链路执行两次 `revalidateImInboundGuard`，但两次职责不同：

- 前一次保证查询 Owner 时绑定关系仍有效；
- 第二次由注入共享处理器的同步 `authorizeBeforeSubmit` callback 执行，位置固定在 payload 构造完成后、原子 submit 紧前；失败则不提交并记录 `authorization_revoked`。

推荐的关键代码形态如下，评审和测试应以此顺序为准：

```ts
const payload = buildSubmitPayload(candidate, choice)
const authorization = authorizeBeforeSubmit()
if (!authorization.ok) {
  // 此处未消费 pending；后续 await audit/reply 是安全的
  await audit('authorization_revoked', safeAuditFields(candidate))
  await replyText('当前远程授权已失效，未提交该产物决策。')
  return { handled: true, reason: 'authorization_revoked' }
}

// 两行之间禁止 await 或其他可重入调用
const submitResult = submitArtifactDecisionResponse(payload)
```

成功 submit 后的审计与回执可以异步执行，因为决策已完成原子消费。授权失败后的审计/回执也可以异步执行，因为 pending 没有被修改。

Owner 中还保存注册时的 `authOwner/source/privateChatTarget`。即使当前 guard 合法，构造 payload 前仍检查目标 Owner 与入站 identity 完全一致；不一致映射 `binding_mismatch`，不消费。

## 10. 取消、停止与重启

| 事件 | bridge 行为 | 用户侧行为 |
|---|---|---|
| 5 分钟 timeout | 完整 settle，写 tombstone | tool loop 超时失败；迟到回复 stale |
| `AbortSignal` / chatCancel | 完整 settle，写 tombstone | 可选发送“任务已取消” |
| 选择 `cancel` | 正常 `resolved` 后 resume 返回取消错误 | 成功回执后任务结束 |
| IM 出站失败 | 取消当前 decision，写 tombstone | Agent 最终摘要提示发送失败 |
| 桌面先答 | 原子 resolved，Owner 删除并写 tombstone | IM 迟到回复 stale |
| IM 先答 | 原子 resolved，Owner 删除并写 tombstone | 桌面提交 stale |
| 进程重启 | 所有内存状态自然丢失 | UUID 前缀无候选时提示未知/失效；用户需重发指令 |

进程重启后 tombstone 也丢失，符合“不持久化决策队列”的范围。带 UUID 的迟到回复仍由 unknown-id 分支消费，不会进入 Agent。

## 11. 审计、日志与隐私

统一定义内部字段，再由平台 callback 映射为 `feishu.artifact_decision.*` / `wechat.artifact_decision.*`：

| 事件 | 最小字段 |
|---|---|
| `prompt` | decisionId、kind、originSessionId、requestId |
| `prompt_failed` | decisionId、kind、errorClass、截断错误摘要 |
| `resolved` | decisionId、kind、choiceKey、hasInput |
| `hint` | decisionId?、candidateCount |
| `ambiguous` | candidateCount，不记录原文 |
| `unknown_id` / `stale` | replyDecisionId |
| `binding_mismatch` / `invalid` | decisionId、result，不记录自由输入 |
| `authorization_revoked` | decisionId、source、authorizationGeneration，不记录原文 |

不得记录完整 `raw`、rename 名称或目录值。可记录 `hasInput`、长度和不可逆 hash。Owner 标识沿用平台现有 mask/hash 规则。

## 12. 文件改动清单

| 文件 | 改动 |
|---|---|
| `electron/tools/types.ts` | 增加决策出站、审计 callback 类型 |
| `electron/artifacts/artifactDecisionBridge.ts` | Active state、Owner 索引、tombstone、结果枚举、统一 settle |
| `electron/artifacts/decisionRegistry.ts` | consume/cancel 非抛出结果或错误映射支持 |
| `electron/artifacts/toolLoopArtifactFlow.ts` | async `onDecisionRequired`、按 decisionId 等待、出站失败清理 |
| `electron/toolChatLoop.ts` | 构造 owner、统一 serialize/send、保留桌面 IPC |
| `electron/remote/artifactDecisionRemote.ts` | UUID 前缀、严格 body 解析、动态可复制示例 |
| `electron/remote/artifactDecisionImBridge.ts` | 新增共享入站匹配、同步提交前授权边界与回执编排 |
| `electron/feishu/remoteCommandRouter.ts` | 注入 send/reply/audit 和同步 `authorizeBeforeSubmit`，guard 后挂共享处理器 |
| `electron/wechat/weChatCommandRouter.ts` | 注入 send/reply/audit 和同步 `authorizeBeforeSubmit`，guard 后挂共享处理器 |
| `electron/artifacts/artifactIpc.ts` | 消费并回传 submit 结果 |
| renderer/preload 对应 artifact IPC 文件 | 展示 stale/失效状态（若改为 invoke） |

不新增数据库 migration，不修改产物表结构。

## 13. 测试方案

### 13.1 codec 单元测试

- 无前缀与 UUID 前缀的 output-location、rename、change-directory；
- 标准 UUID 大小写归一化；
- UUID 后缺编号、非法编号、requiresInput 缺值；
- 未知 UUID 的前缀抽取；
- `1 <uuid> path`、`1 path #<uuid>` 不产生合法 choice；
- serializer 包含真实 decisionId，且示例编号来自实际 options。

### 13.2 bridge 单元测试

- register 后 request/waiter/Owner 三者均可查；
- resolved 后所有 active 索引删除且 waiter 只 resolve 一次；
- 无 waiter为 stale；字段不匹配为 binding_mismatch；非法 payload 为 invalid；
- 两个同步提交恰好 `resolved + stale`；
- timeout、abort、request cancel、session clear、出站失败均完整清理；
- 同 source 不同 owner/target、不同 source 完全隔离；
- tombstone 仅同 owner 可见且 TTL/容量可清理。

### 13.3 共享 IM bridge 测试

- 0/1/多候选完整矩阵；
- 零 active、零 tombstone（等价进程重启）时，`<合法 uuid> 1` 返回 `handled/unknown_decision_id`，不进入后续路由；
- 零候选时无 UUID 的纯数字 `1` 返回 `handled: false/no_candidates`，保持普通指令兼容；
- 零 active 但同 owner tombstone 命中 UUID 时返回 `handled/stale`；跨 owner tombstone 只表现为 unknown id，不泄露状态；
- 多候选无前缀 ambiguous，不消费；
- 正确前缀只消费目标；错误/跨渠道 id 不消费；
- usage hint 后 pending 保持，可再次合法完成；
- resolved/stale/binding_mismatch/invalid 回执分支；
- 在候选选中、payload 已构造后让 `authorizeBeforeSubmit` 返回 revoked：pending 不消费、waiter 不恢复、无成功回执，结果为 handled；
- `not_decision` 不发送消息并返回未处理；
- 工具确认文本 `Y/N` 不被 codec 当成产物决策。

### 13.4 飞书与微信集成测试

两渠道使用同一组表驱动协议用例，平台测试只验证挂点和 adapter：

- guard 通过后决策回复在普通 Agent 之前被消费；
- 非绑定用户和群聊无法查询/提交 Owner；
- ConfirmManager 先于产物决策；
- handled 决策不创建会话消息、不启动 Agent、不领取新 lease；
- 同一 messageId 重投时 `tryClaim` 失败，不再次调用共享决策处理器、不 submit、不发送 stale/hint/unknown 提示、不重复写决策审计；
- 无 active、无 tombstone 的 UUID 前缀消息被处理为 unknown，不创建 user/assistant message、不启动 Agent、不领取 lease；
- 零候选纯数字消息沿用同一 processed claim 进入普通指令流程，不发生二次 claim；
- 出站正文来自同一 serializer；
- 平台发送失败使 waiter stale，且未调用 Agent 出站工具；
- 飞书在候选选中后、submit 前撤销 owner 绑定：同步 callback 拒绝提交，记录 `feishu.artifact_decision.authorization_revoked`；
- 微信在候选选中后、submit 前撤销绑定或登录态：同步 callback 拒绝提交，记录 `wechat.artifact_decision.authorization_revoked`；
- 上述两例均断言 pending 仍在、waiter 未被该消息推进、没有成功回执，且 handled 消息不会进入 Agent。

### 13.5 tool loop 回归

- ownership → output-location → overwrite 多轮新建不同 decisionId；
- resume 使用上一轮更新后的 artifact intent；
- 桌面与 IM 抢答；
- `artifactManagementEnabled=false` 时不注册 Owner、不发送、不拦截普通编号消息；
- legacy `file-write-dir:confirm`、工具 Y/N 确认、普通桌面决策不受影响。

验收时将需求 AC-IM-01～22 建立测试用例映射表，合并前要求 codec、bridge、两个 router 和 artifact flow 相关测试全部通过。

## 14. 实施顺序

### Phase 1：原子 bridge 与 codec

1. 先为现有 bridge 补 stale、binding mismatch、双提交和 timeout 清理的 RED 测试。
2. 实现结果枚举、统一 settle、Owner 索引和 tombstone。
3. 扩展 UUID codec 与严格 requiresInput 规则，保持旧无前缀调用兼容。

### Phase 2：远程出站

1. 扩展 `RemoteContext` 并在两个平台构建固定目标 callback。
2. 将 artifact callback 改为异步，接入 serializer 和失败清理。
3. 完成飞书、微信 prompt 与 prompt_failed 集成测试。

### Phase 3：远程入站

1. 新建共享 `artifactDecisionImBridge`，将同步 `authorizeBeforeSubmit` 设为必填依赖。
2. 先接飞书并验证 guard/confirm/processed claim 顺序及撤权竞态。
3. 接微信，复用同一表驱动协议与撤权竞态测试。

### Phase 4：桌面结果与全量回归

1. IPC 返回 stale/invalid 等结果并更新卡片状态。
2. 跑 artifact、tool loop、飞书、微信完整测试与类型检查。
3. 按观测事件验证日志脱敏。

每个 Phase 可独立合并，但 Phase 2/3 的开关默认关闭，待两渠道测试完成后随 `artifactManagementEnabled` 一起启用。

## 15. 灰度、回滚与风险

### 15.1 灰度

- 只对带 `remoteContext` 且会话 metadata 中 `artifactManagementEnabled === true` 的请求启用。
- 可增加仅控制“远程 IM 接线”的运行时开关，先单渠道灰度；协议和 bridge 始终共用。
- 观察 prompt_failed、ambiguous、stale、binding_mismatch 比例以及决策平均等待时间。

### 15.2 回滚

关闭 router 入站钩子和 `sendDecisionText` 注入即可回到仅桌面作答。原子 submit 结果协议和完整清理应保留，因为它们修复桌面竞态；若旧 renderer 尚未消费结果，可忽略返回值，不影响成功路径。

### 15.3 主要风险与缓解

| 风险 | 缓解 |
|---|---|
| router 调整导致特殊状态优先序变化 | 为 confirm、配对、工作区消歧、决策、普通指令建立顺序集成测试 |
| 零候选 UUID 迟到回复误入 Agent | UUID 抽取先于候选早退；合法 UUID 前缀始终由决策处理器消费为 stale 或 unknown id |
| 平台重投产生重复提示或审计 | rate limit 后、共享处理器前执行唯一 processed claim；失败立即 return |
| Owner 与 waiter 不一致 | 所有结束路径只调用统一 settle；测试逐一检查全部索引 |
| 两端抢答双消费 | 提交临界区完全同步，不在删除前 await |
| 普通数字消息被误拦截 | 无候选时不处理；单候选才允许无前缀编号 |
| UUID 污染改名/目录输入 | codec 只允许 UUID 位于首 token，并拒绝后置 UUID 形态 |
| 候选解析期间授权撤销后仍提交 | router 注入同步 `authorizeBeforeSubmit`；与原子 submit 紧邻且中间禁止 await |
| 日志泄露路径或文件名 | 只记 choice key、hasInput、长度/hash，不记 value/raw |

## 16. 关键决策结论

1. Owner 索引放在 `artifactDecisionBridge`，与 pending/waiter 同生命周期；平台 router 不维护第二份 pending Map。
2. 共享 `artifactDecisionImBridge` 负责候选消歧和提交，飞书、微信只提供认证身份和 adapter。
3. 使用同步状态迁移实现原子先到先得，不增加 mutex。
4. 使用短 TTL owner-scoped tombstone 支持迟到 IM 回复得到 stale，同时不持久化决策内容。
5. 决策入站消息参与平台 processed-store 去重，但不创建 Agent 消息、请求或 lease。
6. 出站失败立即取消本轮 waiter，桌面与 IM 后续提交都返回 stale。
7. 最终授权重验证不是 router 前置预检，而是共享处理器内紧邻原子 submit 的同步、不可绕过边界；未来若授权检查异步化，必须把 generation 纳入 bridge 原子条件。
8. UUID 前缀是保留的产物决策协议标识：前缀抽取先于候选数判断，零候选也必须 handled；只有无 UUID 的零候选消息才能落入普通路由。
9. 产物决策回复适用现有入站 rate limit；processed claim 位于 rate limit 后、共享决策处理器前，未处理消息沿用同一 claim 进入后续流程。

## 17. 修订记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0 | 2026-07-18 | 首版技术方案 |
| v1.1 | 2026-07-18 | 吸收技术评审：为共享入站处理器注入同步 `authorizeBeforeSubmit`，收敛“最终授权检查 + 原子提交”边界；补充 `authorization_revoked` 结果、审计与双渠道竞态测试 |
| v1.2 | 2026-07-18 | 吸收第二轮评审：UUID 前缀抽取前置，零候选 unknown id 仍由决策处理器消费；统一 rate limit、processed claim、guard revalidate、决策处理的唯一顺序，并补重启迟到回复与平台重投测试 |
