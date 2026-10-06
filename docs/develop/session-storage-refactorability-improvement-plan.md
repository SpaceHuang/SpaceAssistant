# 会话存储代码结构与接口优化方案

| 字段 | 内容 |
| --- | --- |
| 状态 | v11 · 方案稿；详细设计收口项未关闭，接口接入尚不可实施 |
| 日期 | 2026-10-04 |
| 目标 | 在现有实现上整理模块职责、明确读写接口与依赖方向，降低后续代码重构的影响范围 |
| 实现基线 | `.worktrees/session-storage-refactor-tdd` 中的 Phase 5 实现；主工作区尚未包含全部新增模块 |
| 关联设计 | [技术方案](./session-storage-refactor-technical-design.md)、[迁移计划](./session-storage-refactor-migration-plan.md)；最新实现约束以重构 worktree 对应技术方案为准 |
| 本次范围 | 建立可替换的会话存储模块契约、调用方式与依赖注入；仅调整代码结构，保持现有行为 |
| 排除范围 | 数据迁移、schema/事件/spill/cache 格式变更、生产清理接入、发布门禁、安装包升级/回滚验收 |

## 阅读顺序

- §1：本轮目标、实现基线与范围。
- §2：模块负责哪些数据，哪些事情属于外部。
- §3：外部使用哪些接口，以及接口必须遵守的约束。
- §4：各类调用者如何接入，权限、事务和错误由谁处理。
- §5：改名、列表刷新、Agent 请求与压缩的完整流程。
- §6：模块内部如何组织现有实现。
- §7–§9：分步实施、验收和风险。

## 1. 目标与现状

当前实现已具备 canonical 正文投影、写权威、资格 fence 与清理保护。本次不更换存储模型，也不增加新能力，而是让调用者通过明确接口使用现有能力，让实现细节留在存储内部。

现有代码中的结构问题：

- `electron/database/operations.ts` 混合底层 SQL、消息查询、正文修改、队列和 turn 操作；业务模块容易依赖过宽。
- `sessionTranscriptProjection.ts` 同时包含正文解析、骨架合并、分页、路由、搜索和 cache 操作，职责边界不明显。
- `sessionStorageCutover.ts` 同时提供开关、资格认证、路由读取 fence 和清理流程，普通读请求与维护操作共享过大的模块。
- `sqliteAgentHistory.ts` 包含 canonical append 与消息镜像协作；这些事务关联必须保留，但集成契约需要更清晰。

目标不是把所有函数放进一个 service，而是按稳定职责组织接口，明确哪些函数业务可以调用、哪些仅存储内部可用、哪些必须参与既有事务。

### 1.1 本轮保持不变的行为

本次保持以下内容不变：

1. DB schema、表/列、trigger、持久状态机、History payload、spill 和 cache codec。
2. IPC/renderer 的输入输出、错误码、正文及分页/排序语义。
3. canonical/legacy 来源选择、资格判断与 fail-closed/fail-soft 边界。
4. History、镜像、checkpoint、receipt、执行 fence 的原子提交；现有不确定提交和 CAS 处理。
5. generation、revision、水位、allocator、owner、source spill 完整性校验。
6. queued/streaming/failed 等中间态、metadata-only 修改与正文修改的既有权限。
7. pending/complete 写围栏、整会话删除与 spill GC 的既有语义。

不得借目录整理修复或改变上述行为。发现行为问题时记录独立任务，另行评审与验证。

## 2. 会话存储模块的边界

会话存储是一个独立的资料与执行状态模块。外部告诉它要查什么、做什么，它负责正确读取、提交与恢复；外部不需要理解表结构、正文来源、缓存和文件布局。

### 2.1 数据与职责归属

会话存储负责 session/message、History 持久实现、session transcript/accepted context、turn/queue/receipt 与会话 continuation 的持久操作，及其现有原子协作。SDK 定义 History 协议与纯折叠，Agent 负责执行决策；存储不调用模型，不发送远程消息。

模型配置、密钥、安全策略、MCP 配置、automation、delivery journal、usage statistics 不因共享 SQLite 就成为会话模块的一部分。其他模块访问自己的表可以留在各自存储 adapter；需要会话信息时调用 SessionQueries。跨模块现有事务若真实要求原子性，先明确所属业务操作，由受控内部协调实现；不能随意拆成多个 port 调用假称原子，也不能向业务层暴露 conn 维持旧耦合。

| 会话存储负责 | 外部模块负责 |
| --- | --- |
| session/message、顺序/状态/附件引用和正文解析 | UI 展示、流式交互与请求过期管理 |
| History 持久实现、accepted context、turn/queue/receipt、continuation 的原子操作 | Agent 的执行决策、模型调用和供应商格式转换 |
| 有效上下文的读取、替换提交及恢复 | 压缩策略、摘要生成、触发条件 |
| 数据完整性、并发冲突与持久状态恢复 | 远程发送、备份文件生成和启动编排 |

### 2.2 当前需要封装的调用面

以下来自当前 main 的实码调用面；worktree 已更换部分正文读取，但本轮仍须逐项核实并收敛，不能以 main 问题清单代替 worktree 完成证据。

