# 回合主循环（turn.ts）

对应源码：`packages/agent-sdk/src/turn.ts`（SDK 拥有 turn loop，宿主只解析模型 / 安全 / 执行端口）。

## 两个入口

```ts
// 宿主入口：SDK 自己问宿主取端口
async function runHostedAgentTurn(input: {
  host: AgentTurnHost
  invocationId: string
  sessionId?: string
  turnId?: string
  windowId?: string
  currentUserMessageId?: string
  assistantMessageId?: string
  requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>
  routeId: string
  request: PreparedModelCall['request']
  initialResponse?: HostCommittedModelResponse
  sessionTranscriptBaseVersion?: number
  contextProjectionCommitter?: ContextProjectionCommitter
  sessionTranscriptFailureMessages?: readonly CanonicalTurnMessage[]
  observer?: AgentTurnObserver
}): Promise<AgentTurnResult>

// 直接入口：端口已备好
async function runAgentTurn(input: RunAgentTurnInput): Promise<AgentTurnResult>

type AgentTurnHost = Readonly<{
  createPorts(invocation: {
    invocationId: string; sessionId?: string; turnId?: string; windowId?: string
    currentUserMessageId?: string
    requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>
    sessionTranscriptBaseVersion?: number
    sessionTranscriptFailureMessages?: readonly CanonicalTurnMessage[]
    routeId: string; request: PreparedModelCall['request']
  }): Promise<AgentTurnPorts>
}>
```

`runHostedAgentTurn` 入参校验（失败即抛）：

- `routeId` 必填非空。
- 给了 `currentUserMessageId` 就必须给匹配的 `requiredUserMessage`（id 必须一致）。
- `requiredUserMessage.message` 必须是 `user` 角色，且必须与 `request.messages` 中某条 JSON 完全一致。
- 请求快照深冻结（`snapshotHostedRequest`），`AbortSignal` 原样保留。
- 宿主返回的端口必须同 `invocationId`、同 `turnId`、同 `routeId`，否则抛错。

`sessionTranscriptBaseVersion` + `sessionId` 同时给出时，终态追加会携带 `transcriptCommit`（会话 transcript 的原子提交意图），`assistantMessageId` 决定是否附带 `messageMirror`；`sessionTranscriptFailureMessages` 是失败路径的兜底消息视图（有 History 时优先从最后一次 `transcript-compacted` 反推，见下『失败结算』）。

`RunAgentTurnInput` 与 `AgentTurnPorts` 形状相同，多出 `sessionId`；其中必需项：`registry`、`routeId`、`request`、`safetyGate`、`prepareTool`、`toolExecution`、`invocationId`、`maxModelTurns`。

## 端口（AgentTurnPorts）

**模型 / 请求**
`registry: ModelProviderRegistry`、`routeId`、`request: Omit<PreparedModelCall['request'], 'messages'>`。

**工具准备与执行**

```ts
prepareTool(call: CanonicalToolExecutionCall, stage: ToolPreparationStage): Promise<PermitBinding>
discardPreparedTool?(call, reason: string): void | Promise<void>
beforeToolDispatch?(call: CanonicalToolExecutionCall, context: Readonly<{ modelTurn: number; toolCallIndex: number; responseToolCallCount: number }>):
  Readonly<{ kind: 'dispatch' }> | Readonly<{ kind: 'reject'; reasonCode: string; message: string }> | Promise<...>
toolExecution: PermitBoundToolExecutionPort<CanonicalToolExecutionCall, CanonicalToolExecutionResult>  // 仅 SDK 的 permit-bound 工厂可产出
toolResourceKeys?(call): readonly string[] | undefined    // undefined 视为未知副作用
isApprovalCandidate?(call): boolean
maxConcurrentTools?: number
resourceLocks?: { acquire(keys, options?): Promise<{ release(): void }> }
confirmation?: ConfirmationPort
```

`ToolPreparationStage` 两阶段：`{ kind: 'initial' }` 与 `{ kind: 'recheck'; confirmation?: { receipt: string } }`。`confirmation` 缺省不会兜底，`ask` 决策下必须由宿主提供。

