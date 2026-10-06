# 会话存储公共接口详细设计

| 字段 | 内容 |
| --- | --- |
| 状态 | v3 · 接口设计未定稿；§9 收口项未关闭，不具备接口接入实施条件 |
| 日期 | 2026-10-04 |
| 上层方案 | [会话存储代码结构与接口优化方案](./session-storage-refactorability-improvement-plan.md) |
| 基线 | session-storage-refactor-tdd worktree 的 Phase 5 实现；main 的调用者一并盘点 |
| 范围 | 无数据库类型的接口、数据契约、调用顺序、原子性及错误映射；不改持久格式，不实现第二后端 |

本文接口为目标定义。代码块使用项目现有 domain/SDK 类型和下文定义的契约；SDK执行所需端口落在 `packages/agent-sdk`，宿主业务接口落在 `electron/sessionStorage/contracts.ts`，按 §0 划分；不从 database/operations 或 runtime 具体实现导入公共类型。旧 DTO 可原样迁出或由共享 domain 类型复用，不顺带改变 IPC。

## 0. SDK 与 Electron 的职责及契约所有权

**SDK 自己定义运行所需的持久化契约，宿主实现这些契约。** 不能让SDK导入electron/sessionStorage/contracts，也不能仅把接口文件挪入SDK而让接口继续使用宿主Message/Session/TurnCoordinator。

整个会话存储对宿主是独立模块；对SDK则是注入的窄能力。两层接口可以由同一个SQLite实现提供，但所有权和数据类型不同。

### 0.1 实际基线与需修正的依赖

SDK已有history.ts的HistoryPort、InvocationHistoryWriter、History校验/状态重建，以及model.ts的CanonicalModelMessage；turn.ts已负责请求与工具循环、上下文替换事件和preflight/boundary。优先沿这些入口扩展，不新增平行History协议。

invocation.ts的AgentHostPorts.history目前重复内联History契约，应统一引用HistoryPort。AgentStoragePorts中sessionEventLocation（workDir/createdAt）、appendCompactionTransaction(start,summary)泄漏台账细节；这些应收回宿主实现，用上下文提交契约取代。现有persist把标题建议、metadata与安全信任写入混在一起，也应按业务能力分别注入，不能塞进SDK存储核心。

### 0.2 职责划分

| 职责 | SDK拥有 | Electron/sessionStorage保留 |
| --- | --- | --- |
| History | event/snapshot/port、writer、版本/顺序/幂等与转移语义、纯重建 | SQLite append/read、scope/owner校验、spill解码、事务镜像 |
| 上下文 | ContextPort与DTO、有效执行context折叠、replacement校验、提交结果/错误语义 | session材料选择、UI/附件到SDK格式转换、台账/History后端适配及宿主投影 |
| 压缩 | 宿主无关的候选/required-message/工具一致性规则；共用planner纯逻辑适合逐步归SDK | 模型/预算配置解析、摘要provider装配、用户IPC权限、产品压缩策略与显示marker |
| accepted/执行 | SDK若直接消费，定义冻结输入身份、执行版本/准入和原子完成intent；不引入UI DTO | turn/queue/receipt/transcript适配、既有TurnCoordinator协议与业务接收入口 |
| continuation | 与invocation checkpoint有关的纯校验、冻结/冲突语义，确需SDK消费时定义端口 | outbound路由/接受回执、现有记录落库、宿主启动和产品操作 |
| 恢复 | invocation状态重建、合法续跑/未知副作用判断及其必要端口 | 枚举持久工作、跨session隔离、coordinator恢复、整机启动顺序与maintenance |
| UI/管理 | 不拥有会话改名、列表、搜索、配置、备份和资源关闭 | SessionQueries/Commands、导出、权限、IPC、资源宿主 |

只搬真正由SDK消费的执行契约，不能把整份SessionExecutionStore和SessionQueries搬入SDK。宿主同步接口及共享TurnStorage保持本轮兼容；SDK新端口不引用src/shared/domainTypes或turnCoordinator，使用SDK自己的最小类型。

### 0.3 目标依赖方向与文件归属

```text
SDK runtime → SDK端口/DTO/纯规则 ← Electron存储实现
UI/IPC/outbound → Electron宿主ports → 同一存储实现
```

建议SDK新增context.ts定义ContextPort、ContextScope/Snapshot/Candidate/CommitResult与错误；History继续history.ts。execution/continuation端口只在明确SDK消费点后增加相应文件，不为对称预建万能SessionStoragePort。

Electron contracts导入SDK契约并组合宿主ports；context adapter实现SDK ContextPort。sessionContextService是宿主触发/策略协调器，自动路径由SDK调用同一个ContextPort，手动入口经宿主调用；两者不选择持久后端。