| 位置 | 越界/耦合证据 | 应提供的边界 |
| --- | --- | --- |
| `ipc/agentProtocolIpc.ts` | 创建 SQLite History、直接更新 continuation_intents、查询 turns、传 conn 到 continuation 操作 | 会话 query、turn/continuation 具名操作、History port |
| `outbound/outboundAcceptor.ts` | 查询消息 sequence、turn 与 continuation，直接组织部分 DB transaction | continuation/accepted-turn 原子业务操作；外部只处理路由与投递 |
| `runtime/acceptedTurnContext.ts` | 读取 transcript、创建 History、核验接受输入并调用 acceptedTurnStorage | accepted context 的加载/验证/接受接口；模型转换留在 adapter |
| `runtime/invocationAssembler.ts` | 默认实例化 SqliteAgentHistory，依赖 AppDatabase | 注入 History/execution ports；安全存储使用独立 policy port |
| `turnCoordinatorStorage.ts` | 直接依赖数据库与 SQLite History | 模块工厂提供 coordinator 所需 storage adapter |
| `main.ts`、`sessionTranscriptStartup.ts` | 了解 History 恢复、消息残留、transcript reconciliation 的存储顺序 | storage recovery port 提供具名阶段及结果，main 保留启动编排 |
| 备份、capability、标题、remote/butler | 各自读取消息或依赖数据库宽 barrel | 查询/导出接口，禁止绕开归属和正文解析 |
| 旧 queries 设计 | 每个方法仍传 db、使用 Projected 等实现名 | 绑定实例的业务接口；db 与正文来源完全内置 |

## 3. 公共接口设计

完整方法签名、参数/返回类型、前置条件、原子性、幂等、错误和旧实现映射见[公共接口详细设计](./session-storage-public-interface-design.md)。本方案负责整体边界与流程，接口细则集中在该文件维护；明确保留的接线缺口按详细设计 §9 关闭后才算完成。

### 3.1 接口实例与能力划分

SDK执行所需契约（HistoryPort、ContextPort与其DTO/错误）由 `packages/agent-sdk` 定义；宿主会话查询/修改/执行协调/启动接口集中于 `electron/sessionStorage/contracts.ts` 并组合SDK端口。具体归属见[详细设计 §0](./session-storage-public-interface-design.md)。工厂绑定底层资源一次，业务方法不接收 db。拆成窄 ports，consumer 按实际需要注入，避免所有模块获得全部维护/写入权限。接口命名以业务语义统一：readMessage/readChatPage/readTurnContext/readRoutingInput/searchMessages 等；既有 getProjected* 仅列为内部映射起点。

```ts
// 示意：方法参数与返回值复用现有业务类型/同步异步语义
interface SessionStorage {
  readonly queries: SessionQueries
  readonly commands: SessionCommands
  readonly execution: SessionExecutionStore
  readonly contexts: ContextPort
  readonly recovery: SessionRecoveryPort
}
// 仅组合根调用具体工厂；内部绑定 db、History 与 spill/ledger 依赖
// createSqliteSessionStorage(resources): SessionStorage
// historyFor(scope): SDK HistoryPort / 确需使用的窄扩展协议
```

| port | 对外职责 | 禁止泄漏 |
| --- | --- | --- |
| SessionQueries | session 查询、消息单条/展示分页、路由、API context、搜索和 sequence 导出 | 表名、storage state 选择、L1/L2 与原始连接 |
| SessionCommands | session/消息业务修改、queued 操作、整会话删除 | 任意 patch/SQL、手动调整 revision/资格 |
| SessionExecutionStore | turn/queue/receipt、accepted context、transcript CAS、continuation 的具名原子操作；提供 coordinator adapter/History port | messages_json、History stream SQL、外部 transaction callback |
| ContextPort | 有效上下文读取与 replacement 提交，手动/自动共同使用 | baseline/replay 拼接、台账与 History 提交路径选择 |
| SessionRecoveryPort | 领域恢复/准入结果及外部执行协调协作；现有 History/residue/transcript 修复阶段封装在内部 | raw 扫表、任意修改恢复 fence |
| 内部 maintenance | 缓存、清理、spill GC 等既有受控操作 | 不作为普通业务 consumer 的默认依赖 |

宿主 public contracts 只依赖 domain/SDK port 类型，不依赖 sqliteStore、operations 或 runtime 具体类。返回普通 DTO、readonly snapshot 或内部不透明 fence；不得返回 statement、连接、文件 locator 或数据库行引用。保留现有同步方法的同步语义，不为“统一”引入额外 await 打断原子调用顺序。

组合根（main/专用 bootstrap）拥有资源初始化、port 注入与关闭；业务对象不自行打开 DB 或实例化具体 History。数据库配置等其他模块可共享连接资源，但只能在各自 adapter 中使用。flush/close 属于资源宿主，不进入消息查询契约。

可替换是对外契约设计方向：consumer 不依赖具体工厂实现；本次只封装现有 SQLite adapter，不预建多后端框架，不要求实现替换证明。

### 3.2 对外方法总览

以下名称为拟定业务接口；落地时复用现有参数/结果类型与行为。本表集中说明调用者能使用什么，内部映射和详细流程分别见后文。