`beforeToolDispatch` 是**纯派发准入**（存储重构后新增）：在候选槽与 `prepareTool` **之前**调用；返回 `reject` 不抛错——循环写 `tool-call-not-dispatched(reasonCode)`，并把 `message` 作为 `is_error` 工具结果回给模型（与 `returnDeniedToolsToModel` 的"拒绝可对话"精神一致，但不受该开关限制）。

**持久化与投影**

`history?: HistoryPort`、`contextProjectionCommitter?: ContextProjectionCommitter`、`sessionLedgerForToolResult?` / `sessionLedgerForNotDispatched?` / `sessionLedgerForModelResponse?` / `sessionLedgerForAttemptUsage?` / `sessionLedgerForInvocationTerminal?` 系列的 `sessionLedger*` 钩子、`recordProviderAttemptUsage?`、`afterToolResult?(call, result, source?)`、`sessionTranscriptBaseVersion?`、`sessionTranscriptFailureMessages?`。

**恢复与边界**

`recoverProviderAttempt?`（provider 尝试失败后的一次恢复：可返回 retry / reject）、`recoverOutputLimit?`（`length` 截断后的受限续写）、`planContextReplacement?`（preflight 与 turn boundary 的**单一上下文规划器**）。

```ts
type ContextReplacementPlanInput =
  | Readonly<{ phase: 'preflight'; invocationId: string; modelTurn: number; windowId?: string; request: PreparedModelCall['request']; messages: readonly CanonicalTurnMessage[]; requestProjection?: unknown; currentUserMessageId?: string; requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }> }>
  | Readonly<{ phase: 'turn-boundary'; invocationId: string; modelTurn: number; windowId?: string; response: CanonicalTurnMessage; messages: readonly CanonicalTurnMessage[]; toolCalls: readonly CanonicalToolExecutionCall[]; usage: AgentTurnResult['usage']; requestProjection?: unknown; currentUserMessageId?: string; requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }> }>

type ContextReplacementPlanResult =
  | Readonly<{ messages: readonly CanonicalTurnMessage[]; windowId?: string; historyPayload?: Record<string, unknown> }>
  | Readonly<{ rejected: 'OVER_BUDGET' }>
```

- 返回 `void`（或 `undefined`）= 不替换；返回 `{ messages }` = 替换（与当前消息 JSON 等价时视为未替换）；返回 `{ rejected: 'OVER_BUDGET' }` = 预算拒绝。
- preflight 的拒绝抛 `ModelPreflightRejectedError('OVER_BUDGET')`；turn-boundary 的拒绝抛 `InvalidTurnBoundaryError`。
- 两种 phase 都在提交前校验"必需 user 消息 / 待派发提案不得被破坏"，提交经 SDK 的 invocation context 端口（`transcript-compacted`），失败按 `AgentTurnBoundaryProjectionError` 结算。

**取消与额度**

`request.signal`（超时用 `signal.reason === AGENT_TURN_TIMEOUT_ABORT_REASON` 区分）、`maxModelTurns`（必填正整数）、`maxToolRounds?`（只计**已派发**的工具轮）、`returnDeniedToolsToModel?`、`providerStreamIdleTimeoutMs?`（provider 流空闲护栏，缺省 120_000，0/负值关闭）。

## Observer 与 critical 开关

```ts
type AgentTurnObserver = Readonly<{
  criticalModelResponseProjection?: boolean
  criticalModelRequestProjection?: boolean
  criticalModelAttemptUsageProjection?: boolean
  criticalToolProjection?: boolean
  onModelRequest? / prepareModelRequest? / prepareUsageAttribution?
  onProviderRetry? / prepareProviderRetry? / prepareContextBoundaryEvidence?
  onModelAttemptDiscarded? / onOutputRecovery? / onModelChunk? / onModelResponseCommitted?
  onToolStarted? / onToolFinished?
  onDispatchStoppedWithPending? / onUndispatchedToolsMaterialized? / onToolDispatchFailureContext?
  onTurnOutputReady? / onTurnFinished? / onTurnFailed?
  onObservationError?(error: unknown, stage: string): void | Promise<void>   // stage 为下方字面量联合
}>
```