存储实现向SDK纯函数提供已读取事件/材料，SDK不打开DB、不读文件、不知道WAL/cache表/spill根目录。SDK对上下文scope里的sessionId只是通用归属标识，不依赖桌面Session对象。

### 0.4 SDK端口的类型修订

本文§6的ContextFence、Snapshot、Candidate和CommitResult改由SDK拥有。移除CompactionMarker这一宿主DTO，改为SDK定义的最小ContextCommitReceipt（operationId、windowId、input/output fingerprint等实际通用字段）；宿主adapter通过既有提交记录映射UI marker，不让SDK依赖台账事件形态。

opaque fence/evidence的接口类型和签发/验证规则由SDK契约定义；宿主负责后端snapshot校验，SDK负责运行上下文版本/候选一致性。token可在端口内部包含不同后端信息，SDK不可解释SQLite字段。不能因为字段隐藏就跳过模型调用后重验。

SDK需要接受上下文时，由宿主adapter将Message等资料转换为CanonicalModelMessage和SDK冻结身份。turn/queue等产品事实仍由execution宿主port维护；如SDK需要终态的原子会话提交，通过HistoryPort已有transcriptCommit业务intent或明确的SDK窄提交端口实现，不能让SDK调用Electron prepareTurn。

### 0.5 移植保证与本轮接入验收

SDK移植要求新宿主实现HistoryPort、ContextPort和它实际使用的host能力，不要求实现聊天UI或Electron整套SessionStorage。实现接口不等于正确，SDK需明确版本冲突、身份、原子提交及不确定结果语义，提供端口契约案例供宿主验证。

本轮不实现新宿主/JSONL，也不要求另一后端演练。检查SDK公共入口闭包没有electron/node:sqlite/宿主UI或文件布局依赖；现有SDK行为测试与真实SQLiteadapter测试分别保留。共享UI类型不得反向依赖SDK：仓库当前check-agent-sdk-dependencies禁止src/shared导入SDK，跨层转换放Electron adapter或保留无反向依赖的兼容转发。

未接入的SDKContextPort不能只导出类型就标完成：自动压缩必须真正经端口提交，原History writer仍只写一次；手动入口使用同端口类型。旧AgentStoragePorts字段在全部consumer改造后删除，期间具名标注兼容adapter。

## 1. 资源、实例与权限

```ts
interface SessionStorage {
  queries: SessionQueries
  commands: SessionCommands
  execution: SessionExecutionStore
  contexts: ContextPort
  recovery: SessionRecoveryPort
}
```

组合根调用具体 SQLite 工厂一次，把所需 port 注入 IPC、Agent、outbound 等对象。工厂参数、AppDatabase、关闭/flush、文件根目录和内部维护入口只在资源宿主/adapter 出现。consumer 不调用工厂，不通过 service locator 在全局拿全部权限。

SessionId/MessageId/TurnId/RequestId 在本轮保留 string，不全库强制改 branded ID。调用者的身份权限由现有 IPC/capability 层校验；存储方法始终检查传入 session 和消息/turn 的真实归属。查询结果不授予写权限。

新增 opaque token 由模块返回，不可序列化成公共 IPC 数据，不由 caller 拼字段。错误诊断不得包含正文/密钥。

## 2. 公共 DTO 与错误

```ts
type MessageRef = Readonly<{ sessionId: string; messageId: string }>
type TurnRef = Readonly<{ sessionId: string; turnId: string }>
type MessageEntry = { message: Message; sequence: number }
type ChatPage = {
  entries: MessageEntry[]
  oldestSequence: number | null
  hasMoreBefore: boolean
}
type ExportPage = { rows: MessageEntry[]; nextSequence: number }
type TurnContextSelection = {
  sessionId: string
  boundarySequence?: number
  requiredUserMessageId?: string
  excludeMessageIds: string[]
}
type ApiBaseline = {
  sessionId: string
  entries: Array<{ message: Message; sequence: number }>
}
type SearchHit = {
  messageId: string; sessionId: string; content: string; sessionName: string
}
type RetryTarget = {
  failedAssistant: MessageEntry; currentUser: MessageEntry
  excludeMessageIds: string[]; sourceInvocationId?: string
}
type SearchCorpusPage = {
  entries: MessageEntry[]; nextSequence: number; hasMore: boolean
}

declare const fenceBrand: unique symbol
type SelectionFence = Readonly<{ [fenceBrand]: 'selection' }>
// ContextFence改从SDK context契约导入，不在宿主重复定义。
```

sequence 是已有消息顺序，不是 rowid，允许删除造成空洞。消息 DTO 返回完整已解析正文和现有状态/附件信息；骨架类型仅供确需纯身份/状态的窄内部协议，不用空 content 模拟完整消息。公共类型可以保留已有 Message 的字段，但不新增 storage state/codec/cache 来源字段。