| 接口 | 主要方法/操作 | 调用者得到什么 |
| --- | --- | --- |
| SessionQueries | readSession/listSessions、readMessage、readChatPage、readTurnContext、readRoutingInput、searchMessages、readExportPage | 会话/消息 DTO、分页结果、上下文消息；不含底层资源 |
| SessionCommands | renameSession、受限会话设置修改、editMessage、queued 编辑/移序/删除、deleteSession | 已提交业务结果或明确冲突/错误 |
| SessionExecutionStore | 接受输入、加载/核验 accepted context、turn 状态推进/checkpoint、执行认领、continuation 接受与恢复；提供 scoped HistoryPort | 稳定执行身份、回执、状态/版本及 SDK 协议对象 |
| ContextPort | readCurrent、commitReplacement | 有效上下文及不透明 fence、替换提交结果 |
| SessionRecoveryPort | 会话持久状态恢复与执行恢复协作 | 可读/可执行状态、未完成项与失败范围 |

方法按实际业务事务拆分，执行/恢复操作的最终签名须从现有调用面归纳。无需每个 consumer 获取整张接口表：UI adapter 只拿查询与所需命令，Agent 拿执行及上下文接口，bootstrap 才拿恢复能力。

### 3.3 查询接口与现有实现映射

第一步在绑定实例的 SessionQueries 内调用现有 canonical-aware 函数，保持业务参数和返回结构；公开方法移除 db 参数及 Projected 前缀。旧数据库函数仅作为内部实现或有期限的迁移适配，不转导出为最终公共接口。

| 查询职责 | 现有实现起点 | 接口约束 |
| --- | --- | --- |
| 单条消息 | `getProjectedMessage` | 保持不存在与正文不可用的区别 |
| 上下文与重试 | `getProjectedTurnContext`、`resolveProjectedRetryContext` | 保持 required-user、boundary、exclude 与状态筛选 |
| 消息分页/展示 | `getProjectedMessagesPageWithSequence`、`getProjectedChatMessagePage` | 保持 sequence cursor、排序与分页契约 |
| 路由/reuse-user | projected route reader 与 cutover fence reader | 保持 50 条窗口、附件/vision 和 await 后重验 |
| 搜索 | `getProjectedSearchCorpusPage`、`searchProjectedMessages` | 保持 profile/ownership、字面 LIKE、排序/limit 和批处理 |
| 备份/导出 | 既有 projected sequence page reader | 复用分页契约，不新增单独 raw 正文读法 |

不把这些接口压成一个带大量可选参数的 `getMessages(options)`；展示集合不能替代上下文或路由集合。

### 3.4 修改与执行接口

`commands.ts` 提供具名业务动作，包装现有正文编辑、queued 编辑/移序/删除等原子操作。只暴露已需要的操作，不创造一个任意 `patchMessage` 或 `saveSession` 接口。

metadata-only 与 body mutation 在类型和函数命名上明确分开。原函数同时处理二者时，可先增加受限包装，核实所有调用后再调整内部签名，不改变允许字段和权限。

turn 准备/checkpoint、队列认领与整会话删除已有专用事务，应保持专用模块或窄入口，不为目录对称而全部搬入 commands。

执行接口还必须封装 accepted context 接受/验证、turn 状态推进、receipt、transcript CAS 和 continuation。具名命令一次完成原本需要共同提交的状态变化；不能让外部先写 message、再写 turn、再写 receipt。具体操作签名从已有业务事务归纳，不引入任意 save/patch/transaction API。

### 3.5 上下文接口与恢复接口

ContextPort 统一提供 readCurrent/commitReplacement，具体契约与手动/自动调用流程集中于 §5.4。SessionRecoveryPort 返回领域恢复结果及执行准入状态；History/residue/transcript 的底层修复顺序封装在模块内部，main 只编排所需外部协调步骤。

### 3.6 存储无关性准则

以“未来移除 SQLite、改用 JSONL”作为**对外界面检查假设**，不作为本轮实现要求。当前仅包装和整理现有 SQLite 实现，不开发第二后端，不设计 JSONL 提交协议，不要求真实后端替换演练或性能等价证明。

公共接口应满足以下要求：

1. 参数/返回类型只表达业务身份、消息顺序、请求边界、提交结果与错误，不出现 AppDatabase、DatabaseSync、statement、表名、WAL、spill 文件布局等实现细节。
2. 分页契约明确方向、边界和顺序。现有 sequence 属于消息顺序语义，可以保留；不得要求它是 rowid/SQL offset。新增内部 token/fence 不透明，不由 consumer 拼接 generation/revision 或解释存储水位。
3. 修改接口以完整业务操作为单位，声明涉及状态、幂等/冲突条件、成功生效点和不确定提交处理。外部不能通过四次独立写入模拟一项必须原子的接受操作，也不能接收任意 transaction callback。
4. 启动恢复对外表达“存储是否可读、执行是否可恢复/准入、失败影响范围”等领域结果。原 History/投影/transcript 的恢复阶段先作为模块内部细节，外部执行协调器通过窄业务回调或结果协作；不把 SQLite 修复顺序固化为永久公共协议。
5. 同库其他模块通过业务接口获取会话信息，不依赖会话表 JOIN、外键级联或会话连接共享。如果现有跨域事务无法在本轮无行为变化地封装，具名记录过渡内部适配点，不冒称边界已完成。
6. 读写接口明确当前同步/异步语义；不为假设的文件后端全面改 Promise。未来不同实现如何满足此契约属于实现决策，本轮不作性能或阻塞方式保证。