- `critical*` 为真时对应回调是**必需提交步骤**：缺失回调在循环开始即抛错（`criticalModelRequestProjection` 还要求 `onProviderRetry`）；回调失败会转成 `AgentTurnHostProjectionError` / `AgentTurnToolProjectionError`，并让回合以 `interrupted` 结算（响应投影失败时还会把未派发工具标记 `tool-call-not-dispatched('HOST_PROJECTION_FAILED')`）。
- 非 critical 时回调失败只走 `onObservationError` 诊断，不影响执行结论。
- `prepareUsageAttribution` 返回的归因输入会并入每次 attempt 的用量投影（`usage` 端口 / `sessionLedgerForAttemptUsage`）。
- `prepareContextBoundaryEvidence` 在已接受响应之后产出 `{ sessionLedger?, contextBoundaryEvidence? }`：前者并入 `model-response-committed`，后者作为 turn-boundary 规划的 `requestProjection` 输入。
- `onDispatchStoppedWithPending` / `onToolDispatchFailureContext` / `onUndispatchedToolsMaterialized` 只做**诊断留痕**（中止原因、失败工具上下文、补物化的未派发槽位数），不改变结算。
- `stage` 取值：`model-request`、`model-chunk`、`model-attempt-discarded`、`model-response-committed`、`model-attempt-usage`、`tool-started`、`tool-finished`、`turn-output-ready`、`turn-finished`、`turn-failed`、`history-terminal`、`prepared-tool-discard`、`dispatch-diagnostic`。

## 结果

```ts
type AgentTurnResult = Readonly<{
  text: string
  messages: readonly CanonicalTurnMessage[]
  modelTurns: number
  finishReason: 'stop' | 'tool-calls' | 'length' | 'cancelled'
  usage: Readonly<{ inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>
}>
```

`usage` 为该回合内**所有** model request 的聚合。

## 循环阶段概览

对 `modelTurns = 1 .. maxModelTurns`：