### 2.1 错误约定

第一阶段不全面改写异常体系。公共 adapter 集中将既有异常识别为下表类别，保留原 code/cause 并映射回原 IPC/SDK；方法已经用判别结果表达失败时保持结果方式。不新增笼统 `ok:false` 吞掉部分提交。

| 类别 | 典型来源 | 提交状态/调用者行为 |
| --- | --- | --- |
| invalid-input | 归属/参数非法、required-user 不满足 | 未写入；修正请求 |
| not-found | 具体读接口返回 undefined/null | 不代表正文损坏；按原 UI 行为处理 |
| content-unavailable | CANONICAL_SESSION_CONTENT_UNAVAILABLE、spill/History 损坏 | 不能构造模型请求；保留错误，不返回空正文 |
| conflict | revision/version/指纹或幂等冲突、queue_changed | 未接受目标修改；重新读取或沿现有冲突流程 |
| blocked | busy、cleanup 写围栏、执行被占用 | 不绕过 fence；等待或使用明确允许的操作 |
| storage-failure | SQLite/I/O 或 participant 失败 | 只有已知事务回滚才算未写入；未知结果归下一类 |
| commit-uncertain | 已写 History 但投影失败、提交结果不确定 | 停止依赖该结果的执行，通过读取/恢复确认；禁止盲重放 |

不是所有失败都有幂等重试保证。requestId、turnId 或 operationId 能否重用，由各方法下文规定；不添加新持久回执。

## 3. SessionQueries：全部只读业务能力

```ts
interface SessionQueries {
  readSession(sessionId: string): Session | undefined
  listSessions(options?: { view?: 'all' | 'user-visible' }): Session[]
  readMessage(ref: MessageRef): Message | undefined
  readMessages(input: {
    sessionId: string; limit?: number; offset?: number
  }): Message[] // 仅兼容既有 chat:get-messages，非新 consumer 首选
  readChatPage(input: {
    sessionId: string; beforeSequence?: number | null; limit?: number
  }): ChatPage
  readExportPage(input: {
    sessionId: string; fromSequence: number; pageSize: number
  }): ExportPage
  readTurnContext(input: TurnContextSelection): Message[]
  readApiBaseline(input: { sessionId: string; limit?: number }): ApiBaseline
  readRoutingInput(input: TurnContextSelection & {
    limit?: number; reuseUserMessageId?: string
  }): RoutingRead
  isSelectionCurrent(sessionId: string, fence: SelectionFence): boolean
  readRetryTarget(input: {
    sessionId: string; failedAssistantMessageId: string
  }): RetryTarget | null
  readMessageSequence(ref: MessageRef): number | null
  searchMessages(input: {
    query: string; activeProfileId: string; limit?: number
  }): SearchHit[]
  readSearchCorpusPage(input: {
    sessionId: string; fromSequence: number; pageSize?: number
  }): SearchCorpusPage
}
type RoutingRead = {
  recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>
  userInput?: string
  hasVision: boolean
  fence: SelectionFence
}
// RetryTarget/SearchCorpusPage 与上文定义一致，原字段完整保留。
```

同步返回保持当前 SQLite 路径时序。查询可内部重建 disposable cache，但不推进清理或授予新写权威；业务不区分缓存来源。

### 3.1 逐方法规则

| 方法 | 前置/选择语义 | 输出与错误 | 实现映射 |
| --- | --- | --- | --- |
| readSession/listSessions | 原 ownership/visibility 筛选；非权限替代 | 不存在 undefined，列表保留 updatedAt 排序 | getSession/listSessions |
| readMessage | 先校验 message 归属 session | 不存在 undefined；损坏抛 content-unavailable，不映射不存在 | getProjectedMessage |
| readMessages | 仅旧 offset 调用，默认与原函数一致 | 原 Message[]；不扩展使用 | getProjectedMessages |
| readChatPage | before 排他；默认60，现有20–100限制 | sequence升序、hasMoreBefore；空页 oldest=null | getProjectedChatMessagePage |
| readExportPage | from 含边界；沿原 pageSize 校验 | nextSequence 来自真实序号，空页回填输入；非快照导出保证 | getProjectedMessagesPageWithSequence |
| readTurnContext | boundary/required-user/exclude/order 完全沿原筛选 | 不静默省略必要正文；不等于最新UI页 | getProjectedTurnContext |
| readApiBaseline | 默认500；用于已有compact/观测 | 保留全部原DTO，不授予执行资格 | getProjectedApiContextBaseline |
| readRoutingInput | 单快照取原窗口与reuse输入/vision；默认50 | fence 封装已有 generation/revision及路由资格校验，不新增规则 | readCanonicalTurnRoutingInputWithFenceIfEligible及既有fallback/selector |
| isSelectionCurrent | fence必须模块签发且属于session | false后不得提交旧路由配置；此检查本身不是原子写CAS | isCanonicalApiReadFenceCurrent/既有revision检查 |
| readRetryTarget | failed assistant归属及原错误/重试边界 | 保留现有null/错误语义 | resolveProjectedRetryContext |
| readMessageSequence | session匹配 | 缺失null，不从分页位置推算 | getMessageSequence |
| searchMessages | profile筛选、字面LIKE、原limit | 返回原排序/命中；canonical故障沿现有范围拒绝 | searchProjectedMessages |
| readSearchCorpusPage | from含边界，默认200、现有50–500限制；不改IPC | 无损迁出原DTO | getProjectedSearchCorpusPage |