检查方式是在接口评审中逐项询问：假设内部没有 SQLite，调用者是否仍能理解并调用这项能力？如果接口只是暴露内部表操作、SQL 事务或恢复步骤，应重新定义业务契约；不要求当前写出另一种实现来证明。

工厂替换是架构方向，不作为本轮实际完成项。mock/fake 可用于依赖注入单元测试，但不能证明任意后端兼容；验收仍聚焦调用面无底层类型泄漏、原子业务契约清晰以及现有 SQLite 行为保持。

## 4. 对外交互规则

### 4.1 调用者接入方式

| 外部模块 | 注入接口与调用方式 |
| --- | --- |
| IPC/capability | 注入所需 query/command；检查调用权限与 profile/session 归属，存储接口进一步核验持久身份；IPC 不写 SQL |
| Agent/SDK 宿主 | 注入 execution、ContextPort 及 scoped HistoryPort；使用原执行协议，不能自行实例化 SQLite adapter |
| 手动 compact / 自动 boundary | 共用 ContextPort；规划/摘要在计算层，提交规则在 port 内 |
| outbound/remote/butler | 调用接受/continuation 原子命令，再依据持久结果发送；发送不能进入可重试 DB callback |
| 标题/搜索/备份 | 注入对应查询/导出接口；备份负责文件生成，存储负责正确分页与正文解析 |
| 启动编排 | 通过 recovery 阶段结果决定后续步骤，不能伪造 succeeded 标记跳过准入 |

readContext/accepted snapshot 持久化后，业务拿到稳定身份与 DTO；任何 await 后的 mutation 按现有 fence/CAS 提交。存储负责完整性，adapter 负责供应商格式、外部授权和产品交互，两者不相互侵入。

### 4.2 权限、原子性与失败责任

IPC/capability 负责调用方权限、参数和外部 session/profile 归属约束；存储仍核验持久身份、所有权和执行状态。封装不能绕过既有确认与授权检查。

每个写接口声明提交范围、幂等键、冲突条件和成功生效点。存储拥有原子提交；模型调用、发送、文件导出和 UI 更新在外部执行。外部不得通过一串独立命令替代需要共同提交的业务操作。

错误区分不存在、正文不可用、并发冲突、写围栏和提交不确定，沿既有 IPC/SDK 语义映射。提交不确定不能当作“未写入”直接重试或继续旧上下文；恢复由对应存储协议处理。

### 4.3 类型与数据返回

内部提供明确的 `MessageSkeleton`，按实际消费者定义必需字段，不用 `content=''` 模拟骨架。它不继承完整 `Message` 后只省略一两个字段来暗示其他正文衍生字段一定存在；先根据现有 raw 数据结构逐项确定。

公共业务返回继续使用现有 `Message`/分页类型。新增类型默认放 Electron 内部，只有确实跨进程的契约才进入 `src/shared`。

错误处理集中复用既有类型/错误码；如果必须增加内部类型，出口映射保持现有语义。不得将正文不可用捕获为消息不存在或空字符串。L1/L2 来源只用于内部诊断，不新增产品字段。

## 5. 典型调用流程

### 5.1 渲染进程为会话改名

```text
Renderer 提交名称
  → 现有 session:update IPC
  → SessionCommands.renameSession(sessionId, name)
  → 内部原子保存名称与用户自定义标题标记
  → 返回更新后的 Session，沿现有通知/状态更新机制刷新 UI
```

renameSession 是建议的具名接口，内部复用现有 updateSession 行为。IPC 保留参数/权限校验；关联名称和标题标记的持久规则封装在命令内，renderer 不自行拼 metadata。现有 session:update 的其他修改字段分别映射到受限业务命令，不改 IPC DTO。备份调度等外部副作用沿原提交成功后的时机执行，不塞入可重试数据库事务。


### 5.2 Agent 构造下一条模型请求的读取链路

需要区分“新 turn 的初始上下文”与“同一 invocation 内的后续模型请求”。前者使用会话查询，后者使用 SDK 执行上下文构造能力；不能每次请求都从消息列表重新组装。

| 场景 | 调用边界 | 输入/输出及职责 |
| --- | --- | --- |
| 新 turn 首次请求 | accepted-context adapter → `SessionQueries.readTurnContext`，并复用既有 cutover/certification 路径 | 输入 session、boundarySequence、requiredUserMessageId、excludeMessageIds；返回当前既有消息契约，验证 accepted-input 指纹，保持资格与快照约束 |
| route/reuse-user 准备 | route adapter → queries 路由 reader 与 fence 接口 | 保持原窗口/排序、附件/vision；异步等待后由现有提交入口重验 fence |
| 工具结果后的下一次请求 | Agent/SDK → 既有 HistoryPort 和上下文折叠能力 | 在已接受的基础上下文上按本 invocation 已提交事件顺序处理工具结果、模型响应与 compaction；输出 canonical model messages |
| 重试/恢复后的请求 | 既有 retry/continuation adapter → 对应查询及 History 恢复入口 | 保持已有身份、边界和恢复规则；不默认重新获取整个最新会话覆盖已接受上下文 |

