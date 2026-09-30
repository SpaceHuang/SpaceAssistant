# 调用契约与宿主端口（invocation.ts）

对应源码：`packages/agent-sdk/src/invocation.ts`。

这是宿主（electron 主进程）装配 Agent 时的**主契约面**：入参只放可序列化数据与消息，宿主能力一律通过接口注入。electron 专属类型（消息块结构、`SessionEventInput`、`RemoteContext`、`WorkDirManager`、`AppDatabase`、`ContextMeter` 等）在此以 `unknown` / `any` 占位，由宿主的装配器与展开层收窄——类型断言只应集中在这两处，不进循环体。

## 1. 调用入参 AgentInvocation

```ts
interface AgentInvocation {
  session: AgentSessionAnchor                      // { sessionId: string }
  messages: AgentMessagesSection
  profile: AgentInvocationProfile
  events: AgentEventSink
  limits: AgentInvocationLimits
  signal?: { aborted: boolean }
  clientId?: string
  additionalContext: Readonly<Record<string, unknown>>
  trace: AgentTraceContext
  safety: AgentInvocationSafety
  driverContext?: AgentDriverContext
}
```

**trace**（请求追踪，`requestId` / `turnId` / `windowId` 归此）：

```ts
interface AgentTraceContext { requestId: string; turnId?: string; windowId?: string }
```

`turnId` 缺省回退 `sessionId` 占位；`windowId` 为宿主 UI 簿记。

**messages**（只传本次新增输入，历史经 `loadContext` 装载，不经此传入）：

```ts
type AgentMessageLike = { role: 'user' | 'assistant'; content: unknown; id?: string }
interface AgentMessagesSection {
  list: readonly AgentMessageLike[]
  currentUserMessageId?: string
  assistantMessageId?: string
  hasImageAttachments?: boolean
}
```

**profile**（模型档，解析结果冻结快照）：

```ts
interface AgentInvocationProfile {
  model: string
  providerRouteId?: string        // 宿主按 protocol/dialect/endpoint 解析出的不可变 route identity
  llmServiceId?: string           // 冻结执行配置里的 LLM 服务 ID（同模型跨服务分开统计）
  contextWindow?: number
  contextWindowTrusted?: boolean
  system?: string
  options?: { maxTokens?: number; enableThinking?: boolean }
  locale?: string
  projectMemoryEnabled?: boolean
  skillFragments?: string[]
  tools: {
    toolsConfig: ToolsConfig
    browserConfig?: BrowserConfig
    shellConfig?: ShellConfig | null
    wikiConfig?: WikiConfig
    feishuConfig?: FeishuConfig
    wechatConfig?: WeChatConfig
    larkCliRunner?: unknown
    trim?: { allow?: readonly string[]; deny?: readonly string[] }   // 按调用裁剪工具集（不落提示词）
  }
  lane?: ExecutionLane            // 'desktop' | 'wechat' | 'feishu' | 'automation'
  reasoning?: AgentReasoningProfile
}

type AgentReasoningEffort = 'off' | 'low' | 'medium' | 'high'   // off 为零成本档（子调用默认）
interface AgentReasoningProfile {
  effort: AgentReasoningEffort
  degraded?: { from: AgentReasoningEffort; to: AgentReasoningEffort }   // fail-loud，不静默换档
}
```

**events**（分组事件出口，允许全 no-op）：

```ts
interface AgentEventSink {
  onFact(event: AssistantFactEvent): void
  onSessionEvent(event: unknown): void | Promise<void>
  onFileTreeChanged?(event: FileTreeChangeEvent): void
  onTitleGenerated?(session: Session): void
  notify?(event: AgentNotifyEvent): void
}

type AgentNotifyEvent =
  | { kind: 'confirm-request'; requestId: string; sessionId: string; sessionName: string; toolUseId: string; toolName: string; input: unknown }
  | { kind: 'tool-result'; requestId: string; toolUseId: string }
  | { kind: 'request-all-cancelled'; requestId: string }
```