分页不会自动成为跨多次请求的一致性快照。UI沿既有消息ID合并/请求过期处理；导出若当前无锁快照，不在此接口宣称固定整个会话。新增分页快照属于另项行为设计。

## 4. SessionCommands：受限修改

```ts
type CreateSessionInput = {
  name: string; model?: string; llmServiceId?: string
  temperature?: number; maxTokens?: number
  workDirProfileId?: string
  ownership?: SessionOwnership; visibility?: SessionVisibility
  thinkingEffort?: AgentReasoningEffort
  metadata?: Record<string, unknown> // 仅创建兼容；无任意后续状态patch
}
type SessionSettings = Partial<Pick<Session,
  'model' | 'llmServiceId' | 'temperature' | 'maxTokens' |
  'workDirProfileId' | 'skillsState'
>> & { thinkingEffort?: AgentReasoningEffort | null }
interface SessionCommands {
  createSession(input: CreateSessionInput): Session
  renameSession(sessionId: string, name: string): Session | undefined
  updateSettings(sessionId: string, patch: SessionSettings): Session | undefined
  updateUserMetadata(sessionId: string, metadata: Record<string, unknown>): Session | undefined
  editMessage(input: MessageRef & { content: string }): Promise<boolean>
  enqueue(input: {
    sessionId: string; requestId: string
    content: string; attachments?: Message['attachments']
  }): EnqueueResult
  editQueued(input: MessageRef & { content: string }): QueuedEditResult
  reorderQueued(input: { sessionId: string; messageIds: string[] }): QueueOrderResult
  deleteQueued(ref: MessageRef): QueueDeleteResult
  deleteSession(sessionId: string): void
}
type EnqueueResult = {
  receipt: QueueReceipt; persisted: MessageEntry; duplicate: boolean
}
type QueueReceipt = {
  sessionId: string; requestId: string; fingerprint: string
  queuedMessageId?: string; turnId?: string; state: string
}
type QueuedEditResult =
  | { ok: true; message: Message; sequence: number }
  | { ok: false; error: 'message_not_queued' | 'empty_content' }
type QueueOrderResult =
  | { ok: true; entries: MessageEntry[] }
  | { ok: false; error: 'queue_changed' }
type QueueDeleteResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: string } // 原有错误字符串不扩散到新方法
```

QueueReceipt 保留当前完整业务字段与可选性。metadata入口只供旧IPC兼容，原merge语义保持；不得修改generation、preview/count、cleanup或accepted identity。识别保留键依据当前实际读取方建立清单，不添加用户可操纵的内部控制字段。

| 方法 | 修改范围/前置条件 | 原子性与重试 |
| --- | --- | --- |
| createSession | 原默认模型、ownership/visibility与初始状态 | 非request幂等；失败结果未知时不能盲重试创建 |
| renameSession | 原trim/空值行为与用户自定义标题标记，缺session undefined | 名称+关联标记一起写；不写任意metadata；重复设置不承诺时间戳不变 |
| updateSettings | 仅原配置字段；远程workdir等外部busy约束原位置保留 | 不修改执行中固定配置，不引入新锁/校验 |
| updateUserMetadata | 原IPC允许的业务metadata merge | 内部键受保护；所需现有业务专用键逐项列为具名方法后替换 |
| editMessage | session归属；canonical与legacy选择内部完成；允许状态沿原writer | canonical append+镜像+preview保持原事务；false仅代表既有不满足条件，异常不吞；无新幂等键 |
| enqueue | session存在；requestId正文/附件指纹 | 消息+receipt一起写；同key同指纹返回duplicate，不同指纹冲突；适合已知回执查询后重试 |
| editQueued | user且queued、trim后非空 | 正文+receipt指纹+preview/revision一起提交；已经认领则拒绝 |
| reorderQueued | IDs恰为当前完整queued集合，无重复 | 序号/preview/fence一起提交；集合变化返回queue_changed |
| deleteQueued | 消息归属、user/queued | 删除+receipt cancelled+count/preview/fence一起提交；重复调用沿原not-found结果 |
| deleteSession | 原归属/用户删除许可由adapter检查 | 整会话既有事务与GC待办；文件回收不放进外部回调，重复删除沿原语义 |