新 turn 的调用链：

```text
accepted-context adapter
  → SessionQueries.readTurnContext
  → 按消息骨架选择 boundary/required-user/exclude/order
  → 按既有资格及 storage state 解析 canonical/legacy 正文
  → 核验 accepted-input 与完整性
  → 现有 accepted context / invocation context 提交入口
  → SDK 上下文处理与模型适配
```

session transcript 的版本、幂等与执行准入继续由原协议处理；本次不切换其快照用途或删除 `messages_json`。已持久接受的 context 仍沿用原恢复路径，不把“统一查询”解释为强制每次重新读取最新消息。accepted 输入核验、transcript 状态与持久接受由 execution port 封装，adapter 不自行拼接三个底层 reader。

同 invocation 后续请求不能将 `getProjectedTurnContext` 返回结果与原始 History 简单拼接：History 中可能已经有基础 context、输入及 compaction snapshot，会造成重复消息或恢复被压缩的旧内容。沿用 SDK 已有折叠/替换语义；本次只明确和整理宿主 adapter 的调用边界，不另建一个模型上下文折叠器。

模型供应商格式转换仍在原 adapter 层，queries 不输出某一家供应商的请求结构。完整性失败沿现有错误路径阻止请求；同步快照、异步等待及提交前 CAS 保留原有时机，不新增跨模型请求持有的 DB transaction。

### 5.3 消息列表首次加载、刷新和翻页

消息列表走展示分页接口，不走 Agent 上下文接口，也不直接读取 session transcript 或 invocation History。

```text
Renderer 现有加载/刷新动作
  → 现有 chat:get-message-page / chat:get-display-message-page IPC
  → SessionQueries.readChatPage
  → 骨架按 sequence 选页 + 既有正文投影 reader
  → 主进程现有 display 映射（如该 IPC 需要）
  → 现有 renderer 状态合并与渲染
```

公共业务参数和返回 DTO 保持既有契约；接口绑定存储实例，不把 AppDatabase 传给外部调用者：

```ts
SessionQueries.readChatPage(
  sessionId: string,
  beforeSequence: number | null | undefined,
  limit?: number,
): ChatMessagePage

// 现有返回契约
// entries: Array<{ message: Message; sequence: number }>
// oldestSequence: number | null
// hasMoreBefore: boolean
```

| 动作 | 读取参数与处理 |
| --- | --- |
| 首次打开/重新获取最新页 | 不传 beforeSequence；按现有实现取最新页，再按 sequence 升序返回；默认 60 条，现有 limit 限制保持 |
| 向前加载更早消息 | 传上一页 oldestSequence，作为排他上界；按 hasMoreBefore 决定是否继续；不用 offset 推算 |
| 刷新最新消息 | 复用最新页查询；结果交给现有 renderer merge/replace 策略，不因刷新只返回一页而丢弃已加载旧页 |
| 刷新已加载旧消息/编辑状态 | 保留现有受影响消息或页面的重读策略；最新页刷新不保证覆盖旧页。只有实际存在单条重读需求时通过 SessionQueries.readMessage 接入，不在本次新增 renderer 调度 |
| 流式更新/终态同步 | 保留现有 push/本地状态更新机制与终态重读时机；存储 query 提供持久状态，不能替代尚未持久化的流式展示状态 |

`chat:get-display-message-page` 的 assistant 筛选和 display 映射继续放在现有展示 adapter，底层 pagination 的 oldestSequence/hasMoreBefore 保持原契约；不能过滤后用剩余 display 数量重新推算 cursor。备份使用 sequence 向后分页 reader，与 UI 的 beforeSequence 向前分页不是同一个契约。

跨 session 切换、异步响应过期和消息去重继续由 renderer 现有请求身份及状态管理处理；本次不新增消息列表同步协议。正文不可用时沿现有 IPC 错误路径处理，不能返回伪造空消息页掩盖失败。读过程中可使用现有 L1/L2 重建，不调用维护层强制刷新缓存或改变资格。

### 5.4 compact 与上下文窗口管理：统一读取与提交接口

**手动 compact、自动压缩及逻辑窗口切换必须调用同一套上下文读写接口。** 不仅共用 planner，也统一有效上下文读取、快照校验、提交结果及提交后生效规则。触发入口负责权限/触发条件与压缩策略选择，不自行读取 baseline、拼接 History 或写 compaction 台账。

ContextPort 契约归SDK context.ts，Electron contracts引用并由存储工厂实现和提供；`electron/runtime/sessionContextService.ts` 只协调触发条件、planner/摘要与结果使用，不实现或选择读写后端。port 内部使用存储 query、SDK 的纯折叠能力与既有持久提交适配器。接口以下为设计示意；内部类型不新增 IPC DTO 或持久格式。

```ts
type ContextScope =
  | { kind: 'session'; sessionId: string }
  | { kind: 'invocation'; sessionId: string; invocationId: string }

interface ContextSnapshot {
  readonly scope: ContextScope
  readonly messages: readonly CanonicalModelMessage[]
  readonly windowId: string
  readonly fence: ContextFence // 内部不透明 token，复用既有指纹/版本约束
}

interface ContextReplacement {
  readonly messages: readonly CanonicalModelMessage[]
  readonly windowId: string
  readonly evidence: ContextTransformationEvidence
}

interface ContextPort {
  readCurrent(scope: ContextScope): Promise<ContextSnapshot>
  commitReplacement(input: {
    base: ContextSnapshot
    operationId: string
    reason: 'manual-compact' | 'auto-compact' | 'window-transition'
    replacement: ContextReplacement
  }): Promise<ContextCommitResult>
}
```

