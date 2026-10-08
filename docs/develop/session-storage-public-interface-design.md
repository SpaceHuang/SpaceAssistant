# 会话存储公共接口详细设计

| 字段 | 内容 |
| --- | --- |
| 状态 | v26 · 原S0–S4验收通过；评审4项P1修复及最终门禁通过 |
| 日期 | 2026-10-07 |
| 上层方案 | [会话存储代码结构与接口优化方案](./session-storage-refactorability-improvement-plan.md) |
| 基线 | worktree起点 main HEAD f2cec895；S0盘点以隔离worktree实码核对，既有改动不代表阶段验收 |
| 范围 | 无数据库类型的接口、数据契约、调用顺序、原子性及错误映射；不改持久格式，不实现第二后端 |

本文接口为目标定义。代码块使用项目现有 domain/SDK 类型和下文定义的契约；SDK执行所需端口落在 `packages/agent-sdk`，宿主业务接口落在 `electron/sessionStorage/contracts.ts`，按 §0 划分；不从 database/operations 或 runtime 具体实现导入公共类型。旧 DTO 可原样迁出或由共享 domain 类型复用，不顺带改变 IPC。

## 0. SDK 与 Electron 的职责及契约所有权

**SDK 自己定义运行所需的持久化契约，宿主实现这些契约。** 不能让SDK导入electron/sessionStorage/contracts，也不能仅把接口文件挪入SDK而让接口继续使用宿主Message/Session/TurnCoordinator。

整个会话存储对宿主是独立模块；对SDK则是注入的窄能力。两层接口可以由同一个存储实现提供，但所有权和数据类型不同；具体后端不是契约的一部分。

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

### 0.6 接口接入与旧端口退出顺序

设计门槛关闭后按上层计划S1→S2→S3→S4接入，不并行搬动跨阶段consumer：

1. S1先稳定Electron SessionQueries/Commands/Execution宿主契约及factory注入；SDK包公共入口由`packages/agent-sdk/src/index.ts`导出SDK consumer需要的HistoryPort、ContextPort及其DTO/错误类型，ContextRegistrar与内部binding不作为包consumer API；`src/shared/agent/invocation.ts`保留renderer需要的无宿主Reasoning类型，不导入SDK。Electron assembler负责两侧DTO转换。
2. S1/S2先迁移只读查询、accepted context读入口、route/reuse-user、chat分页/搜索/capability/backup等consumer；History继续单一SDK `HistoryPort`，scope专属查询走SessionQueries，不把SQLite扩展塞进HistoryPort。
3. S3先接入ContextPort/ContextRegistrar和History writer队列，在manual、preflight、boundary、provider recovery四条路径通过失败/并发用例后，才退出`ContextProjectionPort`及`preflightModelRequest`/`turnBoundary`旧contract。当前投影提交只允许作为SDK内部注册evidence的受控提交后hook，不再以第二个port暴露。
4. Agent SDK中`legacy.appDb`、`sessionEventLocation`、sessionLedger投影回调/压缩participant按真实consumer逐项迁到Electron宿主adapter；只有所有consumer/测试都不再引用后才删字段。Session event的业务事实与History event语义不因移出路径而删减。
5. S4接入Recovery/Lifecycle宿主组合根后，移除已迁移启动阶段的旧跨模块协调；每个保留的无History内存boundary、同库其他域adapter及安全维护owner单独具名，不以宽泛runtime例外绕过护栏。

以上次序是兼容接入方案，不改变现有IPC、持久事件或cleanup gate。旧字段在各自consumer迁移及回归通过前保留。

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

**架构要求**：组合根通过所选存储实现的工厂创建会话存储实例，并将所需 port 注入 IPC、Agent、outbound 等对象。具体实现选择、底层资源配置及关闭/flush由组合根和资源适配层负责；公共接口不要求数据库连接、文件目录或某种存储后端。consumer不调用具体工厂，不通过service locator获取全部权限，也不能访问内部维护入口。