editMessage 的legacy分支复用 updateMessageContent 的正文子集，canonical分支复用 writeCanonicalBackedMessageContent，不向普通业务开放status/toolCalls patch。streaming/checkpoint使用下面的coordinator专用协议。

## 5. SessionExecutionStore：执行状态与原子业务操作

### 5.1 接口定义

```ts
interface SessionExecutionStore {
  coordinator: TurnStorage // 保留src/shared/turnCoordinator既有同步协议
  readTurn(ref: TurnRef): TurnRecord | undefined
  readTurnByRequest(input: { sessionId: string; requestId: string }): TurnRecord | undefined
  hasActiveTurn(sessionId: string): boolean
  prepareTurn(input: PrepareTurnInput): { user: MessageEntry; assistant: MessageEntry }
  claimQueuedTurn(input: ClaimQueuedInput): { user: MessageEntry; assistant: MessageEntry }
  commitExecutionConfig(input: {
    ref: TurnRef; config: TurnExecutionConfig
    intentFingerprint: string; fence: SelectionFence
  }): boolean
  failConfiguring(input: {
    ref: TurnRef; version: number; error: { code: string; message: string }
  }): boolean
  acceptPrepared(input: {
    prepared: PreparedIdentity
    lane: NonNullable<TurnExecutionConfig['lane']>
    config: TurnExecutionConfig
  }): AcceptedTurn
  readAccepted(input: { sessionId: string; requestId: string }): AcceptedTurn | undefined
  loadAcceptedMessages(ref: TurnRef): Message[]
  readTranscriptState(sessionId: string): TranscriptState
  claimExecution(input: { sessionId: string; turnId: string; ownerId: string }): ClaimResult
  markExecutionStarted(input: ExecutionLease): boolean
  releaseExecution(input: ExecutionLease): boolean
  cancelQueuedExecution(input: { sessionId: string; turnId: string; ownerId: string }): boolean
  markExecutionUncertain(input: ExecutionLease): boolean
  historyFor(scope: { sessionId: string; invocationId: string }): HistoryPort
  continuations: ContinuationStore
}
type PreparedIdentity = {
  turnId: string; requestId: string; sessionId: string; startToken: string
  userMessage?: Pick<Message, 'id'>
}
type TranscriptState = {
  sessionId: string; version: number; lastTurnId?: string
  status: 'ready' | 'commit_uncertain' | 'blocked'
}
type ExecutionLease = { sessionId: string; turnId: string; ownerId: string; generation: number }
type ClaimResult =
  | { acquired: true; generation: number }
  | { acquired: false; reason: 'owned' | 'blocked' }
type TurnRecord = PersistedTurnRecord & { version: number; acceptedInputHistoryVersion?: number }
type PrepareTurnInput = {
  user: Omit<Message, 'schemaVersion'> & { schemaVersion?: number }
  assistant: Omit<Message, 'schemaVersion'> & { schemaVersion?: number }
  turn: PersistedTurnRecord
}
type ClaimQueuedInput = {
  sessionId: string; userMessageId: string; turnId: string
  assistantMessageId: string; requestId: string; state?: string
  startToken?: string; intentFingerprint?: string; excludeMessageIds?: string[]
  executionConfig?: TurnExecutionConfig
}
```

TurnRecord、PrepareTurnInput 落地复用/收窄当前协议，必须保留usage/outcome/error等字段。接口不把 state:string 当作任意状态修改能力；入口检查现有允许转移。coordinator是专用兼容能力，只注入TurnCoordinator，不注入UI或outbound；其update/append不得成为通用消息写入口。本轮不重写共享TurnStorage，否则会扩大行为变更。

### 5.2 事务与失败定义