`CanonicalModelMessage` 复用 SDK 现有模型类型；统一 envelope 内保留现有 checkpoint/shadow、required-user、指纹及 projection 所需证据，必要时使用内部判别联合，不能只保留文本而丢工具/附件或压缩来源身份。若现有 surface 与 canonical model 的转换无法无损表达某字段，应在接口设计阶段保留相应结构，禁止有损转换后宣称行为等价。

`ContextFence` 与 evidence 仅能由有效读取/既有 planner 产生，按 scope 判别内部类型；不能接受调用者任意构造一个 fingerprint 作为可信快照。reason 表示触发原因，不用于选择不同持久路径；内部适配器按执行 scope 和已有提交 owner 绑定。

#### 5.4.1 两个入口的统一调用链

```text
手动 IPC / 自动 preflight 或 boundary / 逻辑窗口切换
  → ContextPort.readCurrent(scope)
  → 既有策略与共用 planner/摘要能力，生成候选 replacement
  → ContextPort.commitReplacement(base, operationId, reason, replacement)
  → 根据统一提交结果更新运行状态或通知 UI
```

- 手动入口保留 trusted sender、session 归属与原 session 锁/busy 限制，使用 session scope。
- 自动入口在已执行到安全边界的 invocation 中使用 invocation scope，保留原 SDK writer/version 和 required-user 约束。
- 摘要/模型调用在存储事务外进行；readCurrent 的快照不能跨 await 被默认认为仍有效。
- 两个入口都不直接调用原 `appendCompactionTransaction` 或追加 `transcript-compacted`；这些操作只能在统一 port 的受控内部适配器中完成。

#### 5.4.2 readCurrent 的统一语义

返回“下一条模型请求实际使用的有效上下文”，包含已有压缩结果，不返回 UI 消息页或未经处理的全量消息。

| scope | 内部实现起点 | 公共行为 |
| --- | --- | --- |
| 空闲 session | API context query、surface builder、已提交 compaction replay/shadow | 返回已应用 checkpoint/shadow 的有效消息、逻辑 windowId 和来源 fence |
| 运行中 invocation | SDK 当前执行 context、History、compaction 替换与恢复规则 | 返回包含本次工具结果及当前压缩边界的有效消息，并绑定 invocation 身份与版本 |

读取选择与转换在内部适配，不要求 invocation 再从数据库消息列表重建，也不允许 session scope 忽略既有压缩。fence 的来源校验沿用完整现有规则，不强制把两类快照简化成同一个整数版本。

#### 5.4.3 commitReplacement 的统一语义

统一接口负责以下步骤和结果：

1. 核验 scope、消息/工具/required-user 身份、输出预算与 planner evidence，沿用既有校验规则。
2. 重验 base fence 与当前执行权限；发生并发变化返回 stale/busy，不写入候选，不切换窗口。
3. 内部适配器沿既有协议提交。session adapter 保留手动 compaction 的 start/summary/end；invocation adapter 保留 SDK `transcript-compacted` 与 commitProjection 顺序，不增加第二个写 owner。
4. 对外只有 `committed` 才允许使用新 messages/window。无收益等不修改结果沿用原状态，入口映射到现有 IPC/SDK 契约。
5. 提交阶段部分完成或不确定时使用显式结果或既有类型化异常传播，阻止下一模型请求。不能折叠成普通 failed 并继续旧 context；恢复沿原协议读取已提交事实。

结果契约必须区分 committed、未写入的 stale/busy/no-op/uncompressible，以及提交不确定/投影失败。实现时映射现有错误，不掩盖已发生的持久写入。operationId 对应现有 request/compaction 身份；幂等与重试能力严格按原协议声明，不能因统一接口而虚构跨两种后端的 exactly-once 保证。

纯 surface builder 若依赖模型格式/附件素材，可通过内部受限构建依赖协作；不能让外部 callback 接收 conn 或自行决定读写来源。

原 SDK 内部若仍直接 append replacement，应通过最小内部依赖注入/提交协调钩子接入同一契约，保留原 writer 持有顺序及恢复行为。adapter 不得再次调用触发它的 SDK boundary callback，避免递归或重复写事件。验收不能只做宿主 facade 包装却让 SDK 自动压缩继续绕过接口。

#### 5.4.4 提交后生效与窗口概念

手动入口在 committed 后通知 compaction marker，后续请求经 readCurrent 重放新 context。自动入口在 committed 后接收已提交的有效 messages/window，替换运行内状态；持久提交由 port 完成，caller 的内存替换与通知不得再写一笔压缩记录。重启依靠现有持久协议恢复，不依赖上次内存回调是否执行。

模型 token 容量与逻辑 windowId 必须分开：更改模型/预算仍走原 session 配置接口；下一请求经 readCurrent 获取 context，planner 判断是否需要 replacement，需要时调用同一 commitReplacement。预算变化本身不自动创建逻辑窗口，也不覆盖正在执行的固定 route/accepted 配置。