1. **回合前检查**：`throwIfAborted`（超时信号 → `AgentTurnTimedOutError`，否则 `AgentTurnCancelledError`）；`registry.prepare`；`ensureInitialHistoryContext`——已有任一**闭合事件**（`invocation-completed` / `invocation-failed` / `invocation-interrupted` / `invocation-parked`）→ `AgentTurnHistoryAlreadyTerminalError`；已有 `invocation-context-committed` / `transcript-compacted` → `assertHistoryRequestCompatibility`（逐条比对历史里的 `requestSnapshot`：route 身份必须一致、剔除 `messages` 后的 options 必须一致；`model-attempt-discarded` 中 `reasonCode === 'EFFORT_UNSUPPORTED'` 的 `requestPatch` 会改写 thinking options 后纳入比对）；否则要求"空历史"或"仅一条合规的 `session-input-committed`"，必要时追加 `invocation-context-committed`（含 messages、requestSnapshot、requiredUserMessage），不合规抛 `history base context is missing for a non-empty invocation`。
2. **请求投影与预检**：`observer.prepareModelRequest` → `planContextReplacement({ phase: 'preflight' })`。返回 `{ messages }` 且与当前消息不等价时：先校验必需 user 消息仍在，再经 invocation context 端口提交（`transcript-compacted`，`reason` 按 windowId 是否变化取 `window-transition` / `auto-compact`），提交后**重算 request 与请求观测**；收益判定综合 `requestProjection` 的 `budget.totalInputBudget` 与 `contextUsage.projectedTokens` / `surfaceSnapshot.surfaceTokens`（替换前后都判），超预算抛 `ModelPreflightRejectedError('OVER_BUDGET')`。提交结果 `commit-uncertain` → `AgentTurnBoundaryProjectionError`。
3. **路由冻结**：`registry.getProvider`；首轮固化 `pinnedRoute` / `pinnedProvider`，后续不匹配抛 `ModelRouteChangedError`。
4. **provider 尝试**：追加 `model-request-started`（含 `requestSnapshot` 与可选 `sessionLedger`）→ `onModelRequest`（`criticalModelRequestProjection` 时是必需提交步骤）→ 流式收集 `collectModelAttempt`（带 `idleTimeoutMs = providerStreamIdleTimeoutMs ?? 120_000`）；流错误若已收到 usage，先按 `disposition: 'failed'` / `reasonCode: 'PROVIDER_STREAM_FAILED'` 投影一次用量；流抛错时**先** `throwIfAborted`，再走 `recoverProviderAttempt`（同一 model request 至多再尝试一次，超限抛 `ModelAttemptRecoveryRejectedError('RETRY_LIMIT_EXCEEDED')`）；`reject` 且带 response 时先投影 discarded usage、再写 `model-attempt-discarded`；若 `request.signal` 已 abort 而收尾 finish 不是 `cancelled`，finish 会被改写成 `cancelled`（**取消优先于已收到的终态**）。
5. **恢复重试**（进入该分支时）：`recovery.reasonCode` 必须匹配 `^[A-Z0-9_]{1,64}$`（否则直接抛普通 `Error`）；恢复后的 messages 必须仍含必需 user 消息，否则抛 `InvalidTurnBoundaryError`；`recordTranscriptCompaction !== false` 时上下文按 `reason: 'provider-recovery'` 走替换（宿主给了 `contextProjectionCommitter` 走端口提交，否则直接追加 `transcript-compacted`），`=== false` 时只写带 `requestPatch` 的 `model-attempt-discarded`；可选 `provider-retry-scheduled`（含 `backoffMs: 0`）+ `onModelAttemptDiscarded` + `onProviderRetry`，随后为新尝试再写一条 `model-request-started`（`attempt: 2`）。
6. **取消结算**：`finish.reason === 'cancelled'` 时先结算这次尝试——投影 attempt usage（`finishReason: 'cancelled'`、`disposition: 'cancelled'`）→ 追加 `model-attempt-discarded`（`reasonCode: 'TURN_CANCELLED'`，带 `modelTurn` / `attempt` / `finishReason` / `usage`，可选 `sessionLedger`）→ `onAcceptedUsage`——然后按 `request.signal` 判定：超时信号抛 `AgentTurnTimedOutError`，否则抛 `AgentTurnCancelledError`。**无 `usage` 的 cancelled 尝试**只做 abort 校验后抛错（不投影、不写事件）；`initialResponse` 路径一律不结算，判定后直接抛错。
7. **响应归约与提交**：非 cancelled 尝试必须带 `usage`，否则抛 `InvalidModelStreamError('non-cancelled provider attempt completed without usage')`；随后拼装 assistant canonical 消息（thinking / text 合并、`thinking-signature` 回填、混合文本 + 工具调用时保留块结构）；带 `assistantMessageId` 时校验 canonical 响应 id（已带 id 且不一致即抛错，未带则补上）→ 投影 accepted attempt usage（`disposition: 'completed'`）→ `prepareContextBoundaryEvidence` → 追加 `model-response-committed`（`modelTurns === 1 && initialResponse` 时**不重复写**）→ `onModelResponseCommitted`（critical 失败时把仍 pending 的工具补 `tool-call-not-dispatched('HOST_PROJECTION_FAILED')` 并抛 `AgentTurnHostProjectionError`）。
8. **输出上限恢复**：`finish.reason === 'length'` 时对每个工具调用追加 `tool-call-not-dispatched`（`MODEL_OUTPUT_TRUNCATED`），可选 `provider-retry-scheduled`（`code: 'model_output_token_limit'`）与 `replay-message-committed`；把已提交 assistant 消息、失败 tool 消息与续写消息并入 `messages` 后 `continue`；没有续写消息则抛 `ModelOutputTokenLimitError`。
9. **turn boundary**：`planContextReplacement({ phase: 'turn-boundary' })` 返回 `{ messages }` 时，先校验"待派发提案不得被破坏"（每个 `toolCallId` 仍在、`name` / `input` / `thoughtSignature` 全等）与"必需 user 消息仍在"，否则抛 `InvalidTurnBoundaryError`；有 History 时经 invocation context 端口提交（`reason` 按 windowId 变化取 `window-transition` / `auto-compact`），提交成功标记 `boundaryReplacedTranscript`（本轮不再追加已提交响应）；无 History 时直接替换内存 messages。
10. **无工具调用即结束**：返回 `AgentTurnResult`。
11. **额度检查**：`maxToolRounds` 用尽 → 全部工具 `markNotDispatched('tool_loop_max_rounds_exceeded')` 并抛 `ToolLoopRoundLimitError`；`modelTurns === maxModelTurns` → 抛 `ModelTurnLimitError`（**在派发任何工具之前**）。
12. **工具阶段**（见下），完成后 `dispatchedToolRounds += 1` 进入下一轮。