| 方法 | 不可拆开的操作/读取规则 | 幂等与冲突 |
| --- | --- | --- |
| prepareTurn | user+streaming assistant+turn+session-input History 同事务；内部计算原boundary | 活动turn拒绝；request重用先经coordinator findByRequestId，不凭接口名假定prepare自身幂等 |
| claimQueuedTurn | queued→sent、assistant、turn、History、receipt→claimed 同事务 | active/消息已认领/receipt不匹配拒绝，不重复创建 |
| commitExecutionConfig | 原configuring状态及session revision CAS，写配置/指纹→prepared | false阻止执行；fence由readRoutingInput取得，不先单独检查再无条件更新 |
| failConfiguring | 原turn version与状态约束 | boolean保持原语义 |
| acceptPrepared | 原transcript ready核验、接受身份建立与first-accept持久记录 | 首次接受配置胜出；同identity读回原accepted，不同身份冲突 |
| loadAcceptedMessages | 从持久turn选择上下文，并核验History session-input/指纹 | 缺user/指纹变化/正文不可用阻止模型请求 |
| readTranscriptState | 仅控制状态与版本，不把messages_json对外公开 | 缺checkpoint沿原ready/version0规则 |
| claim/mark/release | 保留队首、owner、generation和checkpoint限制 | lease过期返回false，不能释放他人claim；generation是执行租约业务版本 |
| coordinator checkpoint | assistant checkpoint与turn version既有原子提交 | 陈旧version拒绝；恢复outcome映射保持 |

### 5.3 History 与终态提交

historyFor返回SDK现有HistoryPort：appendBatch(events, expectedVersion, transcriptCommit?) 与 read(invocationId)，不增加同步SQLite方法。绑定session/invocation，拒绝访问其他scope。schemaVersion指SDK事件协议版本，不是DB schema。

SDK writer仍负责事件顺序、batch/transition与幂等；持久adapter负责scope与原子落库/镜像。transcriptCommit采用现有SDK业务intent，内部绑定必要的receipt/checkpoint/fence协作，不暴露storedMessagesJson/SQL。terminal History与会话提交需原子时必须通过同一现有提交入口，不额外提供公共 commitSessionTranscript 让caller再写一次。

宿主确需“读取完成结果/恢复状态”等能力时，通过execution/recovery的业务方法封装，不返回SqliteAgentHistory或任意扩展method。两种port共同写同一invocation时仍经原InvocationHistoryWriter序列化，不各自维护独立version。

### 5.4 ContinuationStore

```ts
interface ContinuationStore {
  createOrGet(input: {
    sessionId: string; sourceInvocationId: string
    requestIdempotencyKey: string; createdBy: string
    frozenConfig: Record<string, unknown>
  }): ContinuationRecord
  claim(input: {
    continuationId: string; revalidatedFrozenConfig: Record<string, unknown>
  }): boolean
  settle(input: {
    continuationId: string; status: ContinuationTerminal
  }): boolean
  settleForTurn(input: { targetTurnId: string; status: ContinuationTerminal }): boolean
}
type ContinuationTerminal =
  'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown_side_effect'
```

ContinuationRecord无损迁出现有业务record（source/target身份、checkpoint、frozenConfig、status与transcript）。checkpoint序号是执行事件顺序，checksum是业务冻结证据，不是调用者可改的DB字段。createOrGet内部读取source History并validateContinuationCheckpoint，不接受caller随意提供未经验证的snapshot。

映射createOrGetAgentContinuation/claimAgentContinuation/setAgentContinuationStatus/ForTurn；保留request key、createdBy、checkpoint和冻结配置冲突规则。外部startAgentContinuation负责路由重验与运行启动，不向port传conn。continuation_intents（接受入口路由回执）与agent_continuations（执行续跑）不同；前者也必须由具名操作封装，见§9缺口清单，不能用本接口假装已覆盖全部outbound事务。

## 6. SDK ContextPort：手动/自动共用的上下文接口

此节类型归SDK context.ts；宿主实现端口，UI marker由宿主单独映射。ContextCommitReceipt为SDK最小提交证据类型，字段以实际通用业务证据为准，不携带台账路径。

```ts
type ContextScope =
  | { kind: 'session'; sessionId: string }
  | { kind: 'invocation'; sessionId: string; invocationId: string }
type ContextSnapshot = {
  scope: ContextScope
  messages: readonly CanonicalModelMessage[]
  windowId: string
  fence: ContextFence
}
type ContextCandidate = {
  base: ContextSnapshot
  messages: readonly CanonicalModelMessage[]
  windowId: string
  evidence: ContextTransformationEvidence // planner签发的不透明内部证据
}
type ContextCommitResult =
  | { status: 'committed'; snapshot: ContextSnapshot; receipt?: ContextCommitReceipt }
  | { status: 'stale' | 'busy' | 'no-op' | 'uncompressible' }
  | { status: 'commit-uncertain'; error: Error }
interface ContextPort {
  readCurrent(scope: ContextScope): Promise<ContextSnapshot>
  commitReplacement(input: {
    operationId: string
    reason: 'manual-compact' | 'auto-compact' | 'window-transition'
    candidate: ContextCandidate
  }): Promise<ContextCommitResult>
}
```

