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
  requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>
  routeId: string
  request: PreparedModelCall['request']
  initialResponse?: HostCommittedModelResponse
  observer?: AgentTurnObserver
}): Promise<AgentTurnResult>

// 直接入口：端口已备好
async function runAgentTurn(input: RunAgentTurnInput): Promise<AgentTurnResult>

type AgentTurnHost = Readonly<{
  createPorts(invocation: {
    invocationId: string; turnId?: string; windowId?: string
    currentUserMessageId?: string
    requiredUserMessage?: Readonly<{ id: string; message: CanonicalModelMessage }>
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

`RunAgentTurnInput` 与 `AgentTurnPorts` 形状相同，多出 `sessionId`；其中必需项：`registry`、`routeId`、`request`、`safetyGate`、`prepareTool`、`toolExecution`、`invocationId`、`maxModelTurns`。

## 端口（AgentTurnPorts）

**模型 / 请求**
`registry: ModelProviderRegistry`、`routeId`、`request: Omit<PreparedModelCall['request'], 'messages'>`。

**工具准备与执行**

```ts
prepareTool(call: CanonicalToolExecutionCall, stage: ToolPreparationStage): Promise<PermitBinding>
discardPreparedTool?(call, reason: string): void | Promise<void>
toolExecution: PermitBoundToolExecutionPort<CanonicalToolExecutionCall, CanonicalToolExecutionResult>  // 仅 SDK 的 permit-bound 工厂可产出
toolResourceKeys?(call): readonly string[] | undefined    // undefined 视为未知副作用
isApprovalCandidate?(call): boolean
maxConcurrentTools?: number
resourceLocks?: { acquire(keys, options?): Promise<{ release(): void }> }
confirmation?: ConfirmationPort
```

`ToolPreparationStage` 两阶段：`{ kind: 'initial' }` 与 `{ kind: 'recheck'; confirmation?: { receipt: string } }`。`confirmation` 缺省不会兜底，`ask` 决策下必须由宿主提供。

**持久化与投影**

`history?: HistoryPort`、`sessionLedgerForToolResult?` / `sessionLedgerForNotDispatched?` / `sessionLedgerForModelResponse?` / `sessionLedgerForAttemptUsage?` / `sessionLedgerForInvocationTerminal?` 系列的 `sessionLedger*` 钩子、`recordProviderAttemptUsage?`、`afterToolResult?(call, result, source?)`。

**恢复与边界**

`recoverProviderAttempt?`（一次 provider 失败恢复，可返回 retry / reject）、`recoverOutputLimit?`（`length` 截断后的受限续写）、`preflightModelRequest?`（派发前预算预检与压缩）、`turnBoundary?`（已接受响应之后、工具或下一轮之前的规划 / 压缩）。

**取消与额度**

`request.signal`、`deadlineAt`、`applicationAdmission?`（park / resume 宿主应用运行槽）、`maxModelTurns`（必填正整数）、`maxToolRounds?`、`returnDeniedToolsToModel?`。

## Observer 与 critical 开关

```ts
type AgentTurnObserver = Readonly<{
  criticalModelResponseProjection?: boolean
  criticalModelRequestProjection?: boolean
  criticalModelAttemptUsageProjection?: boolean
  criticalToolProjection?: boolean
  onModelRequest? / prepareModelRequest? / onProviderRetry? / prepareProviderRetry?
  onModelAttemptDiscarded? / prepareModelResponseProjection? / onOutputRecovery? / onModelChunk?
  onModelResponseCommitted? / onToolStarted? / onToolFinished?
  onTurnOutputReady? / onTurnFinished? / onTurnFailed?
  onObservationError?(error: unknown, stage: string): void | Promise<void>   // stage 为下方字面量联合
}>
```

- `critical*` 为真时对应回调是**必需提交步骤**：缺失回调在循环开始即抛错；回调失败会转成 `AgentTurnHostProjectionError` / `AgentTurnToolProjectionError`，并让回合以 `interrupted` 结算（工具阶段还会把未派发工具标记 `tool-call-not-dispatched`）。
- 非 critical 时回调失败只走 `onObservationError` 诊断，不影响执行结论。
- `stage` 取值：`model-request`、`model-chunk`、`model-attempt-discarded`、`model-response-committed`、`model-attempt-usage`、`tool-started`、`tool-finished`、`turn-output-ready`、`turn-finished`、`turn-failed`、`history-terminal`、`prepared-tool-discard`。

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

1. **回合前检查**：`throwIfAborted`；`registry.prepare`；`ensureInitialHistoryContext`（无历史或首事件不合规即拒绝；有 `invocation-context-committed` / `transcript-compacted` 时校验请求快照兼容性）。
2. **请求投影与预检**：`observer.prepareModelRequest` → `preflightModelRequest`（可返回替换后的 messages，此时追加 `transcript-compacted` 并重算请求；超预算抛 `ModelPreflightRejectedError('OVER_BUDGET')`）。
3. **路由冻结**：`registry.getProvider`；首轮固化 `pinnedRoute` / `pinnedProvider`，后续不匹配抛 `ModelRouteChangedError`。
4. **provider 尝试**：追加 `model-request-started` → 流式收集（`collectModelAttempt`）；失败或输出内容可疑时走 `recoverProviderAttempt`（至多一次重试，超限抛 `ModelAttemptRecoveryRejectedError('RETRY_LIMIT_EXCEEDED')`）；`finish.reason === 'cancelled'` → `AgentTurnCancelledError`。
5. **响应归约与提交**：拼装 assistant canonical 消息（thinking / text 合并、`thinking-signature` 回填）→ `recordProviderAttemptUsage` → `prepareModelResponseProjection` → 追加 `model-response-committed` → `onModelResponseCommitted`。
6. **输出上限恢复**：`finish.reason === 'length'` 时对每个工具调用追加 `tool-call-not-dispatched`（`MODEL_OUTPUT_TRUNCATED`），可选 `provider-retry-scheduled` 与 `replay-message-committed`，然后 `continue`；没有续写消息则抛 `ModelOutputTokenLimitError`。
7. **turn boundary**：`turnBoundary` 返回 `messages` 时校验"待派发提案与必需 user 消息不得被破坏"，追加 `transcript-compacted`，再执行 `commitProjection`（失败抛 `AgentTurnBoundaryProjectionError`）。
8. **无工具调用即结束**：返回 `AgentTurnResult`。
9. **工具阶段**（见下），完成后 `dispatchedToolRounds += 1` 进入下一轮。

循环末尾兜底抛 `ModelTurnLimitError`。

## 工具阶段

并发由 `mapWithConcurrency(toolCalls, maxConcurrentTools ?? 2)` 控制，单工具顺序：

1. **应用准入**：`TurnApplicationAdmission.activate`；审批候选工具先占审批候选槽（`ApprovalCandidateSlots`，基于 `CapacityLedger`，审批与恢复队列的等待会 park）。
2. **初始准备**：`prepareTool(call, { kind: 'initial' })`；校验绑定为 `initial-compat` 且 `invocationId` / `toolCallId` / `capabilityId` 一致，否则 `markNotDispatched('PREPARED_CALL_MISMATCH')` 并抛 `ToolDeniedError`。
3. **策略评估**：`safetyGate.evaluate` — `deny` → `markNotDispatched(reasonCode)` + `ToolDeniedError`；`ask` → 走确认流程（审批槽 `Semaphore(2)`）：
   - 追加 `approval-waiting`；
   - 调 `confirmation(...)`；
   - 追加 `approval-resolved`（含 `outcome` / `answerer` / `cause` / `settledAt`）；
   - 未获批 → `markNotDispatched('CONFIRMATION_<KIND>')` + `ToolDeniedError`，`receipt` 为空也视为未获批。
4. **资源锁 → 终检 → 授权**：先 `resourceLocks.acquire(resourceKeys ?? ['unknown:<invocationId>'])`，再 `prepareTool(call, { kind: 'recheck', confirmation? })`（失败按 `^[A-Z0-9_]{1,64}$` 判定 reasonCode，否则 `PREPARED_RECHECK_FAILED`），`matchesRecheckBinding` 不匹配 → `STALE_AUTHORIZATION`，然后 `safetyGate.authorize`；取消竞态下已签发 permit 用 `discardPermit` 回收。
5. **执行**：`toolExecution.execute(call, permitId, onDispatchClaimed)`；`onDispatchClaimed` 内追加 `tool-call-started`（含 `inputHash`、`decisionRuleId`）。`ToolExecutionRejectedError` 会被转成 `ToolDeniedError` / 取消错误。
6. **结果提交**：追加 `tool-call-finished`，随后 `onToolFinished` 与 `afterToolResult`；返回的 canonical 结果以**已提交**的 history payload 为准。

`returnDeniedToolsToModel = true` 时，被拒工具不会终止回合，而是生成 `role: 'tool'` 的拒绝结果回灌给模型，并 `afterToolResult(..., { kind: 'safety-rejection', reasonCode })`。

## 失败结算

回合失败时按错误类型决定终态与 `invocation-*` 终态事件：

| 判定 | status | 终态事件 |
| --- | --- | --- |
| `AgentTurnCancelledError` | `cancelled` | `invocation-interrupted` |
| 结果持久化不确定 / `ToolExecutionAfterDispatchError` / 宿主投影失败 / 工具投影失败 / 边界投影失败 | `interrupted` | `invocation-interrupted` |
| `ToolDeniedError` | `denied` | `invocation-failed` |
| 其他 | `failed` | `invocation-failed` |

- 失败前会把 history 中仍 pending 且未 started 的工具补写 `tool-call-not-dispatched`（reason `TURN_FAILED_BEFORE_TOOL_DISPATCH`）；若补写失败则标记为"结果持久化不确定"。
- 终态事件 payload 会带上 `status`、`reason`（如 `timeout`、`host-projection-failed`、`tool-projection-failed`、`turn-boundary-ledger-projection-failed`、`unknown-after-dispatch`、拒绝码）与 `lastValidUsage`。
- 若 history 已是终态（`AgentTurnHistoryAlreadyTerminalError`），不再重复写终态；`appendTerminalHistory` 在追加失败时会读回确认是否已等价落库。
- 最后触发 `onTurnFailed({ error, status })` 并向上抛原错误。

## 错误类型

| 类 | code |
| --- | --- |
| `ToolDeniedError` | `TOOL_DENIED`（含 `reasonCode`、可选 `userMessage`） |
| `ModelTurnLimitError` | `MODEL_TURN_LIMIT` |
| `ModelPreflightRejectedError` | `MODEL_PREFLIGHT_REJECTED` |
| `ToolLoopRoundLimitError` | `TOOL_LOOP_MAX_ROUNDS_EXCEEDED` |
| `ModelOutputTokenLimitError` | `MODEL_OUTPUT_TOKEN_LIMIT_EXHAUSTED` |
| `AgentTurnCancelledError` | `TURN_CANCELLED` |
| `AgentTurnTimedOutError` | `TURN_TIMED_OUT` |
| `InvalidTurnBoundaryError` | `INVALID_TURN_BOUNDARY` |
| `ModelAttemptRecoveryRejectedError` | `MODEL_ATTEMPT_RECOVERY_REJECTED` |

超时与取消的区分靠 `AbortSignal.reason === AGENT_TURN_TIMEOUT_ABORT_REASON`（`'agent-turn-timeout'`）。

## 其他导出

```ts
type ConfirmationPort = (input: {
  call: CanonicalToolExecutionCall
  confirmationId: string
  answerer: 'user' | 'agent'
  reasonCode: string
  context?: unknown
  signal?: AbortSignal
}) => Promise<ToolConfirmationResult>

type ToolConfirmationResult = Readonly<{ answerer?: 'user' | 'agent'; cause?: string; userMessage?: string }>
  & (Readonly<{ kind: 'approved'; receipt: string }>
    | Readonly<{ kind: 'denied' | 'timeout' | 'unavailable' | 'cancelled' }>)

type HostCommittedModelResponse = Readonly<{
  message: CanonicalTurnMessage
  finishReason: Extract<StreamChunk, { type: 'finish' }>['reason']
  usage: Extract<StreamChunk, { type: 'usage' }>
  historyCommitted: true
  hostProjectionCommitted?: true
}>

type ApplicationAdmissionPort = Readonly<{
  park(checkpoint?: unknown): unknown
  discard?(handle: unknown): void
  resume(handle: unknown, options?: { signal?: AbortSignal; deadlineAt?: number }):
    boolean | { ok: true } | { ok: false; retryable: boolean; cause?: string } | Promise<...>
}>

type CanonicalTurnMessage = CanonicalModelMessage
// 另导出 CanonicalContentBlock / CanonicalToolCall 类型再导出
```

`initialResponse`（`HostCommittedModelResponse`）用于宿主已自行流式提交首响应的场景：要求 history 最新事件为完全匹配的 `model-response-committed`，SDK 不会重复写事件、也不重放已提交副作用；`hostProjectionCommitted` 时 observer 会带 `alreadyProjected: true`。