循环末尾兜底抛 `ModelTurnLimitError`。

## 工具阶段

并发由 `mapWithConcurrency(toolCalls, maxConcurrentTools ?? 2, …, { shouldDrain })` 控制：**只有 `ToolDeniedError` 会中断继续认领新槽位**（drain），其他失败让已入队的项跑完。单工具顺序：

1. **纯派发准入**：`beforeToolDispatch(call, { modelTurn, toolCallIndex, responseToolCallCount })`；返回 `reject` → `markNotDispatched(reasonCode)`，并把 `message` 作为 `is_error` 工具结果交给模型（**不抛错、不终止回合**）。
2. **进入执行前的审批候选槽**：`isApprovalCandidate?.(call) ?? ['write_file', 'edit_file', 'run_shell', 'run_script', 'browser', 'browser_action'].includes(toolName)` 为真时申请 `candidateSlots.acquire(invocationId, signal)`（`ApprovalCandidateSlots(2, max(toolCalls.length, 1))`，按工具轮新建）；候选槽等待不会释放父 turn 的应用级准入名额。
3. **初始准备**：`prepareTool(call, { kind: 'initial' })`——宿主抛 `ToolDeniedError`（如注册表查不到工具）时先 `markNotDispatched(reasonCode, userMessage)` 再原样上抛，避免 invocation 终态校验挂起 → `onToolStarted` 投影 → 校验绑定为 `initial-compat` 且 `invocationId` / `toolCallId` / `capabilityId` 一致，否则 `markNotDispatched('PREPARED_CALL_MISMATCH')` 并抛 `ToolDeniedError`。
4. **策略评估**：`safetyGate.evaluate` — `deny` → `markNotDispatched(reasonCode)` + `ToolDeniedError(reasonCode, userMessage)`（`FACTS_CHANGED` 等区分文案可直接回模型）；`ask` → 确认流程（审批槽 `Semaphore(2)` 按工具轮新建）：
   - 未注入 `confirmation` 端口 → `markNotDispatched('CONFIRMATION_REQUIRED')` + `ToolDeniedError`；
   - **审批槽**：`approvalSlots.acquire(signal)` 获取失败 → `markNotDispatched(signal 已 abort ? 'REQUEST_CANCELLED' : 'CONFIRMATION_CAPACITY_UNAVAILABLE')` 并上抛；等待期间父 turn 继续持有应用级准入名额；
   - 追加 `approval-waiting`（含 `toolCallId` / `approvalId` / `answerer` / `reasonCode` / `requestedAt`）；若此刻 signal 已 abort，补写 `approval-resolved`（`approved: false`，`outcome` / `cause` 取 `timeout` 或 `cancelled`）后 `markNotDispatched` 并抛请求生命周期错误；
   - 调 `confirmation({ call, modelTurn, confirmationId, answerer, reasonCode, context?, signal? })`；抛错 → 补写 `approval-resolved(outcome: 'unavailable')` 后原样抛出；`finally` 释放审批槽；
   - 追加 `approval-resolved`（`approved = kind === 'approved' && receipt 非空`、`outcome`、可选 `answerer` / `cause` / `settledAt`）；
   - signal abort 复检（确认前后各一次）→ `markNotDispatched('REQUEST_TIMEOUT' | 'REQUEST_CANCELLED')`；
   - 未获批 → `markNotDispatched('CONFIRMATION_<KIND>')` + `ToolDeniedError(reason, userMessage)`，`receipt` 为空也视为未获批。