ContextTransformationEvidence的值仅来自共用planner；保留shadow/checkpoint、source身份、required-user及现有projection payload。落实时先做现有surface→canonical类型的无损检查；不能用上述messages数组丢弃附件或工具状态。实际字段不适合CanonicalModelMessage时使用无损内部surface DTO并更新两个入口，不强行序列化截断。

### 6.1 readCurrent

session scope：原API baseline query→surface builder→compaction replay/shadow；invocation scope：当前SDK context与持久History/compaction折叠。没有scope归属、缺正文或执行History损坏时抛现有完整性错误。

invocation内尚未持久化的模型/工具结果不能伪装成已提交snapshot；按原安全边界调用。读结果已经包含压缩，不追加完整原历史来“补齐”。

### 6.2 commitReplacement

| 阶段 | 规则 |
| --- | --- |
| 输入校验 | base/evidence均由模块或受控planner签发；scope、required-user、工具顺序及预算符合原规则 |
| 提交前 | 重验原session busy/fingerprint或invocation version；stale/busy不提交 |
| 持久提交 | session adapter沿appendCompactionTransaction；invocation adapter沿SDK transcript-compacted及commitProjection；caller不选后端 |
| 生效 | 仅committed更新运行内context/window或通知marker；snapshot是已提交结果，不能以不相关最新状态覆盖 |
| 部分失败 | History已提交但projection失败返回commit-uncertain或保持原类型化异常；禁止caller继续旧context |

no-op/uncompressible不提交。普通未写入storage错误继续抛出；不能统一吞成failed。operationId沿原request/compaction身份：不引入新全局去重表，不能承诺两种adapter已具备一致的持久幂等。未知提交结果先恢复，不能凭operationId盲重试。

SDK通过受控提交协调hook调用同一port，adapter使用原writer，不能从adapter再次调用boundary形成递归；需绑定原prepared candidate/expected writer version，确保一次replacement只写一次事件。宿主planner仍负责摘要调用，port不调用LLM。

## 7. SessionRecoveryPort：领域恢复，不暴露修复步骤

```ts
interface SessionRecoveryPort {
  recover(input: {
    coordinator: { recover(): number }
  }): Promise<RecoveryReport>
  inspectReadiness(sessionId: string): Readiness
}
type Readiness = {
  readable: boolean; executable: boolean
  reason?: 'recovery-pending' | 'content-unavailable' | 'execution-blocked'
}
type RecoveryReport = {
  status: 'ready' | 'degraded' | 'blocked'
  recoveredInvocationCount: number
  recoveredTurnCount: number
  skippedSessionIds: string[]
  failures: Array<{ scope: 'session' | 'global'; sessionId?: string; error: Error }>
}
```

recover仅bootstrap调用，其他consumer拿不到。coordinator能力是执行业务协作，不是任意数据库回调；落地以现有recover实际签名绑定窄函数，recover返回数值作为实际恢复turn计数，模块核验未完成投影后才允许reconciliation，不能相信caller提供succeeded:true。

内部保持当前History恢复、persisted snapshot/turn恢复及transcript reconcile的真实启动顺序；根据现有启动代码逐步骤封装，不按名称猜顺序。坏session允许隔离的catch仍按原范围，callback自身异常必须传播/计入阻断，不能被误判为可跳过正文。

report计数来自实际结果，不把skipped当成功。inspectReadiness仅暴露领域许可，不允许caller据此绕过实际操作fence；是否允许再次recover及并发调用由bootstrap单次编排控制，不新增运行中重置协议。

## 8. 调用顺序与现有IPC映射

| 调用者 | 接口调用 | 保持现有外部行为 |
| --- | --- | --- |
| session:update 改名 | commands.renameSession | 原trim/标题标记；成功后沿原backup通知 |
| chat:get-message-page | queries.readChatPage | 原before/limit/DTO，renderer旧页合并不变 |
| chat:get-display-message-page | readChatPage→原turnToDisplay | display筛选不重算cursor |
| prepare-turn/reuse | queries.readRoutingInput→execution.commitExecutionConfig | await之后写入口CAS，不单独check后无条件写 |
| Agent开始 | execution.acceptPrepared/loadAcceptedMessages | 固定accepted身份、输入指纹和边界 |
| SDK继续请求 | scoped HistoryPort/ContextPort | 原工具/approval/compaction折叠，不从UI页拼接 |
| compact IPC | contexts.readCurrent→planner→commitReplacement | 原权限/busy；成功marker，历史消息保留 |
| 自动preflight/boundary | 同ContextPort | SDK提交hook接入，原projection错误不吞 |
| session.read capability/backup | queries.readExportPage | 原sequence游标、真实正文，不声明新快照 |
| outbound/remote | execution/continuations及具名接受操作 | 先持久接受，再发送；未知提交不重复外部动作 |
| startup | recovery.recover | 根据领域结果开放原恢复能力 |

