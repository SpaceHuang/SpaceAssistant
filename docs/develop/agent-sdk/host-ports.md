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

**messages**（只传本次新增输入，历史不经此传入——由 `HistoryPort` / 上下文端口装载）：

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

**会话元数据与标题建议**

```ts
/** 冻结的会话元数据，用于构建本次调用的产品上下文。 */
sessionMetadata?: Readonly<Record<string, unknown>>
/** 产品级标题建议能力，与存储 / History 解耦。 */
titleSuggestions?: { schedule(input: Record<string, unknown>): void }
```

- 旧的 `AgentStoragePorts`（`loaded` / `sessionEventLocation` / `readSession` / `persist.updateSessionMetadata` / `persist.scheduleTitleSuggestion` / `persist.recordUserAnswerFromDecision` / `appendCompactionTransaction`）与 `AgentLoadedSessionContext`、`AgentPersistPorts` **已随会话存储重构整体下线**，本契约不再声明存储端口：会话材料的读写统一走 SDK 定义的 `HistoryPort`（[history.md](./history.md)）与上下文端口（[context.md](./context.md)）。
- `sessionMetadata` 是装配期冻结的快照（不再是 `loadContext` 装载的活对象）。
- `titleSuggestions.schedule` 承接原 `persist.scheduleTitleSuggestion`；`AgentEventSink.onTitleGenerated` 仍是落库后的界面通知出口。

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

**关于 `invocationRuntime` 的 park 家族**：`park` / `resumeLease` 只存在于 **SDK 包内这一份契约**（宿主转发层已不再声明 `AgentHostPorts`）；SDK 侧 `scheduler.ts` 的 `InvocationRuntime` 参考实现也删除了 park 家族（2026-09-30），turn 循环没有任何调用点。当前审批等待不释放父 turn 的应用级准入名额；运行中的 turn 持有其普通名额直到整个 turn 结束。旧 History 的 `invocation-parked` 事件仍兼容读取，但自存储重构起它已是**闭合事件**：出现后同一调用不可再追加事件，重启重建直接判 `interrupted`（见 [history.md](./history.md)）。

**历史与模型生命周期钩子**

```ts
history?: HistoryPort                                   // SDK 拥有的事件持久化契约（见 history.md）
recordProviderAttemptUsage?(input: Record<string, unknown>): void
planContextReplacement?(input: import('./turn').ContextReplacementPlanInput):
  Promise<import('./turn').ContextReplacementPlanResult | void>
recoverProviderAttempt?(input: unknown): Promise<unknown>   // 响应未被接受时由宿主决定是否恢复并安全重试一次
hostFacts?: { getBrowserDetectContext?(): BrowserDetectContext }
translate?(message: LocalizedMessage): string               // 主进程只产「键 + 参数」，显示处经此解析
contextMeter?: unknown
```

- `history` 已是 SDK 定义的 **`HistoryPort`**（不再是"同形影子写入"）：宿主提供适配器，事件 kind、形状与不变量以 `packages/agent-sdk/src/history.ts` 为唯一真源；终态追加会带 `transcriptCommit`，适配器需把会话 transcript 提交与终态事件放进同一事务。
- `planContextReplacement` **取代**了原先的 `turnBoundary` 与 `preflightModelRequest` 两个钩子：同一个规划器按 `phase: 'preflight'` / `phase: 'turn-boundary'` 调用，返回 `{ messages, windowId?, historyPayload? }` 表示替换、返回 `{ rejected: 'OVER_BUDGET' }` 表示预算拒绝、返回 `void` 表示不处理（见 [turn-loop.md](./turn-loop.md)）。
- `recordProviderAttemptUsage` 与 `usage` 端口分开声明：它记录**每一次** provider 尝试（接受或丢弃）的用量。

**过渡豁免（已标记废弃）**

```ts
/** @deprecated P2 删除 */
legacy?: { appDb?: unknown }
```

`appDb` 原样透传给循环体内既有取用路径，是"端口一律接口"唯一声明的过渡豁免期。

## 4. 与宿主转发层的差异（src/shared/agent/invocation.ts）

SDK 包内这份契约是 SDK 循环实际依赖的**全部面**（调用入参 + 宿主端口）；宿主另有转发层 `src/shared/agent/invocation.ts`（供 electron / renderer 直接 import）。会话存储重构后，转发层**只保留调用入参面**：

| 差异点 | SDK 包（`packages/agent-sdk/src/invocation.ts`） | 宿主转发层（`src/shared/agent/invocation.ts`） |
| --- | --- | --- |
| 宿主端口 | 定义 `AgentHostPorts` 及 `AgentWorkspacePorts` / `AgentCredentialsPorts` / `AgentPolicyPorts` / `AgentExposurePorts` / `AgentMcpPorts` / `AgentUsagePorts` / `AgentDiagnosticsPorts` / `AgentAnswererPorts` / `AgentToolRevocationPort` | **已全部移除**（端口面的唯一来源是 SDK 包） |
| 宿主类型引用 | 一律以 `any` 占位，不 import `src/shared`（`invocation.contractShape.test.ts` 守护） | 引用真实类型（`WorkspaceSnapshot`、`AcceptedTurn`、`BrowserDetectContext` 等） |
| `AgentInvocation.acceptedTurn` | 无此字段 | `acceptedTurn?: AcceptedTurn`（迁移期字段） |
| `AgentTraceContext.turnId` 注释 | 「缺省回退 sessionId 占位」 | 「本回合规范执行身份；迁移期旧调用可省略，不能使用 sessionId 代替」 |
| `AgentReasoningEffort` | `'off' \| 'low' \| 'medium' \| 'high'` | 追加 `'max'`（composer-model-thinking-entry FR11） |

装配方在 electron 侧一般 import 转发层拿**调用入参类型**（`acceptedTurn` 只在转发层可用），**端口类型一律从 SDK 包取**；`invocation.contractShape.test.ts` 会锁住转发层仍暴露的方法签名形状（例如 `planContextReplacement?(input: ContextReplacementPlanInput): Promise<ContextReplacementPlanResult | void>`）。

## 5. 装配注意

- 所有以 `unknown` 声明的字段都是 electron 专属类型的占位，收窄动作应集中在宿主的装配器（如 `invocationAssembler`）与 Core 展开层。
- 契约层位于 shared，**不得**引用 electron 侧类型；SDK 决策硬约束"契约禁函数句柄"与"端口一律接口"即是此文件的设计规则。
- 存储侧已无 `ports.storage` 一族：会话材料与投影经 `ports.history`（`HistoryPort`）与上下文端口（`planContextReplacement` + `turn` 的 `contextProjectionCommitter`）流转；`sessionMetadata` / `titleSuggestions` 分别取代原 `storage.loaded` 与 `storage.persist.scheduleTitleSuggestion`。装配顺序见 [README.md](./README.md)「典型装配顺序」。