**本轮实现**：使用现有SQLite适配器，将AppDatabase、History、spill/ledger依赖绑定在内部，不新增后端或运行时选择机制。SQLite工厂只是本轮装配示例，不是SessionStorage或SDK port的接口前提。未来选择其他实现时，调整实现工厂及组合根装配；业务consumer仍通过原公共契约调用。该替换方向仅用于接口设计，本轮不要求实现或验证另一后端。

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
type ContextHistorySummaryBaseline = {
  sessionId: string
  entries: Array<{ messageId: string; role: Message['role']; imageTokens: number; thinkingTokens: number; sequence: number }>
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
  continuationSources: ContinuationSourceQueries
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
  readContextHistorySummaryBaseline(sessionId: string): ContextHistorySummaryBaseline
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
| readContextHistorySummaryBaseline | 全会话扫描，不受API context前500条限制 | 只返回有image/thinking token的轻量行，不读取正文 | getContextHistorySummaryBaseline |
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
  appendNonTurnMessage(message: Message): MessageEntry
  renameSession(sessionId: string, name: string): Session | undefined
  updateSettings(sessionId: string, patch: SessionSettings): Session | undefined
  updateUserMetadata(sessionId: string, metadata: Record<string, unknown>): Session | undefined
  editMessage(input: MessageRef & { content: string }): Promise<boolean>
  updateToolCallScrollback(input: MessageRef & { toolCalls: NonNullable<Message['toolCalls']> }): MessageEntry | null
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

兼容metadata merge当前需保留的存储owner字段为`titleGenerated`、`titleUserCustom`、`titleOpenBackfillAttempted`、`sessionDirectoryGrants`、`remoteSessionLastActivityAt`、`feishuMessageId`、`wechatMessageId`和`wechatMeta`。它们继续分别由标题、目录授权和远程session commands维护；用户metadata提交不得伪造或清除这些字段。

| 方法 | 修改范围/前置条件 | 原子性与重试 |
| --- | --- | --- |
| createSession | 原默认模型、ownership/visibility与初始状态 | 非request幂等；失败结果未知时不能盲重试创建 |
| renameSession | 原trim/空值行为与用户自定义标题标记，缺session undefined | 名称+关联标记一起写；不写任意metadata；重复设置不承诺时间戳不变 |
| updateSettings | 仅原配置字段；远程workdir等外部busy约束原位置保留 | 不修改执行中固定配置，不引入新锁/校验 |
| updateUserMetadata | 原IPC允许的兼容metadata merge | 与updateSettings分开；只保护本模块拥有的完整性/授权/幂等字段。其他产品领域metadata沿原merge语义保留，不为逐键迁移新增命令 |
| editMessage | session归属；canonical与legacy选择内部完成；允许状态沿原writer | canonical append+镜像+preview保持原事务；false仅代表既有不满足条件，异常不吞；无新幂等键 |
| appendNonTurnMessage | session及Message身份沿现有append owner校验 | 保留原append/canonical镜像和返回sequence；不接收任意事务callback |
| updateToolCallScrollback | 仅允许toolCalls.terminalScrollback变化，session/message归属需匹配 | 继续由既有消息内容owner提交；不能借此改变tool状态、正文或其他元数据 |
| enqueue | session存在；requestId正文/附件指纹 | 消息+receipt一起写；同key同指纹返回duplicate，不同指纹冲突；适合已知回执查询后重试 |
| editQueued | user且queued、trim后非空 | 正文+receipt指纹+preview/revision一起提交；已经认领则拒绝 |
| reorderQueued | IDs恰为当前完整queued集合，无重复 | 序号/preview/fence一起提交；集合变化返回queue_changed |
| deleteQueued | 消息归属、user/queued | 删除+receipt cancelled+count/preview/fence一起提交；重复调用沿原not-found结果 |
| deleteSession | 原归属/用户删除许可由adapter检查 | 整会话既有事务与GC待办；文件回收不放进外部回调，重复删除沿原语义 |

editMessage 的legacy分支复用 updateMessageContent 的正文子集，canonical分支复用 writeCanonicalBackedMessageContent，不向普通业务开放status/toolCalls patch。`updateToolCallScrollback`只接受terminal滚屏字段；其余tool metadata仍由execution/coordinator协议更新。streaming/checkpoint使用下面的coordinator专用协议。

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
  continuationIntents: ContinuationIntentStore
  continuationLaunch: ContinuationLaunchStore
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

映射createOrGetAgentContinuation/claimAgentContinuation/setAgentContinuationStatus/ForTurn；保留request key、createdBy、checkpoint和冻结配置冲突规则。外部startAgentContinuation负责路由重验与运行启动，不向port传conn。continuation_intents（接受入口路由回执）与agent_continuations（执行续跑）不同；前者由§5.5公共接受操作与prepare hook封装，不用本接口代替。

### 5.5 ContinuationIntentStore：接受入口的公共操作

本接口处理continuation_intents，和§5.4执行续跑记录分开；由Electron execution port提供。原payload指纹算法保持`JSON.stringify({sessionId,text,attachments: attachments ?? null})`，不与queue fingerprint合并。

```ts
type IntentKey = { requestId: string; sessionId: string }
type IntentPayload = IntentKey & { text: string; attachments?: Message['attachments'] }
type ContinuationSource = {
  invocationId: string; turnId: string; sequence: number
  summary: string; state: 'known' | 'unknown'
}
type IntentRoute = 'ordinary' | 'ordinary-selected' | 'context-turn' |
  'ordinary-queue' | 'context-queue' | 'continuation' | 'needs-source-selection'
type IntentReceipt = IntentKey & {
  route: IntentRoute; target?: IntentTarget
  status: 'needs_source_selection' | 'ordinary_fallback_pending' | 'starting_continuation' | 'queued' |
    'accepted_turn' | 'accepted_continuation' | 'rejected_retryable' | 'commit_uncertain'
  rejectionReason?: string
}
interface ContinuationIntentStore {
  beginContinuation(input: IntentPayload & {
    source: ContinuationSourceRef
  }): IntentReceipt
  finalizeContinuationAcceptance(input: IntentPayload & {
    continuationId: string
  }): { receipt: IntentReceipt; statusMessage: MessageEntry }
  readReceipt(input: IntentPayload): IntentReceipt | undefined
  requireSourceSelection(input: IntentPayload): IntentReceipt
  selectOrdinary(input: IntentPayload): IntentReceipt
  reject(input: IntentPayload & {
    reason: string; status: 'rejected_retryable' | 'commit_uncertain'
  }): IntentReceipt
  enqueueAndRecord(input: IntentPayload & {
    queuedText: string; source?: ContinuationSource
  }): { receipt: IntentReceipt; queued: EnqueueResult }
  repairPreparedAcceptance(input: IntentPayload & {
    turnId: string; source?: ContinuationSource
    retrySource?: { assistantMessageId: string; invocationId?: string }
  }): IntentReceipt
  bindStartedTurn(input: IntentPayload & { turnId: string }): IntentReceipt
  bindExactContinueTurn(input: IntentPayload & { turnId: string }): IntentReceipt
  ensureStatusMessage(key: IntentKey): { messageId: string; sequence: number }
  resolveAcceptance(input: IntentPayload): IntentAcceptance
}
type IntentAcceptance =
  | { kind: 'absent' }
  | { kind: 'selection-required'; receipt: IntentReceipt }
  | { kind: 'queued'; receipt: IntentReceipt; message: MessageEntry }
  | { kind: 'turn'; receipt: IntentReceipt; turn: TurnRecord; assistant: Message }
  | { kind: 'continuation'; receipt: IntentReceipt; target: IntentTarget; message: MessageEntry }
  | { kind: 'starting'; receipt: IntentReceipt; continuation?: ContinuationRecord }
  | { kind: 'unresolved'; receipt?: IntentReceipt; reason: string }
```

readReceipt和所有写方法先核验requestId已有payload_sha256及session，冲突抛CONTINUATION_INTENT_IDEMPOTENCY_CONFLICT。receipt仅反映已持久接受状态，不证明外部运行已开始或成功。source必须由当前既有选择/校验路径产生，模块核对source归属，不重选历史源。

| 路径/方法 | 原子范围与现有码映射 | 重试/失败 |
| --- | --- | --- |
| requireSourceSelection/selectOrdinary/reject | outbound登记needs-source-selection、显式ordinary_fallback、失败记录，分别短事务 | 相同payload允许原有状态操作；不同payload拒绝；不重置已有accepted target |
| enqueueAndRecord | queued消息+queue receipt+continuation intent/source/target同事务，映射queueContinuation | 内部通知移到提交后；不接收外部enqueue callback；失败整批回滚 |
| prepareTurn内部acceptance | PrepareTurnInput新增可选acceptance={payload,route,source,retrySource}，coordinator把原continuationIntent传给内部prepareAtomic | 原user/assistant/turn/History/intent target同事务；这是正式prepare hook，不另开port事务 |
| repairPreparedAcceptance | outbound原653行upsert/重试source更新；验证已有turn/request身份后短事务封装 | 仅修复返回已有persisted turn的兼容adapter；不重新prepare、不启动执行 |
| bindStartedTurn | outbound原684行await startTurn后的独立target/status更新 | 保持独立提交，不把startTurn外部动作塞事务；receipt缺失/target冲突返回原未决错误，不自动补造接受 |
| bindExactContinueTurn | IPC原885行route/status/target更新 | 在原execute调度后的原位置调用，不擅自把调度搬到提交后；接收已知turn身份，不启动第二次执行 |
| ensureStatusMessage | 原确定状态消息ID及sequence查询/追加的一笔事务；request关联由确定ID表达，不新增receipt表 | 保留确定身份复用，不能为同request重复追加显示消息 |
| resolveAcceptance | 原prior分支：核验queued状态/sequence、turn/request及projected assistant；continuation通过ensureStatusMessage得到原回执 | 结果缺失/部分提交返回unresolved，不视作absent再发起外部动作 |

对于accepted_turn和accepted_continuation当前可能存在的后置更新覆盖顺序，适配保持现有调用顺序与结果，不新增全局优先级。映射冲突处理须区分当前路径合法转换和target身份冲突；不能直接提供任意patchReceipt。

unknown提交：先调用resolveAcceptance。确认queued/turn/continuation则返回原接受结果；存在receipt却缺target/消息/turn则unresolved，沿CONTINUATION_INTENT_COMMIT_UNCERTAIN处理，不发送、不startTurn、不调用createOrGet新续跑。确认absent也不能证明外部startTurn未发生，必须查既有request对应turn并由原接受恢复策略决定；本接口不承诺外部exactly-once。

consumer映射：outbound prior SQL→readReceipt/resolveAcceptance；source选择insert/update→requireSourceSelection/selectOrdinary/reject；queueContinuation→enqueueAndRecord；真实prepare→携带acceptance的prepare hook；prepare兼容upsert→repairPreparedAcceptance；await startTurn后update→bindStartedTurn；IPC exact-continue update→bindExactContinueTurn。普通retry/turn查询经execution/query，不持conn。

### 5.6 真正续跑：开始登记、启动事务、最终接受

不能把真正续跑的continuationId与IPC exact-continue普通turnId混为同一种target。公共receipt新增判别target，原target_id存储字段不变，内部根据route及关联记录映射，不凭字符串外形猜类型：

```ts
type IntentTarget =
  | { kind: 'queued-message'; messageId: string }
  | { kind: 'turn'; turnId: string }
  | { kind: 'continuation'; continuationId: string }
type ContinuationSourceRef = {
  sessionId: string; invocationId: string; turnId: string
  checkpointSequence: number; expectedHistoryVersion: number
}
// IntentReceipt.target?: IntentTarget；删除公共targetId字段。
interface ContinuationLaunchStore {
  prepareAndClaim(input: {
    payload: IntentPayload; source: ContinuationSourceRef
    userMessageId: string; createdBy: string
    frozenConfig: Record<string, unknown>; executionConfig: TurnExecutionConfig
  }): Promise<{
    accepted: true; started: boolean
    continuation: ContinuationRecord; turn?: TurnStarted
  }>
}
```

ContinuationLaunchStore作为execution.continuationLaunch提供，只注入可信启动adapter。模块工厂绑定现有runtime的prepareContinuation业务协作，不对consumer传conn或开放任意事务callback；内部沿现有startAgentContinuation事务，外部模型执行调度仍沿原adapter时机。

| 操作 | 提交范围与顺序 | 状态/target |
| --- | --- | --- |
| beginContinuation | 原outbound479行insertIntent短事务：验证payload、source身份/版本，保存源信息；提交后才await宿主startContinuation | starting_continuation；首次暂无target；不得清除已接受target |
| continuationLaunch.prepareAndClaim | 内部重读并验证source checkpoint、required-user、新任务边界；createOrGet续跑记录、intent关联、runtime.prepareContinuation、claim、原事务末intent更新同事务 | intent关联时starting+continuationId，原事务末accepted+continuationId；失败整批回滚 |
| finalizeContinuationAcceptance | 原outbound482行外层事务：接受状态/源target核验或幂等更新 + ensureContinuationStatusMessage确定ID查询/追加共同提交 | accepted_continuation + continuationId；返回完整statusMessage，不拆两次port调用 |
| bindExactContinueTurn | 原IPC885行普通turn路径，独立更新，不代表上述真实续跑 | accepted_continuation + turnId，公共target.kind=turn |

当前startAgentContinuation末尾本身还写accepted状态（agentContinuation.ts约330行），不是始终停留starting；本设计明确保留它。外层finalize仍不可省略：它负责同事务保证状态消息。事务期间的starting可回滚，崩溃后可见的starting通常来自第一笔登记或未知提交，不能直接据此重启执行。

finalize先核验continuation记录的request/source/session及原starting或已accepted身份，相同target允许重读；不同target/payload拒绝。已接受但缺状态消息时同一finalize事务补齐确定ID消息；事务失败不应留下此次新消息而未接受。ensureStatusMessage只保留历史重复读取兼容用途，真实成功路径必须用finalize，不能拆开调用。

resolveAcceptance对route=continuation通过agent_continuations关联识别target.kind，不通过turn lookup误判。starting返回starting/unresolved及实际关联record，不返回absent；accepted时返回既有/确定ID状态消息。未知prepare/finalize提交先查询request idempotencyKey和intent：已知已接受则恢复同一结果；关联缺失/状态不确定沿COMMIT_UNCERTAIN拒绝，不重复prepare、claim或外部发送。原未提交且安全拒绝的checkpoint可按原策略降级context-only turn；已经started或TransactionCommitUnknownError不走安全降级。

完整调用图：

```text
outbound查询/选择source→beginContinuation
  →await宿主startContinuation（权限/路由配置重验）
    →execution.continuationLaunch.prepareAndClaim（内部原事务）
    →原模型执行调度，不在新DB事务内
  →finalizeContinuationAcceptance（接受+状态消息同事务）
  →返回local-command回执
```

### 5.7 源任务查询：封装枚举、边界证据与显式选择

源选择产品策略继续留outbound；所有SQL与具体History枚举读取收回宿主query。不能要求consumer通过HistoryPort增加SQLite特有方法。

```ts
interface ContinuationSourceQueries {
  inspect(input: {
    sessionId: string
    activeTurnIds: readonly string[] // 当前runtime真实活动集合，不猜持久turn等于活动
    selectedAssistantMessageId?: string
  }): ContinuationSourceInspection
}
type FailedSourceCandidate = {
  source: ContinuationSourceRef
  assistantMessageId?: string; assistantSequence?: number
  snapshot: HistorySnapshot // SDK公开事件DTO，不是SQLite adapter
  summary: ContinuationSource
}
type ContinuationSourceInspection =
  | { kind: 'unavailable'; reason: 'CONTINUATION_INTENT_HISTORY_UNAVAILABLE' }
  | {
      kind: 'available'
      boundary: 'running-turn-superseded' | 'newer-input' | 'completed-invocation' | 'history-start'
      failedCandidates: readonly FailedSourceCandidate[] // 原最新到最旧次序
      selected:
        | { kind: 'not-requested' }
        | { kind: 'found'; candidate: FailedSourceCandidate }
        | { kind: 'not-found' | 'not-recoverable' }
      fallback?: FailedSourceCandidate
      selectedFallback?: FailedSourceCandidate
    }
```

SessionQueries.continuationSources提供此窄接口。snapshot用于现有summarize/策略校验；不提供修改源状态权力，实际prepareAndClaim必须再次读History验证expected版本及较新输入。public DTO不泄漏workDir、stream SQL或spill位置；读取全程沿当前owner完整性校验。

| 原outbound分支 | query内部行为 | outbound仍负责 |
| --- | --- | --- |
| 386–405最新invocation/活动turn | 枚举session streams，读最新事件；非终态且对应activeTurnIds则running-turn-superseded，否则非终态返回unavailable | superseded走原新输入/队列决策；unavailable拒绝 |
| 405–413失败候选与边界 | 最新向前枚举，failed加入；完成终态停止；source assistant sequence之后存在sent/queued user则停止，不加该过期源 | 单候选选它，多候选chooseLatest/要求用户选择；不改顺序 |
| 436–452显式assistant | session内assistant→turn/request；有候选时只从候选中匹配；候选为空时保留原requestId History fallback并校验failed终态 | not-found/not-recoverable映射原错误，不新增隐式选择 |
| 455–469历史fallback | 仅候选为空：读取最新user、失败assistant数量与turn request；唯一失败且最新user.sequence < assistant.sequence时读failed History | 仅原relationCue且未选普通路径时消费fallback；不把fallback自动当可续跑source |

无源返回available+空候选，无需抛错；多源仍显式保留。候选内缺assistant sequence时保持当前原边界行为，不凭空把unknown当eligible；真正续跑启动会按现有SOURCE_STALE拒绝。显式选择的fallback与一般fallback分别字段表达，避免误用为同一种候选。History所有权/结构损坏沿原异常传播或unavailable拒绝，不返回假空候选。

调用映射：outbound所有SqliteAgentHistory/list/read与assistant→turn/sequence SQL替换为一次inspect；active集合仍由runtime取得，sourceSelection/原exact/relationCue逻辑保持；源码摘要使用存储/SDK均不依赖的纯函数模块（当前`continuationSummary.ts`），不得由SessionQueries反向import outbound。inspect期间不await模型；任何选择到启动间变化由prepareAndClaim的source复核拒绝，不新增长期锁。

## 6. SDK ContextPort：无损材料与单一writer提交

本节替换原缩略契约。类型由SDK定义，Electron实现session读取/投影适配；不迁移任何台账或History格式。CanonicalTurnMessage复用turn.ts现有带稳定身份的类型，不用仅有role/content的模型消息替代。

### 6.1 无损DTO及签发入口

```ts
type JsonValue = null | boolean | number | string | JsonValue[] |
  { [key: string]: JsonValue }
type ContextItem = Readonly<{
  // 同一surface上的稳定身份，不按本次数组index重新生成
  replayIdentity: string
  sourceMessageIds: readonly string[]
  message: CanonicalTurnMessage
  // builder已有source/block关联资料的无损副本；不含路径/连接
  sourceData: Readonly<Record<string, JsonValue>>
}>
type ContextFrame = Readonly<{
  items: readonly ContextItem[]
  system: string
  windowId: string
  requiredUser?: Readonly<{ id: string; message: CanonicalModelMessage }>
  pendingTools: readonly CanonicalToolCall[]
}>
type ContextFence = Readonly<{
  token: string // 模块签发的运行期handle，外部不可构造/解码
}>
type ContextSnapshot = Readonly<{
  scope: ContextScope; frame: ContextFrame; fence: ContextFence
}>
type ContextTransformationEvidence = Readonly<{
  token: string // 共用planner注册候选证据的handle
}>
type ContextCandidate = Readonly<{
  base: ContextSnapshot; output: ContextFrame
  evidence: ContextTransformationEvidence
}>
type ContextCommitReceipt = Readonly<{
  operationId: string; windowId: string
  inputFingerprint: string; outputFingerprint: string
  historyVersion?: number // session台账路径没有invocation版本
}>
interface ContextPort {
  readCurrent(scope: ContextScope): Promise<ContextSnapshot>
  commitReplacement(input: {
    operationId: string
    reason: 'manual-compact' | 'auto-compact' | 'window-transition'
    candidate: ContextCandidate
  }): Promise<ContextCommitResult>
}
type ContextScope =
  | { kind: 'session'; sessionId: string }
  | { kind: 'invocation'; sessionId: string; invocationId: string }
type ContextCommitResult =
  | { status: 'committed'; snapshot: ContextSnapshot; receipt: ContextCommitReceipt }
  | { status: 'stale' | 'busy' | 'no-op' | 'uncompressible' }
  | { status: 'commit-uncertain'; receipt?: ContextCommitReceipt; error: Error }
```

frame输出模型请求时仅提取items.message；身份、sourceData和系统文本留在上下文契约，不写入供应商messages。输入/输出指纹分别使用各原路径已有算法；不因DTO增加字段改变历史fingerprint。

| 现有材料 | 新DTO/证据映射 | 保全要求 |
| --- | --- | --- |
| stable message ID、surfaceItemIdentities | replayIdentity/sourceMessageIds、message现有id | 不按刷新顺序重编号；checkpoint无来源时sourceMessageIds为空 |
| 文本/图片/thinking/toolCalls/role=tool | 完整CanonicalTurnMessage及block源映射sourceData | JSON无损拷贝；禁止textOf压平作为持久输出 |
| requiredUserMessage、待dispatch工具 | requiredUser、pendingTools | 保留原JSON相等与tool id/name/input校验 |
| checkpointMessage、checkpointReplayIdentity、shadowedRanges | planner注册证据的私有条目 | 原candidate逐字段保存，不省略或重算身份 |
| historyPayload、commitProjection | 私有证据条目的payload副本及受控投影函数 | payload保持既有字段；禁止覆盖messages/fingerprint/required-user保留键 |
| windowId、outputSurfaceFingerprint | frame、receipt及私有指纹记录 | marker由Electron根据receipt+原记录映射，不传入SDK类型 |

sourceData只容纳已确认JSON可表达的源关联，不容纳任意对象。builder输出遇到非JSON资料时由Electron adapter保留在私有注册条目中，ContextItem使用运行期关联handle；不进行有损JSON stringify。注册条目按operation生命周期释放，不承诺跨进程token有效。

内部可信签发接口的完整边界如下；实现closure由SDK/context模块构造，只有受控planner adapter持有，业务caller仅拿ContextPort：

```ts
interface ContextRegistrar {
  captureFrame(input: {
    scope: ContextScope; frame: ContextFrame
    binding: { kind: 'session'; surfaceFingerprint: string } |
      { kind: 'invocation'; phase: ContextPhase; epoch: number; expectedHistoryVersion: number }
  }): ContextSnapshot
  registerTransformation(input: {
    base: ContextSnapshot; output: ContextFrame
    proof: {
      historyPayload: Readonly<Record<string, JsonValue>>
      sourceBindings: readonly { outputIdentity: string; inputIdentities: readonly string[] }[]
      checkpoint?: Readonly<Record<string, JsonValue>>
      shadowedRanges: readonly { start: string; end: string }[]
      commitProjection?: () => void | Promise<void>
    }
  }): ContextCandidate
}
```

sourceBindings覆盖保留、合并与checkpoint输出；无来源输出必须是现有允许的checkpoint/replay形态，不允许任意新消息。proof保存原payload不增加持久字段；commitProjection仅可信宿主adapter提供，不向普通caller开放。session surface fingerprint和invocation version由工厂/SDK绑定校验，不能通过公开captureFrame自行伪造。

`captureFrame(frame, scope, binding)`由SDK/宿主可信装配点注册输入快照并签发fence；`registerTransformation(base, output, proof)`由共用planner适配器签发evidence。它们是内部接口，不给IPC/业务consumer签发权限。校验以注册条目为准，比较base/输出完整内容、scope、输入指纹及运行帧epoch，不以TypeScript品牌或随机token本身代替验证。

提交入口必须在首次`await`前同步解析并验证完整candidate，取得registrar持有的冻结candidate与proof；scope/fence比较、stale判断、fingerprint、持久化/History append、receipt、projection及运行态应用必须始终使用该解析结果，不能在异步等待后再次读取调用方传入的对象。此约束覆盖对candidate的可变clone。回归需在session与invocation两种端口分别暂停capture及持久化/append，等待期间篡改调用方output，并确认持久化、History、projection和运行态仍采用注册时输出。

### 6.2 invocation读取与writer绑定hook

SDK在创建InvocationHistoryWriter后创建一次以下内部binding，并交给ContextPort工厂；没有另一个writer。此hook由SDK定义，不把writer对象或通用transaction callback交给consumer。

```ts
type ContextPhase = 'preflight' | 'boundary'
interface InvocationContextBinding {
  scope: Extract<ContextScope, { kind: 'invocation' }>
  capture(): Promise<Readonly<{
    frame: ContextFrame; phase: ContextPhase
    epoch: number; expectedHistoryVersion: number
  }>>
  appendReplacement(input: {
    epoch: number; expectedHistoryVersion: number
    payload: Readonly<Record<string, JsonValue>>
  }): Promise<HistoryAppendResult>
}
// SDK内部新增writer受限方法；不是公开替换HistoryPort
// writer.appendAtVersion(events, expectedVersion): Promise<InvocationHistoryAppendResult>
```

`capture`读取SDK当前阶段的冻结frame，不从数据库重新拼凑运行状态。preflight frame是当前messages；boundary frame是`[...messages, committedMessage]`。本轮response在boundary前已按原路径写入model-response-committed；frame即使尚未splice到messages，也属于可信阶段输入。禁止混入尚未提交的provider chunk/tool结果；先验证response提交结果，再开放boundary捕获。

SDK设置阶段frame时递增epoch；摘要await后epoch变化则stale。capture在原writer队列完成后取得currentOrPersistedVersion；appendReplacement在同一writer的队列中先核验epoch、writer版本及持久版本，再调用原HistoryPort.appendBatch，成功才推进writer.version。`appendAtVersion`需重构现有append的排队内部实现，不能在已排队callback中再调用append并等待造成死锁。expected version检查必须在队列内，不是队列外check后无条件append。

appendReplacement只能追加单条transcript-compacted，其messages/指纹/required-user来自注册候选；adapter不持有任意append能力。其他事件也沿同一writer，不能另建序列队列竞争版本。

### 6.3 三条调用图与旧写入口退出

```text
手动：compact IPC → session ContextPort.readCurrent
  → API baseline+surface+已提交shadow（内部）
  → planner/摘要 →注册候选→commitReplacement
  →重验session busy/fingerprint→原appendCompactionTransaction
  →committed→UI marker；下一请求重放新surface

preflight：SDK设置phase frame=messages→ContextPort.readCurrent
  →原preflight planner（只返回候选，不持久写）→注册候选
  →commitReplacement→binding.appendReplacement（原writer）
  →原commitProjection→committed→SDK splice/messages/window→重prepare请求

boundary：先完成原response History提交
  →SDK设置phase frame=[...messages, committedMessage]
  →readCurrent→原boundary planner→注册候选→commitReplacement
  →同writer appendReplacement→原commitProjection
  →committed→SDK替换messages/window，boundaryReplacedTranscript=true
```

`turn.ts` preflight原698行与boundary原1227行的transcript-compacted append块、随后的commitProjection块全部由ContextPort内部提交路径接管，旧位置仅保留结果处理和内存生效，不能保留第二次append。planner的commitProjection从返回给consumer的候选中移入可信evidence注册条目。对其他provider recovery中直接追加replacement的路径同样盘点接入，不允许形成旁路。

无History但只替换内存的旧boundary兼容行为不得凭本接口强制写History：明确归入legacy adapter，保持原仅内存结果并不称作持久committed；完整ContextPort接入以有History路径为本轮目标。legacy路径的调用者不得得到可恢复提交receipt，兼容分支退出另记，不暗中改变产品行为。

### 6.4 提交结果和部分失败

port校验无损输出、required-user和pendingTools，再重验fence。no-op/uncompressible/stale/busy不写。History成功后才调用原宿主projection；成功返回receipt和由候选构成的新snapshot，不重新读取无关最新frame。

History成功而projection失败时返回commit-uncertain并带已知historyVersion/指纹。SDK将其映射为原AgentTurnBoundaryProjectionError停止执行；不splice、不请求模型、不追加第二次压缩。恢复读取已提交History及现有补偿事实。History提交结果未知同样停止；已知事务回滚的普通错误仍抛出，不伪造receipt。手动台账部分失败沿原结果/重放语义，不宣称跨后端exactly-once。

## 7. SessionRecoveryPort：完整协作与结果来源

### 7.1 工厂绑定回调

bootstrap在构造端口时绑定下面能力；recover不接受外部succeeded布尔值。restoreTurn与recover均是同步业务回调，与当前TurnCoordinator实际签名一致。

```ts
interface TurnRecoveryCallbacks {
  restoreTurn(turn: TurnRecord, assistant: Message): void
  recover(): number
}
interface SessionRecoveryPort {
  recover(): Promise<RecoveryReport>
  inspectReadiness(sessionId: string): Readiness
}
type Readiness = {
  readable: boolean; executable: boolean
  reason?: 'recovery-pending' | 'content-unavailable' | 'execution-blocked'
}
type RecoveryReport = {
  status: 'ready' | 'degraded' | 'blocked'
  history: { succeeded: boolean; interruptedCount: number; repairFailureCount: number }
  snapshots: { restoredCount: number; skippedCanonicalUnavailableCount: number; missingAssistantCount: number }
  coordinator: { succeeded: boolean; recoveredCount: number }
  reconciliation:
    | { status: 'skipped'; reason: 'history-recovery-incomplete' | 'turn-projection-recovery-incomplete' }
    | { status: 'completed'; releasedUnstarted: number; markedUncertain: number; repairedCheckpoints: number; reconciled: number }
  continuations: { interrupted: number; unknownSideEffect: number; settled: number }
  failures: Array<{ stage: 'history' | 'snapshots' | 'coordinator' | 'reconciliation' | 'continuations'; error: Error }>
}
```

不再暴露skippedSessionIds：原快照恢复只计算跳过快照数量，不可伪造为session列表。新增restored/missingAssistant计数只在实际for-loop分支计数，不改变处理行为；callback返回非void的原值忽略。History回调与台账补偿能力也由工厂绑定当前main已有实现，不能让bootstrap伪造结果。

### 7.2 真实阶段顺序与门禁

1. 资源宿主先完成原DB初始化及必要安全/confirmation恢复；confirmation reconcile和其他安全域仍各自owner管理，不因封装省略。原startup orphan/台账修复按现有main时序绑定，不凭名称重排。
2. 模块运行当前main的canonical History恢复及所有既有projection修复，repairFailureCount包含catch及participant故障；succeeded仅当实际失败数为0。
3. 有现有turnRuntime时，按configuring/prepared/executing/waiting-confirm枚举快照。只在getProjectedMessage的局部catch跳过CANONICAL_SESSION_CONTENT_UNAVAILABLE；assistant不存在不restore并计missing。restoreTurn在catch外调用，异常中断该阶段。
4. 快照恢复没有callback错误才调用coordinator.recover，使用实际number计数；随后hasUnfinishedStartupProjections核验。仍有残留或recover抛错时coordinator.succeeded=false，不能继续释放执行围栏。
5. reconciliation首先要求history.succeeded，再要求coordinator.succeeded及再次无未完成projection；通过后才recoverStaleSessionExecutionClaims和reconcileCommittedSessionTranscripts。失败保持原claim/checkpoint保护，记录stage错误。
6. continuation reconciliation沿原`history.succeeded && coordinator.succeeded`输入运行，保留unknownSideEffect语义；它不是无条件重新执行外部动作。

现有无ctx.turnRuntime分支仍通过原runtime创建/恢复路径处理，不强制套用上述显式快照恢复分支。工厂记录绑定模式`existing-runtime | legacy-created-runtime`，按原分支生成报告；没有实际coordinator成功证据的模式不得宣称通过gate。

### 7.3 readiness和异常范围

recover运行中返回recovery-pending；报告blocked表示History/协调器/投影门禁未满足，或恢复callback/reconcile失败，执行不开放。degraded用于快照正文被跳过但持久恢复/门禁已完成，不能把跳过当成History健康。

inspectReadiness内部查询现有session状态/持久执行fence与已知正文故障；不存在session返回readable=false/executable=false，不新增新的成功语义。readable仅表示当前允许进入读路径，实际读取仍可能遇到未发现的损坏；不是完整性认证。executable是当前存储准入条件，不能替代执行claim/CAS。快照跳过不永久写坏session清单或放宽gate。

原异常边界保持：projection读取局部不可用可跳过，restore callback抛相同错误文本也必须失败；unexpected History/SQL异常不自动隔离为某session；report收集原启动能捕获的失败，不吞用户操作的异常。port并发recover合并同一在途Promise；完成后bootstrap不重复调用，重试沿原重启协议，不新增在线释放流程。

## 7.4 宿主生命周期与后台维护契约

参考[Spill引用索引与可续跑回填方案](./spill-reference-index-and-backfill-plan.md)。原接口仅封装恢复与删除，尚不足以表达启动后的后台工作。本节定义宿主调度边界，不实施索引migration、回填worker或每日清理策略；具体实现和放行仍属于该专项方案。

### 7.4.1 宿主独享接口

工厂返回业务SessionStorage与单独的StorageLifecycleControl，只有bootstrap/资源宿主持有后者；不把维护能力默认注入IPC/Agent/renderer。SDK只需执行端口，不拥有桌面窗口、保留策略或索引回填接口。

```ts
type MaintenanceReason = 'startup' | 'window-ready' | 'policy-changed' |
  'scope-changed' | 'capacity-pressure' | 'retry'
type MaintenanceClass = 'pending-reclamation' | 'retention' | 'derived-index'
type MaintenanceState = {
  taskId: string // opaque业务任务身份，不是表名/locator/文件路径
  category: MaintenanceClass
  status: 'idle' | 'scheduled' | 'running' | 'paused' | 'failed' | 'completed'
  scannedCount: number; processedCount: number
  lastErrorCode?: string; lastSuccessAt?: number
}
interface StorageLifecycleControl {
  initialize(input: { signal?: AbortSignal }): Promise<void>
  requestMaintenance(input: {
    reason: MaintenanceReason; category?: MaintenanceClass
  }): { status: 'scheduled' | 'coalesced' | 'not-needed' }
  allowBackgroundWork(): void
  pauseMaintenance(input: { category?: MaintenanceClass }): Promise<void>
  resumeMaintenance(input: { category?: MaintenanceClass }): void
  inspectMaintenance(): readonly MaintenanceState[]
  stop(input: { deadlineMs: number }): Promise<{
    status: 'quiescent' | 'deadline-exceeded'
  }>
}
```

initialize仅初始化本实现资源和轻量恢复/待办检查，不在首屏等待大目录扫描或全量回填；不能与SessionRecoveryPort.recover混用。recover仍负责执行事实恢复与准入门禁，后台维护失败不伪造恢复成功，也不因retention失败阻断所有健康会话。

requestMaintenance仅安排/合并工作，不返回“已经清完”；消费者不得据scheduled删除文件。allowBackgroundWork在窗口可用或非UI宿主对应ready时调用，使策略型sweep/回填可运行。pending-reclamation沿已有崩溃回收策略尽早恢复，不强制等待窗口ready；真正耗时工作仍有有界批次/让出机制，不能以“异步”名字掩盖同步全扫描。

pause在安全批次边界停止，已提交游标保留，未提交批次回滚或原协议处理；不强制中断unlink与引用校验临界区。resume仅允许既有任务续跑，不授权跳过验证。stop拒绝新维护、请求安全暂停并等待在途写入/维护退出；只有quiescent才由资源宿主flush/close。deadline-exceeded时不能立即关闭仍被worker使用的连接，宿主沿已有进程退出策略处理；下次由持久待办恢复，不承诺后台清理全部完成。

方法sync/async按生命周期需求定义；维护状态为诊断快照，不是恢复/删除许可。signal/暂停不改业务deleteSession与History写入的事务规则。

### 7.4.2 三类工作及模块归属

| 工作 | 接口及触发 | 安全责任 |
| --- | --- | --- |
| 加载执行状态/崩溃事实恢复 | initialize→recovery.recover | 原History/turn/claim门禁，不因窗口ready后调度而延迟必要恢复 |
| session删除后source spill回收 | deleteSession内部同事务登记durable待办；内部唤醒pending-reclamation | delete成功表示逻辑删除和待办已提交，不表示文件已unlink；共享引用/严格校验由模块负责 |
| spill引用索引回填/对账 | derived-index低优先级后台任务 | 双写先行、keyset/字节预算、持久游标、owner revision复核、失败完整回滚，不向宿主暴露canonical表 |
| spill degradable/会话台账retention | retention，window-ready/策略或scope变化触发 | 原root fence、source/degradable分类、投影与compaction依赖保护，不缓存删除许可 |
| MCP artifacts/Agent日志/usage facts | 各自模块生命周期接口，由宿主调度器协作 | 不收进会话存储；usage crash reconcile与usage retention仍分开 |

公共调度器只能协调priority/取消/运行观测，不能直接删除会话spill或重建引用索引。原spill root/workDir集合在adapter里解析；scope-changed事件不向公共port传物理路径。政策字段沿已有配置类型/入口传递；指纹、时区日界和算法版本计算在任务owner内，不让宿主改写last-success。

### 7.4.3 索引与异步清理必须封装的不变量

- canonical写入与引用索引维护必须位于原写事务，含History、transcript、修复/删除所有写点；禁止公共caller另外调用“更新索引”。
- 回填未complete且未核验前，索引只供影子诊断。GC继续原严格canonical扫描，索引无记录不代表无引用。source unlink的额外定向复核按专项方案保留。
- worker每批更新索引及游标同事务，核验owner revision/hash；并发写/删不能被旧批次覆盖。损坏/未知descriptor拒绝删除，不把坏行当空。
- policy/root变化使内部成功水位失效；只在完整sweep成功后推进，失败不前进。本地日与任务原口径保持，不由SDK统一UTC。
- 重启从最后已提交cursor/待办恢复；taskId状态及观测不能替代持久进度。complete是内部完整性证明，不接受host设置。
- profile/restore/旧writer版本导致索引失效时，内部回退安全读法并安排重验，普通queries/commands契约不变。

### 7.4.4 宿主调用与验收

```text
bootstrap选择存储实现→initialize
  →必要recovery（原执行门禁）→开放可用业务能力
  →window ready→allowBackgroundWork/requestMaintenance
运行：内部删除/写入唤醒待办；宿主通知policy/scope/容量变化
退出：pause/stop→quiescent→原flush/close
```

原retention全扫描/回填切后台和水位持久化会改变时序或schema，不能因本节定义自动实施。本轮可先封装当前维护入口与资源访问；专项实现接入时验证取消/批次故障、重启续跑、单root互斥、共享locator不误删、失败不推进水位，以及UI业务接口无新增raw访问。

该接口属于新增设计收口项，待生命周期owner/当前启动调用点映射复评；不将已有continuation等P1或其他门禁视为关闭。

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

**本节是接口接入实施的前置条件，不是可以留到实现过程中补齐的待办。**S0已完成；Context、continuation/source query、metadata边界、DTO、recovery和lifecycle已按当前worktree逐项复评，具体调用映射/失败边界及兼容退出顺序见§0.6、§5–§7。本节设计门槛已关闭，不代表实现完成；S1–S3已验收，S4按计划顺序完成子项并进行最终门禁。

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
1. continuation接受操作已补充至§5.5，需按当前outbound/IPC实码复评，验证每条原事务/后置操作映射。
2. metadata/body边界：只盘点本模块拥有、影响持久完整性/授权/幂等的metadata字段并保护其写入口；settings与兼容metadata merge分开，其他产品领域metadata保留原merge语义，不扩展为逐键迁移。
3. DTO迁出实施时进行typecheck，保持本文已核对的SearchCorpusPage/RetryTarget/QueueReceipt/ApiBaseline字段，不能因组织代码删除字段。
4. Context DTO/签发/hook已补充至§6，需复评并补充实现时的无损映射和队列负例测试清单；单纯facade改名不算完成。
5. recovery回调/报告已补充至§7，需复评真实启动分支与字段来源，不把数量伪造为session列表。

### 9.1 收口台账

| 项目 | 状态 | 关闭证据 |
| --- | --- | --- |
| SDK/宿主契约归属与旧端口退出 | 设计已收口；S1/S3退出待实现 | §0及§0.6明确shared/SDK所有权、DTO转换点、公共导出及旧端口按consumer迁移后的退出条件；实现仍需移除真实旧引用。 |
| ContextPort无损DTO及提交hook | S3已验收 | §6.1–§6.4的SDK invocation与session-scope ContextPort已接入；SDK忽略planner额外返回的`commitProjection`，Hosted ledger投影由宿主注入的可信ContextProjectionCommitter在History replacement之后执行；失败保持fail closed。SDK/Hosted统一为强类型`planContextReplacement(phase)`，observer响应证据回调与Hosted planner命名按ContextReplacement职责收敛。新改动后的全量`npm test` 895文件通过、1个跳过，8508项通过、111项跳过；renderer/shared/Electron/SDK类型检查、storage boundary（15条既有例外、无新增）、旧contract扫描和diff check通过。 |
| continuation接受事务及源查询 | 设计已收口；S3该子项已接入，阶段验收待完成 | §5.5–§5.7普通接受、真实launch/finalize、selectedFallback与source boundary已按TDD接入具名query/execution操作；outbound无History/DB旁路，summary为runtime纯函数，IPC retry source经`readLatestRetryTarget`。定向82项、Electron类型检查、storage边界护栏（18条既有例外、无新增）及`git diff --check`通过；S3其他门槛仍开放。 |
| metadata/body边界及受限入口 | 设计已收口；S3接口已拆分、阶段验收待完成 | `editMessage`仅提交正文；tool scrollback使用受限命令；settings与兼容metadata merge分为`updateSettings`和`updateUserMetadata`，保护标题状态、目录授权与远程身份字段。需随S3全阶段验收复核现有merge行为。 |
| 生命周期与异步维护 | S4子项复核完成；阶段验收待最终门禁 | host-only `StorageLifecycleControl` 按具名task/category创建SQLite upkeep、spill GC和session-content cleanup scheduler；启动前请求返回not-needed，按类别pause/resume并提供维护状态快照。原有ready时机、safe-db分支、门禁和参数保持；退出先停任务再等待quiescent，受12秒deadline约束。类别TDD及维护/退出定向16项、Electron类型检查通过。 |
| 公共DTO完整性 | S1–S3已验收；S4阶段门禁待完成 | Electron SessionStorage contracts及SDK公共导出已接入；consumer迁移后Electron、SDK、renderer/shared typecheck通过，DTO字段已随实际consumer逐项编译核验。 |
| 恢复回调与结果 | S4子项复核完成；阶段验收待最终门禁 | SessionStorageHost将main现有History与session-ledger恢复结果注入recovery port；阶段顺序为History→ledger→snapshot→coordinator→transcript reconciliation→continuation，报告基于实际计数/失败，safe-db-maintenance继续fail closed。SQLite adapter readiness经真实SQLite测试确认：recover前返回pending，成功恢复后按session读取与transcript fence返回readable/executable；实际执行仍由现有claim/CAS围栏兜底。恢复/启动定向303项及新增readiness 4项通过，Electron类型检查与边界护栏通过。 |

设计门槛已逐项复评并收口；S1、S2、S3均已按各阶段全量测试、类型检查和边界证据验收。S4此前阶段级门禁通过记录见下段，但本轮复核又发现lifecycle启动接线及认证/清理物理拆分缺口，已按序修复，并补充真实SQLite readiness验证。当前S4已完成recovery、lifecycle、maintenance/certification/cache拆分子项；旧contract/import与完整阶段门禁仍待最终复核，故暂不标记S4完成。

### S4进度（2026-10-07）

S4旧adapter审计曾通过；后续复核重新打开lifecycle及职责拆分子项，现已按TDD修复并补足按类别pause/resume与状态检查，且将cleanup/certification实现物理分离。真实SQLite readiness回归、旧contract/import扫描及最终全量门禁均通过。S0–S4全部验收完成，执行证据见上层计划§S4收口记录。

## 10. 接口级验收

- contracts/consumer不导入AppDatabase、DatabaseSync、SqliteAgentHistory或raw operations；barrel/别名绕过有负例。
- query签名保持同步业务语义，context/History保留原异步，IPC输入输出不变。
- 排队指纹幂等、接受身份first-win、prepare/claim/checkpoint原子回滚、路由CAS、终态History提交及清理围栏沿现有真实SQLite测试验证。
- 上下文两入口同一read/commit接口；读到已有压缩结果，stale/busy不写，projection部分失败阻止下一请求。
- rename标题标记、列表刷新/分页/显示、导出、retry、startup故障隔离均通过真实consumer回归。
- 不要求JSONL或第二后端测试；从公共签名检查存储无关性。mock仅验证依赖注入，不代替事务/重启校验。