## 9. 实施前收口项与设计完成条件

**本节是接口接入实施的前置条件，不是可以留到实现过程中补齐的待办。** 以下各项尚未定稿，当前签名、DTO和调用链均不能认定为可直接实现的最终契约。关闭并复核全部收口项前，不启动以本文契约为依据的接口接入；允许继续只读盘点、设计细化与证据核对。

优先定稿三项：ContextPort的无损DTO与提交hook、continuation接受事务、恢复回调。关闭要求是把具体类型/签名、调用顺序、原子范围、失败与重试规则，以及现有代码映射写入本文；不能仅把台账状态改成“完成”。若选择改变原行为或持久协议，应另立变更，不在结构整理中隐式实施。


| 设计项 | 现有实现起点 | 落地检查 |
| --- | --- | --- |
| public DTO | domainTypes、turnCoordinator、SDK History；operations中的业务DTO | 无数据库import，字段完整，无丢失usage/附件 |
| query绑定 | sessionTranscriptProjection、route cutover | db只在工厂闭包，session归属核验 |
| commands | operations与sessionContentWriteAuthority | 普通修改与执行checkpoint分开，不扩大writer资格 |
| execution/coordinator | createTurnCoordinatorStorage、acceptedTurnContext、sessionTranscript | 多表原子性保留，消息镜像不复活正文 |
| continuation | agentContinuation与outboundAcceptor | checkpoint内部验证；无raw conn |
| context | manual compact与SDK preflight/boundary | 两入口同读写port，无旁路或重复append |
| recovery | main启动链与sessionTranscriptStartup | 阶段内部化、原顺序/隔离边界不变 |

以下不能只写“包装已有函数”就标完成，实施前须补齐签名/映射并追加本设计：

0. SDK/宿主契约拆分：ContextPort实际接入、HistoryPort去重、台账路径与压缩事务细节移出SDK；port DTO无Message/Session/CompactionMarker/TurnCoordinator依赖。
1. outbound中continuation_intents的登记、路由选择、target绑定与状态消息/receipt关联：按现有每个事务边界定义具名业务操作，明确与agent_continuations区别，不做跨所有状态的大事务。
2. 各业务metadata key的使用清单：将需内部一致性的字段迁入具名命令；兼容入口受限且有退出列表。
3. DTO迁出实施时进行typecheck，保持本文已核对的SearchCorpusPage/RetryTarget/QueueReceipt/ApiBaseline字段，不能因组织代码删除字段。
4. Context evidence与SDK提交hook：确定无损surface DTO、writer绑定和不递归调用方式；单纯facade改名不算完成。
5. recovery与coordinator的精确callback签名/计数：从启动代码固定真实顺序与可跳过范围，不伪造并不存在的report数据。

### 9.1 收口台账

| 项目 | 状态 | 关闭证据 |
| --- | --- | --- |
| SDK/宿主契约归属与旧端口退出 | 未关闭 | 实际消费点、类型依赖与兼容接入顺序明确 |
| ContextPort无损DTO及提交hook | 未关闭 | 字段完整映射；writer/version绑定、单次提交、不递归与部分失败语义定稿 |
| continuation接受事务 | 未关闭 | 区分两类continuation记录；每个接受/绑定/状态操作的签名、原子范围和幂等冲突规则定稿 |
| metadata业务键与受限入口 | 未关闭 | 使用清单、保留键、具名命令和旧入口退出条件明确 |
| 公共DTO完整性 | 未关闭 | 与当前真实类型逐字段对照，签名无缩略占位或数据库依赖 |
| 恢复回调与结果 | 未关闭 | 精确回调签名、真实启动顺序、计数来源及可跳过/阻断边界定稿 |

这些是设计收口项，不是已完成的实现。全部关闭后需复核文档内部一致性，再决定进入接口接入阶段；关闭设计项本身不代表代码边界已经收敛，更不涉及数据迁移或发布放行。

## 10. 接口级验收

- contracts/consumer不导入AppDatabase、DatabaseSync、SqliteAgentHistory或raw operations；barrel/别名绕过有负例。
- query签名保持同步业务语义，context/History保留原异步，IPC输入输出不变。
- 排队指纹幂等、接受身份first-win、prepare/claim/checkpoint原子回滚、路由CAS、终态History提交及清理围栏沿现有真实SQLite测试验证。
- 上下文两入口同一read/commit接口；读到已有压缩结果，stale/busy不写，projection部分失败阻止下一请求。
- rename标题标记、列表刷新/分页/显示、导出、retry、startup故障隔离均通过真实consumer回归。
- 不要求JSONL或第二后端测试；从公共签名检查存储无关性。mock仅验证依赖注入，不代替事务/重启校验。