禁止修改 `messages.content` 来压缩上下文或删除聊天历史；session transcript 的既有版本/准入用途不变。手动选择历史窗口若没有现有产品入口，另行立项。

本轮统一的是接口和调用所有权，不迁移现有台账/History 数据。不同内部提交协议属于暂存的实现差异，不再泄漏给手动/自动调用者。若基线缺少手动 compact 接线，记录具体待办；无损类型转换、SDK hook 接入与旧语义保持必须验证后才能标完成。

## 6. 内部实现组织

### 6.1 目录与依赖方向

建议建立 `electron/sessionStorage/`，先用窄入口包装现有函数，再逐步移动实现。以下目录和接口均为建议，尚未实现；可根据实际依赖调整文件粒度。

```text
electron/sessionStorage/
  queries.ts                   # 普通业务读取入口
  commands.ts                  # 普通业务修改入口
  contracts.ts                 # Electron 内部接口与类型
  internal/
    messageSelectors.ts        # 骨架筛选、排序和窗口
    messageBodyResolver.ts     # 正文来源与严格解析
    queryImplementations.ts    # 组合 selector/resolver
    writeAuthority.ts          # 既有正文写权威规则
    certification.ts           # 资格与快照 fence
    historyMessageMirror.ts    # History 事务内消息镜像
  maintenance/
    contentCleanup.ts          # 既有清理协议，仅供受控内部调用
    projectionCache.ts         # 既有缓存维护
```

依赖方向：业务 consumer → 注入的 public ports → 内部实现 → 数据库操作、History 与 spill。`queries.ts`/`commands.ts` 实现绑定后的接口，业务只导入 contracts，不依赖实现文件。maintenance 使用内部能力，普通 query 不依赖 maintenance。

SDK拥有执行端口、上下文DTO和宿主无关规则；不依赖Electron定义的接口。SDK 折叠器和 validator 保留在 `packages/agent-sdk`，SQLite/schema/transaction 保留在 `electron/database`，spill 生命周期保留在 `electron/storage`。本次不以“统一存储”为理由移动所有底层文件。

`internal/historyMessageMirror` 是既有 History 事务的窄集成点，不必经过 commands 二次调用；必须避免 `sqliteAgentHistory` 与正文 resolver 形成循环依赖。叶子模块直接依赖具体底层类型/函数，避免通过宽 barrel 反向导入。

### 6.2 查询内部协作

selector 负责选出正确骨架；resolver 负责按身份和 storage state 解析正文。拆分时保留目前的同快照读取和批量能力，不逐消息重放整个 session，也不改变缓存使用策略。

现有正文读取入口保留临时适配函数供旧 import 使用；业务 consumer 迁移完再删除适配。禁止为了减少接口数让纯骨架读取也加载正文。

### 6.3 事务参与和写入实现

为每个修改入口注明：事务由谁开启、是否允许既有事务调用、参与哪些原子写入、何时检查 fence。事务参与函数使用明确命名或内部类型标记，并由少数受控调用点调用；不要导出可随意使用的通用 transaction callback。

从 `sqliteAgentHistory.ts` 提取消息镜像时，应原样保留 SQL、校验顺序和失败传播，仍由原 append 事务执行。不得在 facade 外先写 History，再单独写镜像；不得在重试事务内增加远程发送或文件删除。

### 6.4 资格、缓存与维护隔离

将 `sessionStorageCutover.ts` 按既有职责拆分：

- 读开关及资格认证放入 certification。
- 路由/API 读 fence 由查询入口使用，保留完整身份和重验契约。
- write-stopped/pending/complete 清理函数移入 maintenance。
- cache refresh 移入 projection cache 维护模块。

这里只移动和封装代码，不新增清理 caller、worker、通用迁移 runner 或持久配置。普通业务层不能通过 queries/commands 获得清列入口。

完整性校验尽量保留单一实现；不同消费者可以调用同一 validator，但不把展示折叠替代 execution recovery 校验。不得为了减少调用次数缓存一个无限期有效的“已验证”布尔值。

### 6.5 依赖护栏

新增 `scripts/check-session-storage-boundary.mjs`（待实现），检查外部业务模块不得依赖会话存储内部实现、会话 raw reader/writer、SQLite History 具体类或会话连接操作。覆盖正文、执行状态、accepted context、continuation 和 recovery，不能只扫描 messages.content。其他数据域的 SQLite adapter 使用按所有权记录的例外，不一律禁止整个应用的数据库访问。优先使用 TypeScript AST，识别 import、re-export、require、可静态解析的 dynamic import 与路径别名，防止通过 `database/index.ts` barrel 绕过。

先生成当前违规/例外基线并禁止增加，逐 consumer 收敛后缩小例外。例外按文件和符号记录用途：数据库内部、事务 participant、维护模块和测试；不能整个 `electron/runtime/**` 放行。

骨架读取允许经明确入口使用，不能按函数名含 `getMessage` 一律禁止。护栏增加 barrel/alias 绕过的反例测试。静态检查不承担任意 SQL 的语义证明，配合业务层不持 raw connection 的约束执行。

## 7. 分步实施