5. **资源锁 → 终检 → 授权**：先 `resourceLocks.acquire(toolResourceKeys?.(call) ?? ['unknown:<invocationId>'])`，再 `prepareTool(call, { kind: 'recheck', confirmation? })`（失败按 `^[A-Z0-9_]{1,64}$` 判定 reasonCode，否则 `PREPARED_RECHECK_FAILED`），`matchesRecheckBinding` 不匹配 → `STALE_AUTHORIZATION`，然后 `safetyGate.authorize`；非 `allow` → `markNotDispatched(reasonCode 或 'RECHECK_REQUIRES_CONFIRMATION')`；取消竞态下已签发 permit 用 `discardPermit` 回收。
6. **执行**：`toolExecution.execute(call, permitId, onDispatchClaimed)`；`onDispatchClaimed` 内追加 `tool-call-started`（含 `inputHash`、`decisionRuleId`）并把派发状态记为 `started`。执行端口在 `onDispatchClaimed` 返回后、进入执行器之前还有**一次 abort 复检**（[safety-approval.md](./safety-approval.md) 第 5 节）：此刻若已取消 / 撤权 / 授权变更则抛 `ToolExecutionRejectedError`。循环收到该错误时把 `tool-call-started` 提案**回退为未派发**（派发状态回到 `pending`，随后补写 `tool-call-not-dispatched`），再按原因转成 `AgentTurnCancelledError` / `AgentTurnTimedOutError` 或 `ToolDeniedError(reason)`；`ToolExecutionAfterDispatchError` 原样上抛。
7. **结果提交**：追加 `tool-call-finished`（`success` / `result` / `replayContent` / `isError` / 可选 `auditRef` / 可选 `sessionLedger`）→ 派发状态置 `finished`；返回给模型的 canonical 工具消息以**已提交**的 history payload 为准（`replayContent` 优先）→ `onToolFinished` 与 `afterToolResult(..., { kind: 'execution', modelTurn })`（后者失败只走 `onObservationError`，stage `tool-finished`）。

**聚合与收尾**（并发返回之后）：

- **空洞物化**：fatal 中止留下的未认领槽位逐个 `markNotDispatched(signal 已 abort ? 'REQUEST_CANCELLED' : 'TURN_STOPPED_BEFORE_DISPATCH')`，计数经 `onUndispatchedToolsMaterialized` 留痕；若某槽位既未认领又非 `pending`，抛内部错误（防止派发空洞被静默吞掉）。
- **诊断**：致命拒绝（非 `ToolDeniedError`）先发 `onDispatchStoppedWithPending`（`reason` 取 `AgentTurnHistoryAppendError.kinds` 拼接或错误 name）与 `onToolDispatchFailureContext`，再进入失败结算。
- **回灌被拒工具**：`returnDeniedToolsToModel = true` 时不会终止回合，而是生成 `role: 'tool'` 的拒绝结果（内容取 `ToolDeniedError.userMessage`，缺省 `Tool call was not dispatched (<reasonCode>).`）回灌模型，并 `afterToolResult(..., { kind: 'safety-rejection', reasonCode })`。
- **上抛选择**：其余拒绝按优先级取一个上抛——`ToolExecutionAfterDispatchError` > `AgentTurnHistoryAppendError`（`kinds` 含 `tool-call-finished`）> 请求生命周期错误（取消 / 超时）> 第一个拒绝；上抛前把仍 pending 的工具补 `markNotDispatched`。
- 回灌给模型的工具结果顺序**按 provider 的 tool-call 顺序**排列，与派发完成顺序无关。

`markNotDispatched` 使用的原因码覆盖：纯准入拒绝（宿主 `beforeToolDispatch` 返回的 reasonCode）、准备 / 授权类（`PREPARED_CALL_MISMATCH`、`PREPARED_RECHECK_FAILED`、`STALE_AUTHORIZATION`、`RECHECK_REQUIRES_CONFIRMATION`）、策略与确认类（策略 `reasonCode`、`CONFIRMATION_REQUIRED`、`CONFIRMATION_<KIND>`、`CONFIRMATION_CAPACITY_UNAVAILABLE`）、请求生命周期类（`REQUEST_TIMEOUT`、`REQUEST_CANCELLED`、`TURN_FAILED_BEFORE_TOOL_DISPATCH`、`TURN_STOPPED_BEFORE_DISPATCH`）、输出上限（`MODEL_OUTPUT_TRUNCATED`）、额度（`tool_loop_max_rounds_exceeded`）、宿主投影失败（`HOST_PROJECTION_FAILED`）与执行端口拒绝原因（`ToolExecutionRejectReason`）。