`onFact` / `onSessionEvent` 为必填语义（无观察者时传 no-op）；其余可选，未传即 no-op。

**limits / safety / 附加材料**：

```ts
interface AgentInvocationLimits { maxToolRounds?: number; deadlineAt?: number }
interface AgentInvocationSafety { recursionGuard?: 'approval-agent' }   // 仅审批执行链传入，取值写死不可配置

const AGENT_ADDITIONAL_CONTEXT_KEYS = {
  approvalTaskDigest: 'approval.taskDigest',
  historyFacts: 'facts.history'
} as const
```

## 2. 调用结果

```ts
type AgentInvocationResult =
  | { ok: true; content: unknown[]; stopReason: string; usage?: unknown; finalSurfaceSnapshot?: unknown; finalSurfaceMessages?: unknown[] }
  | { ok: false; error: string; usage?: unknown; cancelled?: boolean }
```

## 3. 宿主端口 AgentHostPorts

按职责分组（除 `workspace`、`credentials` 外全部可选）：

**必需**

```ts
workspace: AgentWorkspacePorts
credentials: AgentCredentialsPorts
```

**工作区（workspace）**

```ts
interface AgentWorkspacePorts {
  workDir: string
  snapshot(): unknown            // 装配期解析的快照（单一事实源）
  refresh(): unknown             // 调用边界刷新；绑定未变返回原对象（revision 不变）
  workDirManager?: unknown       // electron 侧为 WorkDirManager
  resolveWorkDir?(): string
  userDataDir: string
}
```

`workDir` 是 `snapshot()` 的 `rootPath` 投影（过渡保留）。

**凭据（credentials）**

```ts
interface AgentCredentialsPorts {
  resolveApiKey(): Promise<string | null>
  networkTarget?: { baseUrl?: string }   // 网络目标留在宿主绑定，不进可序列化契约
}
```

**存储（storage）与真相类持久化**

```ts
interface AgentLoadedSessionContext { metadata?: unknown }

interface AgentPersistPorts {
  updateSessionMetadata?(sessionId: string, patch: Record<string, unknown>): void
  scheduleTitleSuggestion?(input: Record<string, unknown>): void
  recordUserAnswerFromDecision?(input: Record<string, unknown>): void
}

interface AgentStoragePorts {
  loaded?: AgentLoadedSessionContext
  sessionEventLocation?: { workDir: string; sessionId: string; createdAt: number }   // 重启后对账压缩提交
  readSession?(sessionId: string): unknown
  persist?: AgentPersistPorts
  appendCompactionTransaction?(start: Record<string, unknown>, summary: Record<string, unknown>): Promise<unknown>
}
```

真相类端口失败 = 调用显式失败 + 可区分错误码 + 审计，不允许静默 no-op。

**门控与暴露面（policy / exposure）**

```ts
interface AgentPolicyPorts {
  effectiveRules: readonly PolicyRule[]
  authorizationVersion?: string
  resolveCurrentAuthorization?(): {
    effectiveRules: readonly PolicyRule[]
    lanePackage: string
    policyOrigins: Record<string, { source: 'builtin' | 'package' | 'user-override' | 'migration' }>
    authorizationVersion: string
  }
  decisionCache: unknown
  shellPrecheck: { touchTrustedCommand(command: string): void }
  policyOrigins?: Record<string, { source: 'builtin' | 'package' | 'user-override' | 'migration' }>
}

interface AgentExposurePorts { rules?: readonly PolicyRule[] }
```

门控缺料 = 调用失败 + 审计（fail-loud）；无库宿主必须显式提供默认材料并留痕。

**MCP / 工具撤权 / 诊断 / 回答者 / 用量**