实施前先关闭[详细设计 §9](./session-storage-public-interface-design.md)全部收口项，尤其是ContextPort无损DTO/提交hook、continuation接受事务和恢复回调。当前只可进行S0只读盘点与设计细化；S1–S4接口接入暂不启动。当前文档中的签名是候选设计，不能作为已定稿实现契约，也不能据此认定模块边界已完整收敛。

| 阶段 | 改动 | 完成条件 |
| --- | --- | --- |
| S0 基线盘点 | 列出所有会话 reader/writer、consumer、事务 owner、执行/恢复与维护入口及现有测试，区分同库其他数据域 | 每个接口职责和允许调用者明确；未解决依赖记录在案 |
| S1 公共查询入口 | 区分SDK执行契约与宿主业务契约，定义无 db 的窄 ports 与组合根工厂，包装现有 reader，逐 consumer 注入，加入依赖护栏 | 消费者行为/类型不变，不新增 raw 正文访问 |
| S2 查询内部拆分 | selector/resolver/query 组合分离，明确骨架类型 | 无循环依赖，现有分页/路由/search/上下文测试通过，批量能力保持 |
| S3 修改边界 | commands/execution 原子操作封装、metadata/body 分界、事务 participant 提取；accepted/continuation/coordinator 通过 ports；上下文统一 ContextPort | 事务 owner 明确，两个入口无旁路读取/提交，故障回滚与 CAS 回归通过，无额外提交，原跨状态原子性保持 |
| S4 维护隔离 | recovery/启动 port、certification/cleanup/cache 拆分，完成注入，移除旧适配和内部转导出 | 业务入口不暴露清理能力，旧 import 清零，所有例外具名 |

每步按消费者或职责拆小 PR。先改 import 与接口边界，再移动实现，不在同一 PR 大规模重命名、重排 SQL 和改变错误处理。已迁移模块不再从宽 `database` barrel 获取正文能力。

### 7.1 关键流程接入要求

S1 盘点手动/自动的有效上下文读取；S3 将两个入口及逻辑窗口替换接入相同 ContextPort，内部封装既有提交 owner；覆盖 stale/busy、重启 shadow、窗口预算和 projection-error 回归。S1 必须分别迁移 accepted-context、route/reuse-user、聊天分页 IPC 与备份 adapter 的依赖注入及调用，不能仅提供 queries 文件却保留 consumer 绕过。S2 拆分 selector/resolver 后复验两种查询各自的选择语义。

验收增加明确场景：首次模型请求的 boundary/exclude/required-user 与输入指纹不变；工具后续请求不重复基础 context、工具结果与 compaction；聊天首次加载/刷新/向前翻页 cursor 不变；display 过滤不改变分页边界；已加载旧页保留与流式更新不回退。优先引用既有真实 consumer/SDK/renderer 用例，仅对缺口补测试，不改变持久数据和 IPC 格式。

## 8. 验证与验收

验证范围仅为代码结构及行为等价，不做数据迁移或发布验收。保留并运行现有 fixture/reopen 测试作为回归，它们不代表对真实 profile 执行迁移。

- 查询：单条/分页、API context、路由/reuse-user、search、backup 的现有 consumer 测试。
- 完整性：legacy/dual-write/canonical-only 混合态，L1/L2、spill 故障、History/owner/allocator 故障。
- 修改：镜像/队列/删除的事务回滚，异步 mutation CAS，pending/complete 写围栏。
- 结构：边界脚本正反例、模块循环依赖及新增骨架类型的编译检查。

纯 import/文件移动优先复用已有测试；类型边界或新护栏补充针对性测试，不建立一套镜像实现的重复测试。每步 focused Vitest 通过后执行仓库要求的 `npm test` 与相关 typecheck；最终执行 Electron build、i18n 检查和 `git diff --check`。

搜索、API context 和展示复用既有性能样本与门槛；只在 reader 拆分或缓存调用方式可能影响性能时复测。不得因为新增层而每条消息重复初始化 History 或全量 fold。

最终验收：按 §3.6 审查公共契约的存储无关性；Agent 上下文、聊天分页与 continuation 的 consumer 依赖接口而非实现，不接收底层资源。依赖注入测试按实际需要补充，不要求第二后端或实际替换演练。SQL/真实 SQLite 测试保留，mock 不能替代事务故障验收。业务 consumer 依赖明确入口；骨架与正文类型可区分；每个修改入口有明确事务 owner；maintenance 不被普通业务接口导出；旧适配清零或留有具体未完成项；现有行为回归通过。schema、持久格式、IPC 与发布流程均无改动。

## 9. 风险与收益判断

主要风险是 facade 变成巨大中转类、拆分导致循环依赖、接口隐藏事务、类型收紧意外改变错误行为。通过窄函数入口、叶子模块依赖、原样提取事务参与代码和分步测试控制。

收益以职责与依赖是否清晰衡量：修改正文解析时无需重接业务 consumer；搜索/路由选择规则有自己的位置；修改权限和事务边界可以从接口定位；新增 consumer 无需理解 cache/spill/清理细节；手动和自动压缩使用同一读写契约，不直接依赖不同持久协议。文件数量和抽象层数不作为收益指标。

后续若要做数据迁移、兼容 manifest、安装包演练、清理恢复写入或物理拆表，应另立方案。本方案完成不代表这些事项已实施或获得放行。