`markNotDispatched` 的副作用顺序固定为：写 `tool-call-not-dispatched` → `discardPreparedTool?.(call, reason)`（失败只走 `onObservationError`，stage `prepared-tool-discard`）→ 若追加失败则把原始错误上抛（派发状态已置为 `not-dispatched`，不重复写）。

## 失败结算

回合失败时按错误类型决定终态与 `invocation-*` 终态事件：

| 判定 | status | 终态事件 |
| --- | --- | --- |
| `AgentTurnCancelledError` | `cancelled` | `invocation-interrupted` |
| `AgentTurnTimedOutError` | `failed` | `invocation-failed`（`reason: 'timeout'`） |
| 结果持久化不确定（含 `AgentTurnHistoryAppendError` 且 `kinds` 含 `tool-call-finished`） / `ToolExecutionAfterDispatchError` / 宿主投影失败 / 工具投影失败 / **上下文替换的提交不确定**（`commit-uncertain`） | `interrupted` | `invocation-interrupted` |
| `ToolDeniedError` | `denied` | `invocation-failed` |
| 其他 | `failed` | `invocation-failed` |

- 结算前先读一次 history：已有终态事件（`invocation-completed` / `invocation-failed`）则跳过补写与终态追加；否则对"仍 pending 且未 started"的工具补写 `tool-call-not-dispatched`（reason `TURN_FAILED_BEFORE_TOOL_DISPATCH`），补写失败即标记为"结果持久化不确定"（归入 `interrupted`）。
- 「先抛出的错误」判定中，`AgentTurnCancelledError` 与 `AgentTurnTimedOutError` 等价看待（都是请求生命周期错误，优先于其它拒绝码）。
- 终态事件 payload 会带上 `status`、`reason`（如 `timeout`、`host-projection-failed`、`tool-projection-failed`、`turn-boundary-ledger-projection-failed`、`unknown-after-dispatch`、拒绝码），`TOOL_LOOP_MAX_ROUNDS_EXCEEDED` / `SHELL_DIALECT_MISMATCH` 额外带 `errorCode`，并附 `lastValidUsage`（本回合最后一次被接受的用量）。
- **会话 transcript 镜像**（同时给了 `sessionId` 与 `sessionTranscriptBaseVersion` 时）：终态追加携带 `transcriptCommit`。失败路径的消息视图优先从 history 的最后一次 `transcript-compacted` 反推（能定位到必需 user 消息时取其前缀），否则退回 `sessionTranscriptFailureMessages`；`outcome` 映射为 `cancelled` / `timed_out` / `interrupted` / `failed`；有 `assistantMessageId` 时附 `messageMirror`（`cancelled` 或 `failed`，`content` 取该 assistant 消息的文本投影）。
- `appendTerminalHistory` 的行为：带 `transcriptCommit` 追加失败时会**降级重试一次"不带 transcriptCommit"**（先保住终态事实，让宿主能对会话做栅栏 / 对账）；无 `transcriptCommit`、或重试后仍失败时，读回 history 确认终态是否已等价落库——等价则吞掉错误，否则上抛并转 `onObservationError(error, 'history-terminal')`。
- 若 history 已是终态（`AgentTurnHistoryAlreadyTerminalError`），不再重复写终态。
- 最后触发 `onTurnFailed({ error, status })` 并向上抛原错误。

## 错误类型

**已导出**（装配方可 `instanceof` 判定）：

| 类 | code | 备注 |
| --- | --- | --- |
| `ToolDeniedError` | `TOOL_DENIED` | 含 `reasonCode`、可选 `userMessage` |
| `ModelTurnLimitError` | `MODEL_TURN_LIMIT` | |
| `ModelPreflightRejectedError` | `MODEL_PREFLIGHT_REJECTED` | `reasonCode` 目前仅 `OVER_BUDGET` |
| `ToolLoopRoundLimitError` | `TOOL_LOOP_MAX_ROUNDS_EXCEEDED` | |
| `ModelOutputTokenLimitError` | `MODEL_OUTPUT_TOKEN_LIMIT_EXHAUSTED` | 输出上限恢复已耗尽 |
| `AgentTurnCancelledError` | `TURN_CANCELLED` | |
| `AgentTurnTimedOutError` | `TURN_TIMED_OUT` | |
| `InvalidTurnBoundaryError` | `INVALID_TURN_BOUNDARY` | 边界投影破坏必需消息 / 待派发提案 |
| `ModelAttemptRecoveryRejectedError` | `MODEL_ATTEMPT_RECOVERY_REJECTED` | `reasonCode` 如 `RETRY_LIMIT_EXCEEDED` |