```ts
interface AgentMcpPorts {
  snapshot: unknown
  resolveExecutor?(toolName: string, manager: unknown): unknown
  executorDatabase?: unknown
}

interface AgentToolRevocationPort {
  getRegisteredTool(name: string): unknown
  onRevocation(listener: AgentToolRevocationListener): AgentToolRevocationUnsubscribe
  isToolRevoked(requestId: string, toolName: string, executionId?: string): boolean
}
type AgentToolRevocationListener = (event: { requestId: string; executionId: string; lane: string; toolName: string }) => void
type AgentToolRevocationUnsubscribe = () => void

interface AgentUsagePorts { recordStepUsage?(input: Record<string, unknown>): void; recordTurnSummary?(input: Record<string, unknown>): void }
interface AgentDiagnosticsPorts { append(serverId: string, entry: unknown): void }
interface AgentAnswererPorts { approvalDatabase?: unknown }
```

用量与诊断属观察类：失败降级重试、不改执行结论，但不得静默。

**准入与运行租约（扁平字段）**

```ts
toolExecutionConcurrency?: number
resourceLocks?: { acquire(keys: readonly string[], options?: { signal?: AbortSignal }): Promise<{ release(): void }> }

applicationAdmission?: {
  park(checkpoint?: unknown): unknown
  discard?(handle: unknown): void
  resume(handle: unknown, options?: { signal?: AbortSignal; deadlineAt?: number }): ApplicationAdmissionResumeResult | Promise<ApplicationAdmissionResumeResult>
}
type ApplicationAdmissionResumeResult = { ok: true } | { ok: false; retryable: boolean; cause?: string }

invocationRuntime?: {
  acquireLease(invocationId: string): { runtimeId: string; invocationId: string; generation: number; release(): void }
  park(invocationId: string, lease: {...}, checkpoint?: unknown): { runtimeId: string; invocationId: string; generation: number; checkpoint: unknown } | undefined
  resumeLease(handle: {...}): { runtimeId: string; invocationId: string; generation: number; release(): void } | undefined
}

approvalAdmission?: {
  acquire(request: { requestId: string; parentTaskId: string; deadlineAt?: number }): Promise<
    { kind: 'granted'; release(): void } | { kind: 'rejected'; cause: string }>
  cancel(requestId: string): boolean
}

toolRevocations?: AgentToolRevocationPort
executionAdmission?: unknown        // Runtime 级 cancel/revoke 与 dispatch claim 线性化组件
safetyPermits?: unknown             // Runtime 级 permit ledger，按 permit ID settle
```

**历史与模型生命周期钩子**

```ts
history?: {
  appendBatch(events: readonly <HistoryEvent 同形结构>[], expectedVersion: number): Promise<{ version: number; duplicate: boolean }>
  read(invocationId: string): Promise<{ invocationId: string; version: number; schemaVersion: number; events: Array<...> }>
}
recordProviderAttemptUsage?(input: Record<string, unknown>): void
turnBoundary?(input: unknown): Promise<unknown>          // 成功响应后、下一轮发送前的边界规划
preflightModelRequest?(input: unknown): Promise<unknown> // 各次 dispatch 前按冻结预算恢复 transcript
recoverProviderAttempt?(input: unknown): Promise<unknown>// 响应未被接受时由宿主决定是否恢复并安全重试一次
hostFacts?: { getBrowserDetectContext?(): BrowserDetectContext }
translate?(message: LocalizedMessage): string             // 主进程只产「键 + 参数」，显示处经此解析
contextMeter?: unknown
```

`history` 目前用于逐 lane 真源切换前的**可重放事件影子写入**；其事件 kind 与形状须与 `src/history.ts` 的 `HistoryEvent` 同形。

**过渡豁免（已标记废弃）**

```ts
/** @deprecated P2 删除 */
legacy?: { appDb?: unknown }
```

`appDb` 原样透传给循环体内既有取用路径，是"端口一律接口"唯一声明的过渡豁免期。

## 4. 装配注意

- 所有以 `unknown` 声明的字段都是 electron 专属类型的占位，收窄动作应集中在宿主的装配器（如 `invocationAssembler`）与 Core 展开层。
- 契约层位于 shared，**不得**引用 electron 侧类型；SDK 决策硬约束"契约禁函数句柄"与"端口一律接口"即是此文件的设计规则。