**未导出**（turn 内部信号，装配方只能按 `error.name` 判定；均继承 `Error`）：

| 类（name） | code | 语义 |
| --- | --- | --- |
| `AgentTurnHistoryAppendError` | — | history 追加失败；携带 `kinds`（失败批次的事件 kind 列表）与 `originalError`。`kinds` 含 `tool-call-finished` 时回合按"结果持久化不确定"结算 |
| `AgentTurnHostProjectionError` | — | 宿主响应投影提交失败（critical 回调抛错），回合结算 `interrupted` |
| `AgentTurnToolProjectionError` | — | 工具投影提交失败，同上 |
| `AgentTurnBoundaryProjectionError` | — | 上下文替换的投影 / 提交失败（preflight、turn boundary、provider 恢复三处共用），同上 |
| `AgentTurnHistoryAlreadyTerminalError` | — | 追加终态事件时 history 已是终态，不再重复写 |

超时与取消的区分靠 `AbortSignal.reason === AGENT_TURN_TIMEOUT_ABORT_REASON`（`'agent-turn-timeout'`）。

另有非错误码的明文标识 `model_output_token_limit`：输出上限恢复时用作未派发工具的结果错误值，并写入 `provider-retry-scheduled` 事件的 `code` / `sessionLedger.requestRetry.code`。

## 其他导出

```ts
type ConfirmationPort = (input: {
  call: CanonicalToolExecutionCall
  modelTurn: number                 // 当前回合内的模型响应批次（批级确认决策用）
  confirmationId: string
  answerer: 'user' | 'agent'
  reasonCode: string
  context?: unknown
  signal?: AbortSignal
}) => Promise<ToolConfirmationResult>

type ToolConfirmationResult = Readonly<{ answerer?: 'user' | 'agent'; cause?: string; userMessage?: string; selectedMemory?: unknown }>
  & (Readonly<{ kind: 'approved'; receipt: string }>
    | Readonly<{ kind: 'denied' | 'timeout' | 'unavailable' | 'cancelled' }>)

type HostCommittedModelResponse = Readonly<{
  message: CanonicalTurnMessage
  finishReason: Extract<StreamChunk, { type: 'finish' }>['reason']
  usage: Extract<StreamChunk, { type: 'usage' }>
  historyCommitted: true
  hostProjectionCommitted?: true
}>

type CanonicalTurnMessage = CanonicalModelMessage
// 另导出 CanonicalContentBlock / CanonicalToolCall 类型再导出
```

`initialResponse`（`HostCommittedModelResponse`）用于宿主已自行流式提交首响应的场景：要求 history 最新事件为完全匹配的 `model-response-committed`，SDK 不会重复写事件、也不重放已提交副作用；`hostProjectionCommitted` 时 observer 会带 `alreadyProjected: true`。该路径下若 `finishReason === 'cancelled'`，只做 `throwIfAborted` 后抛超时 / 取消错误，**不走**第 6 步的取消结算（首响应已由宿主提交，SDK 不补写 `model-attempt-discarded`）。

另有几项导出需要装配方知情：

```ts
const AGENT_TURN_TIMEOUT_ABORT_REASON = 'agent-turn-timeout' as const   // 超时信号 reason，用于与普通取消区分

/** @internal 框架投影函数：把 canonical 消息数组重建为 ContextFrame（仅契约回归测试使用，不从包入口导出）。 */
function contextFrameFromMessages(messages, windowId, requiredUserMessage?, pendingTools?, base?, checkpoint?): ContextFrame

type ContextReplacementPlanInput / ContextReplacementPlanResult          // 见上文「恢复与边界」
```
