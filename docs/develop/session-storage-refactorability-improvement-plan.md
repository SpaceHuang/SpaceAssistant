# 会话存储代码结构与接口优化方案

| 字段 | 内容 |
| --- | --- |
| 状态 | v34 · 原S0–S4验收通过；评审4项P1修复及最终门禁通过 |
| 日期 | 2026-10-07 |
| 目标 | 在现有实现上整理模块职责、明确读写接口与依赖方向，降低后续代码重构的影响范围 |
| 实现基线 | worktree起点 main HEAD f2cec895；当前代码改动需按S0盘点后逐阶段复核，不视作阶段验收 |
| 关联设计 | [技术方案](./session-storage-refactor-technical-design.md)、[迁移计划](./session-storage-refactor-migration-plan.md)；当前实码核对及评审基线见详细设计；旧worktree说明仅为历史上下文 |
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

## 当前执行状态（2026-10-07）

原S0与设计门槛、S1、S2、S3、S4验收均通过。2026-10-08评审指出的4项P1均已按TDD修复：evidence/candidate绑定、shutdown备份查询生命周期、SQLite ledger失败门禁、SDK纯identity实现与包闭包隔离。全量测试、类型检查、SDK boundary/closure、i18n、build及最终diff检查均通过，详见本节收口记录。

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

以下调用面按当前main核对；本轮须逐项收敛，历史worktree与旧版行号不能作为已完成证据。

| 位置 | 越界/耦合证据 | 应提供的边界 |
| --- | --- | --- |
| `ipc/agentProtocolIpc.ts` | 创建 SQLite History、直接更新 continuation_intents、查询 turns、传 conn 到 continuation 操作 | 会话 query、turn/continuation 具名操作、History port |
| `outbound/outboundAcceptor.ts` | 查询消息 sequence、turn 与 continuation，直接组织部分 DB transaction | continuation/accepted-turn 原子业务操作；外部只处理路由与投递 |
| `runtime/acceptedTurnContext.ts` | 读取 transcript、创建 History、核验接受输入并调用 acceptedTurnStorage | accepted context 的加载/验证/接受接口；模型转换留在 adapter |
| `runtime/invocationAssembler.ts` | 默认实例化 SqliteAgentHistory，依赖 AppDatabase | 注入 History/execution ports；安全存储使用独立 policy port |
| `turnCoordinatorStorage.ts` | 直接依赖数据库与 SQLite History | 模块工厂提供 coordinator 所需 storage adapter |
| `main.ts`、`sessionTranscriptStartup.ts` | 了解 History 恢复、消息残留、transcript reconciliation 的存储顺序 | recovery.recover() 内部封装既有恢复顺序并返回领域报告；main 负责资源初始化、窄回调绑定及其他数据域启动编排 |
| 备份、capability、标题、remote/butler | 各自读取消息或依赖数据库宽 barrel | 查询/导出接口，禁止绕开归属和正文解析 |
| 旧 queries 设计 | 每个方法仍传 db、使用 Projected 等实现名 | 绑定实例的业务接口；db 与正文来源完全内置 |

## 3. 公共接口设计

完整方法签名、参数/返回类型、前置条件、原子性、幂等、错误和旧实现映射见[公共接口详细设计](./session-storage-public-interface-design.md)。本方案负责整体边界与流程，接口细则集中在该文件维护。两份文档有差异时，以公共接口详细设计为准；方法签名、事务范围、类型归属、兼容例外和收口状态不在本计划独立定义。明确保留的接线缺口按详细设计 §9 关闭后才算完成。

### 3.1 接口实例与能力划分

SDK执行所需契约（HistoryPort、ContextPort与其DTO/错误）由 `packages/agent-sdk` 定义；宿主会话查询/修改/执行协调/启动接口集中于 `electron/sessionStorage/contracts.ts` 并组合SDK端口。具体归属见[详细设计 §0](./session-storage-public-interface-design.md)。组合根通过所选实现工厂绑定资源并创建实例；公共契约不指定后端。业务方法不接收 db。拆成窄 ports，consumer 按实际需要注入，避免所有模块获得全部维护/写入权限。接口命名以业务语义统一：readMessage/readChatPage/readTurnContext/readRoutingInput/searchMessages 等；既有 getProjected* 仅列为内部映射起点。

```ts
// 示意：方法参数与返回值复用现有业务类型/同步异步语义
interface SessionStorage {
  readonly queries: SessionQueries
  readonly commands: SessionCommands
  readonly execution: SessionExecutionStore
  readonly contexts: ContextPort
  readonly recovery: SessionRecoveryPort
}
// 架构：组合根调用所选实现工厂，得到SessionStorage并注入窄ports。
// 本轮装配示例：所选工厂分别提供SessionStorage与StorageLifecycleControl。
// lifecycle仅交给bootstrap/资源宿主，不注入业务consumer；返回结构由装配层确定。
// db、History与spill/ledger仅在当前适配器内部绑定，不是公共契约。
// execution.historyFor(scope): SDK HistoryPort，禁止返回具体adapter或任意扩展method。
// 完成结果/恢复查询使用execution/recovery的具名业务方法。
```

| port | 对外职责 | 禁止泄漏 |
| --- | --- | --- |
| SessionQueries | session 查询、消息单条/展示分页、路由、API context、搜索、sequence 导出及 continuationSources.inspect | 表名、storage state 选择、L1/L2 与原始连接 |
| SessionCommands | session/消息业务修改、queued 操作、整会话删除 | 任意 patch/SQL、手动调整 revision/资格 |
| SessionExecutionStore | turn/queue/receipt、accepted context、transcript CAS、continuation 的具名原子操作；提供 coordinator adapter/History port | messages_json、History stream SQL、外部 transaction callback |
| ContextPort | 有效上下文读取与 replacement 提交，手动/自动共同使用 | baseline/replay 拼接、台账与 History 提交路径选择 |
| SessionRecoveryPort | 领域恢复/准入结果及外部执行协调协作；现有 History/residue/transcript 修复阶段封装在内部 | raw 扫表、任意修改恢复 fence |
| StorageLifecycleControl（宿主独享） | initialize、维护调度/暂停/续跑/观测、stop；内部 maintenance 保留缓存、清理与 spill GC | 只给资源宿主，不作为普通业务 consumer 的默认依赖 |

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
| SessionRecoveryPort | recover()、inspectReadiness；工厂绑定 restoreTurn/recover 协作 | 领域恢复报告、当前读/执行准入状态；实际操作仍核验 fence/CAS |
| StorageLifecycleControl（单独返回） | initialize、requestMaintenance、allowBackgroundWork、pauseMaintenance、resumeMaintenance、inspectMaintenance、stop | 宿主维护诊断与退出协作，不是业务读写或删除许可 |

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

执行接口还必须封装 accepted context 接受/验证、turn 状态推进、receipt、transcript CAS 和 continuation。continuations、continuationIntents、continuationLaunch 分别承接续跑记录、接受回执、启动原子协作；源枚举及边界证据由 queries.continuationSources.inspect 提供。具体契约与普通 turn／真实 continuation target 区分见详细设计 §5.4–§5.7。具名命令一次完成原本需要共同提交的状态变化；不能让外部先写 message、再写 turn、再写 receipt。具体操作签名从已有业务事务归纳，不引入任意 save/patch/transaction API。

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
| 启动编排 | 工厂绑定同步 restoreTurn/recover 窄回调，调用 recovery.recover() 并依据领域报告编排外部步骤；不能驱动内部修复阶段或伪造 succeeded |

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
  → execution.acceptPrepared / loadAcceptedMessages
  → 内部按持久 turn 的 boundary/required-user/exclude/order 选择材料
  → 内部沿既有正文解析规则核验 accepted-input 与完整性
  → 原 accepted context / invocation context 协议（存储内部）
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
const page: ChatPage = queries.readChatPage({ sessionId, beforeSequence, limit })

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

接口具体类型不再在总方案重复定义；以[详细设计 §6](./session-storage-public-interface-design.md)的ContextFrame/Item、可信注册接口、InvocationContextBinding及单writer提交hook为准。preflight与boundary的冻结运行帧不同，boundary必须含本轮已提交response。


`CanonicalModelMessage` 复用 SDK 现有模型类型；统一 envelope 内保留现有 checkpoint/shadow、required-user、指纹及 projection 所需证据，必要时使用内部判别联合，不能只保留文本而丢工具/附件或压缩来源身份。若现有 surface 与 canonical model 的转换无法无损表达某字段，应在接口设计阶段保留相应结构，禁止有损转换后宣称行为等价。

`ContextFence` 与 evidence 仅能由有效读取/既有 planner 产生，按 scope 判别内部类型；不能接受调用者任意构造一个 fingerprint 作为可信快照。reason 表示触发原因，不用于选择不同持久路径；内部适配器按执行 scope 和已有提交 owner 绑定。

#### 5.4.1 两个入口的统一调用链

```text
手动 IPC / 自动 preflight 或 boundary / 逻辑窗口切换
  → ContextPort.readCurrent(scope)
  → 既有策略与共用 planner/摘要能力，生成候选 replacement
  → 可信 planner adapter 注册 ContextCandidate（base/output/evidence）
  → ContextPort.commitReplacement({ operationId, reason, candidate })
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
| 运行中 invocation | SDK 当前执行 context、History、compaction 替换与恢复规则 | 返回 SDK 当前安全阶段的冻结 frame，仅包含已提交工具结果；boundary frame 包含本轮已提交 response，绑定 invocation 身份、epoch 与 History 版本 |

读取选择与转换在内部适配，不要求 invocation 再从数据库消息列表重建，也不允许 session scope 忽略既有压缩。fence 的来源校验沿用完整现有规则，不强制把两类快照简化成同一个整数版本。

#### 5.4.3 commitReplacement 的统一语义

统一接口负责以下步骤和结果：

1. 核验 scope、消息/工具/required-user 身份、输出预算与 planner evidence，沿用既有校验规则。
2. 重验 base fence 与当前执行权限；发生并发变化返回 stale/busy，不写入候选，不切换窗口。
3. 内部适配器沿既有协议提交。session adapter 保留手动 compaction 的 start/summary/end；invocation adapter 保留 SDK `transcript-compacted` 与 commitProjection 顺序，不增加第二个写 owner。
4. 有 History 的持久提交路径对外只有 `committed` 才允许使用新 messages/window；无 History legacy adapter 的仅内存结果按详细设计 §6.3 保留原行为，不冒称持久提交。无收益等不修改结果沿用原状态，入口映射到现有 IPC/SDK 契约。
5. 提交阶段部分完成或不确定时使用显式结果或既有类型化异常传播，阻止下一模型请求。不能折叠成普通 failed 并继续旧 context；恢复沿原协议读取已提交事实。

结果契约必须区分 committed、未写入的 stale/busy/no-op/uncompressible，以及提交不确定/投影失败。实现时映射现有错误，不掩盖已发生的持久写入。operationId 对应现有 request/compaction 身份；幂等与重试能力严格按原协议声明，不能因统一接口而虚构跨两种后端的 exactly-once 保证。

纯 surface builder 若依赖模型格式/附件素材，可通过内部受限构建依赖协作；不能让外部 callback 接收 conn 或自行决定读写来源。

原 SDK 内部若仍直接 append replacement，应通过最小内部依赖注入/提交协调钩子接入同一契约，保留原 writer 持有顺序及恢复行为。adapter 不得再次调用触发它的 SDK boundary callback，避免递归或重复写事件。验收不能只做宿主 facade 包装却让 SDK 自动压缩继续绕过接口。有 History 的路径完成同 port 接入；原无 History、仅内存替换的 boundary 保留具名 legacy adapter，不强制持久化、不返回持久 committed/receipt，其退出单独记录（详细设计 §6.3）。

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

### 6.5 加载、后台维护与退出

参考[Spill索引与回填方案](./spill-reference-index-and-backfill-plan.md)，维护封装不能只隐藏函数，也必须提供宿主启动、ready触发、暂停续跑和停止协作。具体StorageLifecycleControl契约见[详细设计 §7.4](./session-storage-public-interface-design.md)：只给资源宿主，不注入普通业务；分离执行恢复、durable待办回收、策略retention和派生索引回填。

引用索引双写/游标及GC安全判据保持内部；deleteSession逻辑提交不等于物理文件已删除。MCP/日志/usage维护由各自模块负责。此处只补接口适配，不实施索引migration、worker、每日策略或新的生产清理调度；生命周期契约及owner/当前启动调用点映射按详细设计 §7.4、§9 的收口状态执行。

### 6.6 依赖护栏

已新增 `scripts/check-session-storage-boundary.mjs` 和精确例外基线。当前检查覆盖静态 import/re-export/require/dynamic import、路径别名与可解析barrel；基线目前仍有51条既存例外，目标 consumer 尚未全部迁移。检查不得只覆盖 `messages.content`；其他数据域的 SQLite adapter 按所有权保留具名例外，不一律禁止整个应用的数据库访问。

先生成当前违规/例外基线并禁止增加，逐 consumer 收敛后缩小例外。例外按文件和符号记录用途：数据库内部、事务 participant、维护模块和测试；不能整个 `electron/runtime/**` 放行。

骨架读取允许经明确入口使用，不能按函数名含 `getMessage` 一律禁止。护栏增加 barrel/alias 绕过的反例测试。静态检查不承担任意 SQL 的语义证明，配合业务层不持 raw connection 的约束执行。

## 7. 分步实施

严格按本节阶段顺序推进。详细设计§9门槛已关闭；S0完成后逐阶段验收，不跳阶段；测试通过只证明对应行为，不自动关闭更大的架构门禁。设计收口状态以详细设计§9.1为准，阶段实现状态以下表和各阶段验收记录为准。

| 阶段 | 改动 | 完成条件 |
| --- | --- | --- |
| S0 基线盘点 | 列出所有会话 reader/writer、consumer、事务 owner、执行/恢复与维护入口及现有测试，区分同库其他数据域 | 每个接口职责和允许调用者明确；未解决依赖记录在案 |
| S1 公共查询入口 | 区分SDK执行契约与宿主业务契约，定义无 db 的窄 ports 与组合根工厂，包装现有 reader，逐 consumer 注入，加入依赖护栏 | 消费者行为/类型不变，不新增 raw 正文访问 |
| S2 查询内部拆分 | selector/resolver/query 组合分离，明确骨架类型 | 无循环依赖，现有分页/路由/search/上下文测试通过，批量能力保持 |
| S3 修改边界 | commands/execution 原子操作封装、metadata/body 分界、事务 participant 提取；accepted/continuation/coordinator 通过 ports；上下文统一 ContextPort | 事务 owner 明确，两个入口无旁路读取/提交，故障回滚与 CAS 回归通过，无额外提交，原跨状态原子性保持 |
| S4 维护隔离 | recovery/启动 port 与宿主独享 lifecycle 接线、certification/cleanup/cache 拆分，完成注入，移除已完成迁移的旧适配和内部转导出；不实施新 worker/索引/调度策略 | 业务入口不暴露清理能力，资源宿主按 stop→quiescent→flush/close 退出；目标迁移范围旧 import 清零，保留的无History legacy adapter及其他例外具名 |

### S0 基线盘点（当前隔离 worktree）

下表是S0实施前基线快照，记录当时职责、事务owner、consumer与测试；表内“当前”“待迁移”“未接线”等字样均指S0时点，不代表现状或阶段验收。后续状态以各阶段追加记录及文首“当前执行状态”为准。测试文件列出代表性真实行为测试，不穷举纯helper用例。

| 能力 | 当前 owner / 实现 | Consumer 与允许入口 | 主要现有测试 | S0 发现 |
| --- | --- | --- | --- | --- |
| SessionQueries：消息/会话读取、分页、路由、搜索、导出 | `sessionStorage/queries.ts` 绑定 database 与 transcript projection；正文解析仍由 `runtime/sessionTranscriptProjection.ts` / `internal/messageBodyResolver.ts` 承担 | 已注入/应注入的业务 consumer：`ipc/agentProtocolIpc.ts`（聊天/路由）、`ipc/sessionIpc.ts`、`ipc/searchIpc.ts`、`ipc/ipcShared.ts`（backup）、`appIpc.ts`、`capabilities/handlers/session.ts`、`claudeStreamHandlers.ts`、`butler/butlerInvoker.ts`、`remote/imRemoteAgent.ts`、`feishu/feishuRemoteAgent.ts`、`wechat/weChatRemoteAgent.ts`；存储owner内部与迁移/审计/cleanup工具不算业务consumer | `sessionStorage/sessionStorage.test.ts`、`runtime/sessionTranscriptProjection.test.ts`、`capabilities/handlers/session.test.ts`、`sessionBackupManager.test.ts`、`appIpc.search.test.ts`、`ipc/agentProtocolIpc.updateQueuedMessage.test.ts` | S1 consumer注入已验收；S2按计划拆分selector/resolver/query composition并复验选择与批量语义；migration/audit/retention和`hostedTurnHandoff.ts`仍直接使用内部读取能力，按owner资格/例外继续纳入后续阶段复核 |
| SessionCommands：受限 session/message/queue 修改 | `sessionStorage/commands.ts`；底层现有业务操作仍由 database operations/内容写权威拥有其事务 | `ipc/sessionIpc.ts`、`sessionTitleSuggest.ts`、`feishu/wechatSessionResolver.ts`、`remoteSessionActivity.ts`及`appIpc.ts`；消息正文提交仍由 execution/checkpoint与内容写权威负责 | `sessionStorage/sessionStorage.test.ts`、`appIpc.sessionUpdate.test.ts`、`sessionTitleSuggest.manualTitle.test.ts`、`appIpc.file.test.ts`、`database/operations.test.ts` | 正文编辑与terminal scrollback分属受限命令，settings/兼容metadata merge分开且保护存储owner字段；真实SQLite/IPC/accepted/coordinator复核7个测试文件175项通过，storage边界护栏18条既有例外无新增，`git diff --check`通过。execution config/accepted/coordinator SQL只由具名ports封装；IPC保留业务路由/credentials/产品策略。metadata/body行为子项完成，S3总事务participant审计仍开放 |
| Session identity/config/workDir 资料 | session记录在database operations；workDir配置与绑定规则在`workDirManager.ts`、`workDirBinding.ts`、`turnExecutionConfig.ts`，权限策略仍由各owner持有 | `workDirSnapshot.ts`、`remoteSessionExecutors.ts`、`remoteSessionRegisteredTools.ts`、`weChatToolExecutor.ts`、`floatingNotificationManager.ts`、`remote/imSessionResolver.ts`、`runtime/invocationAssembler.ts`、`main.ts`直接读取session；workDir绑定/模型配置写session | `workDirManager.test.ts`、`workDirBinding.test.ts`、`workDirSnapshot.test.ts`、`tools/remoteSessionExecutors.test.ts`、`floatingNotificationManager.test.ts`、`turnExecutionConfig.test.ts` | 需把“取Session DTO/受限更新”改为commands/query与“业务owner保留workDir/权限/模型决策”分开。`invocationAssembler`需要多个policy/metadata字段，不能移入SDK或让普通consumer拿全权限 |
| Turn coordinator / accepted context | 当前组合在 `sessionStorage/coordinator.ts`、`execution.ts`；底层原子提交仍由 `turnCoordinatorStorage`协议及 `database/acceptedTurnStorage.ts` 实现 | `main.ts`/`ipc/agentProtocolIpc.ts`准备和驱动Turn；`runtime/acceptedTurnContext.ts`装配首轮输入；`claudeStreamHandlers.ts`读取History/接受context；`invocationAssembler.ts`/`hostedAgentTurnHost.ts`/`hostedTurnHandoff.ts`桥接SDK执行 | `turnCoordinatorStorage.test.ts`、`database/acceptedTurnStorage.test.ts`、`runtime/acceptedTurnContext.test.ts`、`runtime/hostedTurnHandoff.test.ts`、`claudeStreamHandlers.hostedIntegration.test.ts`、SDK `test/turn.test.ts` | `approvalAgent`与`agentProtocolIpc`通过commands/execution/coordinator；accepted continuation transcript校验重建由`execution.loadAcceptedContinuationTranscript`承接。configuring config写/CAS及失败终态分别通过`execution.commitExecutionConfig/failConfiguring`；留在IPC的是业务配置、route和运行时终态协调。`claudeStreamHandlers.context.test.ts`12项通过；与metadata/body、SQLite、accepted/coordinator组合复核7个文件175项通过。当前source consumer静态审查无accepted/coordinator直接存储旁路；S3最终共同行为验收仍待完成 |
| Continuation 接受、源查询与启动 | 入队、源枚举、真实 checkpoint launch/finalize 与终态更新均经具名 queries/execution 操作；`runtime/agentContinuation.ts` 由 storage adapter 内部协作 | outbound负责路由/选择；IPC与outbound使用具名入口；外部调度在持久接受之后 | `sessionStorage/sessionStorage.test.ts`、`outbound/outboundAcceptor.test.ts`、`runtime/agentContinuation.test.ts`、`ipc/agentContinuationIpc.test.ts` | §5.6/§5.7事务、target身份和源查询选择语义已按TDD迁移复验。stage-level复查又收敛outbound History snapshot shim及IPC retry source SQL：summary依赖转为runtime纯模块，retry source由`SessionQueries.readLatestRetryTarget`封装；82项定向测试通过，Electron类型检查、边界护栏（18条既有例外、无新增）和`git diff --check`通过。S3其他项仍待审计，未验收 |
| ContextPort：manual compact 与 SDK preflight/boundary | SDK ContextPort/ContextRegistrar、History writer队列及session-scope adapter已接入；Hosted invocation由SDK绑定同一History writer | 手动IPC/planner与自动preflight/boundary/provider recovery共用ContextPort契约，各scope adapter提交给原事务owner | `sessionContextCompaction.ipc.test.ts`、`sessionContextCompaction.test.ts`、`sessionStorage/sessionStorage.test.ts`、`claudeStreamHandlers.hostedIntegration.test.ts`、SDK `test/contextRegistrar.test.ts`、`test/contextPort.test.ts`、`test/history.test.ts`、`test/turn.test.ts` | TDD先证明planner额外返回的`commitProjection`不被执行；JSONL compaction ledger由宿主注入可信`ContextProjectionCommitter`在History replacement之后写入，可信projection故障仍fail closed。随后将SDK、Hosted host及invocation assembler两套phase端口合并为强类型`planContextReplacement`，以`phase: preflight | turn-boundary`区分输入，旧SDK `preflightModelRequest`/`turnBoundary` contract已移除；测试明确同一个planner依次接收两个phase。ContextPort/registrar/history/turn、adapter、manual IPC/session adapter及Hosted集成6文件490项通过，Agent SDK/Electron类型检查通过。S3全阶段边界护栏、全量类型检查/测试、storage audit及`git diff --check`仍待完成 |
| Recovery / 启动 | History restore 在 main；turn恢复在 `sessionTranscriptStartup.ts`；transcript reconciliation、continuation reconciliation分属runtime/IPC | bootstrap是唯一编排者，通过 `SessionRecoveryPort.recover()` 获取领域报告；不得由consumer跳过执行准入 | `runtime/sessionTranscriptStartup.test.ts`、`runtime/agentContinuation.test.ts`、`runtime/sqliteAgentHistory.test.ts` | 未发现main启动编排专属测试；恢复顺序、阶段隔离与报告字段来源仍跨模块，当前没有统一 recovery port；§7契约真实分支复评是设计门槛 |
| Lifecycle / maintenance | 维护入口在 `storage/sessionStorageMaintenance.ts`、`sessionMessageContentCleanupMaintenance.ts`、`runtime/sessionStorageCutover.ts`；DB flush/close由main资源宿主 | 只有bootstrap/资源宿主持有 `StorageLifecycleControl`；普通业务port不导出 cleanup/cache/maintenance权限 | `storage/sessionStorageMaintenance.test.ts`、`storage/sessionMessageContentCleanupMaintenance.test.ts`、`runtime/sessionStorageCleanupAuthorization.test.ts`、`runtime/sessionStorageCleanupProduction.test.ts` | 现有清理授权与安全测试保留；宿主独享接口及stop→quiescent→flush/close尚未接线。本轮不实现新worker/索引/调度策略 |
| 同库但非会话域 | MCP、usage、delivery、日志、workDir profile/权限策略、模型配置等各自由其模块持有 | 不因共享SQLite而并入SessionStorage；只把所需Session DTO交给queries/commands；具体业务规则与非会话数据读写留在原owner | 各owner既有测试；workDir、remote工具与执行配置用上行列出的现存用例 | 需保持归属；发现真正跨域事务时记录明确owner，不能把任意connection callback加入公共接口 |

S0直接调用点分类（隔离worktree静态检索）：

- 业务consumer：`appIpc.ts`、`capabilities/handlers/session.ts`、`claudeStreamHandlers.ts`、`floatingNotificationManager.ts`、`ipc/agentProtocolIpc.ts`、`ipc/ipcShared.ts`、`ipc/searchIpc.ts`、`ipc/sessionIpc.ts`、`main.ts`、`outbound/outboundAcceptor.ts`、`remote/imRemoteAgent.ts`、`remote/imSessionResolver.ts`、`remote/remoteSessionActivity.ts`、`runtime/acceptedTurnContext.ts`、`runtime/hostedTurnHandoff.ts`、`runtime/invocationAssembler.ts`、`sessionTitleSuggest.ts`、`tools/remoteSessionExecutors.ts`、`tools/remoteSessionRegisteredTools.ts`、`tools/weChatToolExecutor.ts`、`turnExecutionConfig.ts`、`workDirBinding.ts`、`workDirManager.ts`、`workDirSnapshot.ts`、Feishu/WeChat remote agent、resolver及IPC。分别按 query、command、execution、ContextPort、recovery 或业务owner保留分类迁移，不按database import数机械搬动。
- 会话存储内部实现：`database/operations.ts`、`database/acceptedTurnStorage.ts`、`database/sessionTranscript.ts`、`sessionStorage/*`、`runtime/sessionTranscriptProjection.ts`、`runtime/sqliteAgentHistory.ts`、`runtime/sessionContentWriteAuthority.ts`、`runtime/turnCoordinatorStorage`（已迁移至sessionStorage/coordinator）。可使用内部实现，不作为公共consumer。
- 投影迁移/维护/诊断：`runtime/sessionProjection*`、`runtime/sessionStorageCutover.ts`、`runtime/sessionStorageShadow.ts`、`runtime/sessionTranscriptStartup.ts`、`runtime/agentContinuation.ts`、`storage/sessionEventRetention.ts`及session cleanup/maintenance模块。按存储owner或宿主独享能力核对，不作为普通业务port调用者。
- 同库但非会话表方法（例如MCP的`getSession(serverId)`）不属于database session读取，留在其数据域owner。

**S0 基线盘点完成**：上述表和分类已列职责、当前owner、实际业务consumer类别、允许port、代表测试与未解决依赖。旧入口迁移属于S1–S4验收，不作为S0关闭条件；启动/manual compact缺少专属测试已标明，按相应阶段补最小必要测试。详细设计§9已逐项关闭设计门槛；两份文档一致性已复核，现按顺序实施S1。

### S1 公共查询入口（已验收）

S1已完成：SDK公共入口与宿主 SessionStorage 契约接入；组合根创建共享SQLite storage并向主进程、IPC、桌面/远程执行链注入；SessionQueries读入口覆盖accepted context、route/workDir/config、标题、能力导出、聊天分页/搜索与备份等业务consumer；Feishu/WeChat resolver改用注入的queries/commands；remote activity、Claude、Butler、IM agent、invocation assembler、标题建议等consumer移除SQLite fallback；补充数据库依赖边界护栏与查询/命令注入测试。

验收记录：最终全量`npm test`通过（889个测试文件通过、1个跳过；8444个测试通过、111个跳过）；`npm run typecheck:renderer`、`npm run typecheck:shared`、Electron与Agent SDK TypeScript检查通过；`npm run check:session-storage-boundary`通过（29条既有例外、无新增）；`git diff --check`通过。生产代码的SQLite工厂调用只留在main组合根、appIpc组合器和工厂实现；其他出现点仅在testSupport测试装配。最终raw session读取审计只留在main启动History恢复/备份孤儿清理owner、SessionQueries实现、remote resolver查询调用与MCP自有数据域；未新增raw正文访问。S1验收通过，进入S2。

### S2 查询内部拆分（已验收）

S2已完成：`getMessageSkeletons`、`getTurnContextSkeleton`、`getMessageSkeleton`返回不含正文的`StoredMessageSkeleton`；canonical transcript composition在解析后才生成完整`Message`。新增断言先确认旧实现失败，再完成类型与实现调整。路由选择/fence/canonical解析从通用`queries.ts`拆至`routingQueries.ts`；selector使用具名候选类型。定向分页/路由/search/context、shadow与启动清理回归254项通过；对SessionQueries可达的50个Electron模块依赖图检查确认selector、resolver、query adapter目标模块间无循环；shared/renderer/Electron/SDK类型检查与storage/cleanup边界护栏通过（29条既有例外、无新增）。最终全量`npm test`通过（889个测试文件通过、1个跳过；8445个测试通过、111个跳过）。分页、路由/search/context和批量body resolver回归保持通过；S2验收通过，进入S3。

### S3 修改边界（已验收）

按阶段表收敛具名commands/execution操作、metadata/body权限边界和事务参与者；逐项迁移accepted turn、continuation、coordinator及ContextPort双入口，保持各真实SQLite owner事务不拆分。S3已完成正文/工具元数据边界收窄：`SessionCommands.editMessage` 仅接收正文，`updateToolCallScrollback` 单独承接滚屏元数据，并核验不能通过该入口改工具状态或其他字段；原非 turn IPC payload 和返回message/sequence形状不变，拒绝混合patch。TDD先红后绿，相关focused回归通过。

随后按S0 owner表推进identity/config/workDir：`workDirBinding`使用`SessionQueries.readSession`和`SessionCommands.updateSettings`；工具执行与Feishu调用链注入对应ports。`workDirManager.migrateFromLegacy`的缺失绑定回填改用注入的queries/commands，并由`main`组合根提供。turn模型名迁移和失效模型重绑也改经`SessionCommands.updateSettings`；`main`中的启动ledger位置解析、备份活跃会话枚举与存在性检查改经`SessionQueries`。对S0列出的identity/config/workDir consumers复查后，剩余`listSessions`只在workDir profile owner与remote session resolver内用于会话集合规则，属于允许的业务选择。新增注入断言先红后绿；身份/工作目录/turn config/S0列出的snapshot、远程切换与通知测试共84项定向测试通过，Electron TypeScript检查、session-storage边界护栏（24条既有例外、无新增）和`git diff --check`通过。该行迁移完成。

随后继续收回SessionCommands consumer：`agentProtocolIpc`中的队列入库、非turn追加、技能提示追加、session settings更新、session创建改由`enqueue`、`appendNonTurnMessage`、`updateSettings`、`updateUserMetadata`、`createSession`承接；原非turn追加IPC仍只返回messageId/sequence。先加append adapter回执用例，再改IPC；storage/agentProtocol/outbound 62项定向回归通过，Electron TypeScript检查、边界护栏（20条既有例外、无新增）和`git diff --check`通过。`appendNonTurnMessage`和terminal scrollback具名命令已补入详细设计接口表。

继续按§5.2拆分metadata/body权限：删除混合`updatePreferences`，改用仅更新配置的`updateSettings`和兼容merge `updateUserMetadata`；renderer metadata merge保留现有产品键并保护标题状态、目录授权、远程身份及活动字段。`sessionIpc`分别调用rename/settings/metadata命令，`agentProtocolIpc`与turn/workDir owners迁至新具名接口。TDD先以旧实现缺少`updateSettings`变红，再实现并验证保护字段；session storage、session:update、turn config、workDir manager/binding和outbound 121项通过，Electron类型检查、边界护栏（20条既有例外、无新增）和`git diff --check`通过。SessionCommands consumer复查后该项完成；accepted-context适配器也改为必须注入execution，不再持有db fallback，验证中发现部分旧shadow测试没有持久turn，现仅由测试fixture走底层helper以继续覆盖原故障路径。继续收口coordinator/accepted，不进入continuation或S4。

coordinator/accepted 按S0顺序接入中：`claudeStreamHandlers`将接受写入改由`execution.acceptPrepared`完成，并将权威turn读取和接受消息加载改经`execution.readTurn/loadAcceptedMessages`；`agentProtocolIpc`配置/执行侧turn读取改经`execution.readTurn`，请求重放查找改经`readTurnByRequest`。`approvalAgent`创建隐藏session与接受turn改经注入的`commands.createSession`和`execution.acceptPrepared`。SessionExecutionStore新增`commitExecutionConfig`（只凭有效selection fence与原session revision提交）、`failConfiguring`、`readAccepted`、`readTranscriptState`、`readTurnByRequest`、`hasActiveTurn`及execution claim 生命周期命令；`agentProtocolIpc`配置冻结/失败终结和生产 hosted handoff 调用链均通过execution端口。新增stale fence、失败终态、accepted receipt和claim生命周期回归；storage/accepted-context/stream/approval/handoff合计232项通过，Electron类型检查通过，storage边界例外23条、无新增。随后按owner复核发现`hostedTurnHandoff`在runtime仍直接持有`sessionDb`读取和提交transcript；现已将Hosted transcript只读快照收入口`SessionExecutionStore`，生产handoff改为仅接收queries/execution ports，butler/approval/remote/main组合调用移除数据库句柄。测试fixture保留的SQLite仅用于构造真实storage ports。按§5.3核对后移除了handoff二次写入及公共execution transcript commit方法；终态participant由SDK History writer提交，handoff只读核验checkpoint；当terminal请求携带transcript participant时，缺失participant置为uncertain并保留执行claim；没有required user、SDK未生成failure participant的终态不要求checkpoint前进。TDD先捕获成功terminal后的重复提交，再验证真实SQLite History participant单事务成功及缺失participant的uncertain/retry fence；更新旧handoff mock，使其显式模拟SDK participant。handoff 47项、handoff+Hosted integration+storage 212项定向测试通过；Agent SDK/Electron类型检查、storage边界护栏（19条既有例外、无新增）及`git diff --check`通过。修正远程无required-user终态的准入后，Feishu/WeChat Hosted回归190项通过；调整后的全量`npm test`通过：893个测试文件通过、1个跳过；8498项通过、111项跳过。Agent SDK/Electron类型检查、storage边界护栏（19条既有例外、无新增）与`git diff --check`通过。真实文件SQLite故障/重启回归先红后绿：terminal+participant原子append中checkpoint故障回滚participant，handoff保留uncertain claim；进程重开并运行启动对账后checkpoint仍为commit_uncertain，重试被阻止。加入该回归前全量`npm test`通过：893个测试文件通过、1个跳过；8498项通过、111项跳过。SDK/Electron类型检查、storage边界护栏（19条既有例外、无新增）及`git diff --check`通过；新回归后的Hosted handoff/Hosted integration/storage 213项定向测试通过；SDK/Electron类型检查、storage边界护栏（19条既有例外、无新增）及`git diff --check`通过。真实文件SQLite故障/重启回归加入后的最终全量`npm test`通过：893个测试文件通过、1个跳过；8499项通过、111项跳过（耗时224.96秒）。SDK/Electron类型检查、storage边界护栏（19条既有例外、无新增）和`git diff --check`通过。S3剩余ContextPort门槛和阶段级边界复查待完成；S3未验收，也未进入S4。

随后按详细设计§5.6收口真实 continuation：IPC checkpoint入口改由`queries.continuationSources.inspect`提供源证据，并通过`execution.continuationLaunch.prepareAndClaim`启动；执行终态经`execution.continuations.settleForTurn`推进。outbound移除本地intent SQL helper与直接状态更新，普通turn目标通过具名接受操作绑定。`resolveContinuationAcceptance`依据route和`agent_continuations`的request/session/source/checkpoint关联区分continuation与exact-continue turn，并返回关联记录；补充target分类回归。storage/continuation/outbound/IPC 125项定向测试通过，Electron TypeScript检查、边界护栏（19条既有例外、无新增）和`git diff --check`通过。随后按§5.7补齐唯一历史fallback、显式fallback、completed源not-recoverable、跨session选择隔离回归，并将checkpoint IPC源turn读取迁至`execution.readTurnByRequest`；outbound/IPC consumer复查确认不再直接枚举/读取SQLite History。相关定向测试125项通过，Electron类型检查、storage边界护栏（19条既有例外、无新增）和`git diff --check`通过。§5.7对应查询与consumer映射已收口。随后进入SDK ContextPort §6：新增内部ContextRegistrar签发器和base/evidence身份、来源绑定、checkpoint、必需用户与pending tools校验；新增History writer `appendAtVersion`，版本核验和append共用writer队列。TDD迁移 preflight、turn-boundary 及 provider-recovery 到 invocation ContextPort；Hosted checkpoint identity 映射从 compaction candidate 的 `checkpointMessage.id`/`checkpointReplayIdentity` 读取，不从消息内容推断。新增 provider-recovery 提交顺序回归；Agent SDK/History/ContextPort/hosted adapter/真实 Hosted compaction 定向测试303项通过，Agent SDK与Electron类型检查及`git diff --check`通过。随后为手动 compaction 增加 session-scope signer/adapter，planner 改为从 ContextPort 读取规划起点并注册候选，session IPC 在可信组合层绑定 capture/CAS 和原有 compaction start/summary/end ledger writer；stale/busy 由 port 结果向上返回。手动 planner、IPC trust boundary 与 session adapter 定向测试24项通过，Electron/Agent SDK类型检查及`git diff --check`通过。随后移除 `sessionContextCompaction` 的 legacy sink 参数和 append 事务分支，planner 必须依赖 session adapter；base frame 与 planner 输入 surface 不一致时在摘要前返回 stale，busy/fingerprint CAS 归 adapter 提交路径负责。原有测试改由真实 SDK session adapter 测试构造承载 compaction ledger。之后 `SessionStorage` 工厂新增 `contexts: ContextPort` scope router，IPC 在 session lock 内注册受信 session adapter，按精确scope路由并在退出时解除绑定；增加未绑定scope拒绝及解除绑定回归。planner、IPC、storage及SDK session adapter 相关测试共66项通过，Electron/Agent SDK类型检查及`git diff --check`通过。随后将 session baseline读取、surface构造、已提交shadow重放、source provenance、fingerprint CAS、compaction transaction持久化及 ContextRegistrar/signer 组装移入 `electron/sessionStorage/contextAdapter.ts`，并由工厂创建的 ContextPort router 提供 adapter 创建入口。SQLite factory 通过绑定在 `contexts` router 上的内部adapter provider，按 session ID读取session、解析workDir、获取并重放ledger；main组合根只注入userData路径及按session解析workDir的回调，IPC只保留trusted sender/锁/busy准入和摘要策略；随后将 Hosted turn 对外伪装为 `ContextPort` 的投影对象迁为 `contextProjectionCommitter` 受控函数，移除SDK中的 `ContextProjectionPort` 类型；History replacement 仍只经 invocation ContextPort/同一 History writer提交，JSONL投影仅作为签名evidence的提交后hook。turn与Hosted compaction顺序/失败定向测试11项通过，Agent SDK/Electron类型检查及`git diff --check`通过，仓库源码中不再存在 `ContextProjectionPort`。随后为 invocation frame 重建增加回归，验证稳定 replay identity、非空sourceData及文本+图片Canonical block保留；ContextPort/Registrar/Session adapter/turn共136项通过，Hosted compact/projection定向6项通过。新加重启 replay 回归先捕获到 session adapter 对 checkpoint 重新分配 surface hash 且误设 sourceMessageIds 的缺陷；现从 committed candidate 恢复 checkpointMessage.id/checkpointReplayIdentity，并使 checkpoint 来源为空。包含重启恢复在内的storage/manual/SDK定向测试77项通过，Electron/Agent SDK类型检查及`git diff --check`通过。随后扩展真实 Hosted boundary integration：读取handler实际生成的 compaction start/summary candidate，折叠为 committed replay，再通过 SQLite SessionStorage 新建 adapter；验证旧消息被 shadow、checkpoint replay identity 与空 sourceMessageIds 恢复。另覆盖 Hosted initial preflight；storage/manual/context/registrar相关62项及两条Hosted重启/compaction路径2项通过，Electron/Agent SDK类型检查和`git diff --check`通过。projection-error已有History先提交后停止内存生效/工具dispatch回归。随后新增真实 SQLite SessionStorage + `registerSessionIpc` 的手动成功路径集成测试：可信 renderer 请求经 session ContextPort 完成注册提交，并由原 `appendCompactionTransaction` 写出 ledger 事务；与 Hosted boundary/preflight 经 invocation ContextPort、fold committed replay 后由 session ContextPort 重启恢复的测试配对。手动 IPC、planner、storage adapter及 Hosted compaction/replay 相关定向测试11项通过，Electron/Agent SDK类型检查及`git diff --check`通过。此证据确认两种scope adapter遵守相同ContextPort契约并各自委托原事务owner。按§6.1继续逐项复核时新增required-user负例，先观察到registrar允许base未绑定requiredUser的候选自行添加该材料，随后将校验收紧为base/output始终严格相等（含双方均缺省）。再新增无来源输出checkpoint身份/内容不匹配负例，先红后将registrar收紧为checkpoint identity必须等于输出replayIdentity，且checkpointMessage必须与候选输出完全一致；修正两条旧边界用例以携带与生产格式一致的checkpoint身份及candidate message。ContextRegistrar、ContextPort、History、turn、手动IPC/planner、session storage及Hosted compaction相关344项定向测试通过，Agent SDK/Electron类型检查与`git diff --check`通过。全量`npm test`复验893个测试文件通过、1个跳过；8496项通过、111项跳过。随后按阶段要求运行全量`npm test`，结果为893个测试文件通过、1个跳过；8496项通过、111项跳过。该全量验证在本轮Hosted execution port调整前完成，调整后的全量复验待完成。

每步按消费者或职责拆小 PR。先改 import 与接口边界，再移动实现，不在同一 PR 大规模重命名、重排 SQL 和改变错误处理。已迁移模块不再从宽 `database` barrel 获取正文能力。

### 7.1 关键流程接入要求

S1 盘点手动/自动的有效上下文读取，并将 continuationSources.inspect 的源枚举与边界证据读取纳入公共查询迁移；S3 将两个入口及逻辑窗口替换接入相同 ContextPort，内部封装既有提交 owner；覆盖 stale/busy、重启 shadow、窗口预算和 projection-error 回归。S1 必须分别迁移 accepted-context、route/reuse-user、聊天分页 IPC 与备份 adapter 的依赖注入及调用，不能仅提供 queries 文件却保留 consumer 绕过。S2 拆分 selector/resolver 后复验两种查询各自的选择语义。

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


### S3 进度追加（2026-10-07）

按阶段表继续审计 Turn coordinator / accepted context 时，发现 `claudeStreamHandlers.ts` 的 continuation 分支绕过 `SessionExecutionStore`，直接创建 `SqliteAgentHistory` 并校验已接受 Invocation context。先增加端口委托断言，再将该读取与既有 marker 唯一性、sequence、turn/source/checkpoint、required-user 校验及 transcript 重建迁入 `execution.loadAcceptedContinuationTranscript`；业务入口只依赖该端口。定向验证：`npx vitest run electron/claudeStreamHandlers.context.test.ts`，12项通过，覆盖精确 session/turn 委托和原有 checkpoint/source mismatch。此项完成；S3其余阶段级边界审计仍未完成，故不关闭S3，也不进入S4。

按S3表顺序继续完成 continuation 子项复核：移除 `outboundAcceptor` 将 `getDbConnection` 用作History快照shim的旁路，源摘要依赖从outbound移至runtime纯函数；新增 `SessionQueries.readLatestRetryTarget`，保持唯一失败assistant、无附件、来源request映射语义，`agentProtocolIpc.findRetrySource` 不再直接查询turns。回归 `sessionStorage/sessionStorage.test.ts`、`agentProtocolIpc.test.ts`、`outboundAcceptor.test.ts` 共82项通过；Electron类型检查、边界护栏（18条既有例外、无新增）和 `git diff --check` 通过。S3 continuation 子项已完成；metadata/body与ContextPort stage-level审计仍待完成，故S3保持未验收。

按S3顺序复核ContextPort旧planner边界：先前只改TypeScript返回声明仍允许运行时附带`commitProjection`，新回归先红并暴露这一缺口；随后去除planner的独立提交能力，将JSONL写入迁至宿主注入的可信ContextProjectionCommitter。planner保留`historyPayload`供ContextRegistrar签名校验，History replacement仍通过SDK ContextPort注册/校验/提交，手动IPC/SQLite ledger owner不变。真实 Hosted boundary 和 initial preflight 两项集成均通过，History `transcript-compacted`保留required-user，原`appendCompactionTransaction`一次写入。另将SDK `preflightModelRequest`/`turnBoundary`两套端口合并为强类型`planContextReplacement(phase)`；相关SDK turn、adapter、host、assembler、SQLite History与Hosted integration 6个测试文件490项通过，Agent SDK/Electron类型检查通过。ContextPort剩余stale/busy、逻辑window及其他S3跨consumer事务participant仍需最终矩阵复核，S3未验收。

metadata/body子项阶段复核：`editMessage`只接收正文且仍委托原canonical-backed write authority；`updateToolCallScrollback`核验仅terminalScrollback改变；IPC `message:patch-non-turn`要求单一patch字段，拒绝content+toolCalls混合；`updateSettings`和`updateUserMetadata`分开，保护标题、directory grants与remote identity/activity键。S3候选owner复查确认configuring turn的commit/fail走`execution.commitExecutionConfig/failConfiguring`，accepted read/write走execution/coordinator，外层保留配置策略和错误终态协调。真实SQLite/IPC/storage/accepted/coordinator定向7文件175项通过，storage边界护栏18条旧例外无新增，`git diff --check`通过。该项记为完成；S3最终事务participant审计与ContextPort remaining gates仍未完成。


S3阶段复核进度（2026-10-07）：已依阶段表审计并完成accepted/coordinator、continuation、metadata/body与ContextPort若干迁移子项，但阶段仍未验收。continuation源读取及retry SQL旁路收回到queries/execution；accepted continuation context读取收回execution；planner不再拥有独立projection提交能力，`historyPayload`保留为签名evidence，preflight/boundary统一走`planContextReplacement(phase)`；body与scrollback、settings与metadata使用受限具名命令。Configuring execution config CAS/failure和accepted/turn事务仍由具名execution/coordinator adapter封装。新增的planner权限回归及统一phase行为，连同SDK turn、adapter、host、assembler、SQLite History及Hosted integration 6个测试文件490项通过；Agent SDK/Electron类型检查通过。S3退出条件仍是最终跨consumer/事务participant矩阵核验、完整Electron/Agent SDK/renderer/shared类型检查、storage边界、全量tests及无旧contract/旁路检查；完成这些之前不开始S4。

S3阶段门禁首次全量验证发现renderer的`invocation.contractShape.test.ts`仍要求已移除的`turnBoundary`宿主符号（892文件通过、1跳过；8502项通过、111跳过，1项失败）。按新接口更新该契约形状白名单为强类型`planContextReplacement`；该测试4项通过。随后全量`npm test`通过：893个文件通过、1个跳过；8503项通过、111项跳过。Agent SDK、Electron、renderer、shared类型检查通过；storage边界护栏18条既有例外、无新增；旧`ContextProjectionPort`/`preflightModelRequest`/`turnBoundary`主contract扫描无命中，`git diff --check`通过。

S3最终事务participant/owner矩阵复核：

| 操作 | 对外入口与允许consumer | 事务 owner / 原子边界 | 最终核验 |
| --- | --- | --- | --- |
| accepted turn、coordinator receipt与terminal | `SessionExecutionStore` / coordinator，由IPC与Hosted handoff调用 | `turnCoordinatorStorage`与`acceptedTurnStorage`在原SQLite事务中校验并写turn、receipt、participant；History transcript participant由SDK History writer交付，不由handoff二次写 | 缺失participant保持uncertain并留claim；真实SQLite失败、重启、不可重试回归通过 |
| configuring execution config CAS/failure | `SessionExecutionStore.commitExecutionConfig/failConfiguring` | execution adapter按selection fence及session revision条件提交，配置决策仍归IPC/业务owner | stale fence、失败终态及读取路径定向回归通过 |
| continuation source/accept/launch/settle | `SessionQueries.continuationSources`与`SessionExecutionStore`具名操作 | 接受/claim/launch/finalize由coordinator/execution存储事务拥有；outbound仅做路由与intent编排 | source选择、fallback、exact-continue关联、claim与跨session隔离回归通过；IPC/outbound无SQLite/History旁路 |
| 正文、scrollback、settings与metadata | `SessionCommands`受限具名方法 | 正文仍由canonical write authority提交；settings与兼容metadata分别更新，scrollback不写tool状态 | 混合patch拒绝、owner字段保护和真实SQLite/IPC行为回归通过 |
| manual ContextPort compaction | session-scoped `contexts` router | session adapter负责surface fingerprint CAS并调用原JSONL compaction transaction | stale/busy不写入，可信IPC集成和重启replay通过 |
| Hosted preflight/boundary/provider recovery replacement | SDK invocation-scoped同一个`ContextPort`及`planContextReplacement(phase)` | SDK `InvocationHistoryWriter`队列原子校验版本并只append一次；宿主可信`ContextProjectionCommitter`执行提交后ledger投影，失败保持uncertain/fail-closed | 故障、window transition、required-user、checkpoint identity、工具提案、两个phase及真实Hosted重启ledger回归通过；planner无独立提交callback |

以上矩阵对应的consumer定向回归、全量测试、四类类型检查、storage边界和旧contract扫描曾通过；后续S4旧adapter审计发现生产装配仍保留响应projection hook和`turnBoundary`命名，因此S3阶段门禁重新打开并先行修复。修复后全量`npm test`通过：895个文件通过、1个跳过；8508项通过、111项跳过。renderer/shared/Electron/Agent SDK四类类型检查、storage boundary（15条既有例外、无新增）、旧ContextPort contract及S4旧startup/cutover/coordinator import扫描、`git diff --check`均通过；S3重新验收关闭，继续S4阶段验收。

### S4 进度追加（2026-10-07）

按S4既定顺序先完成 recovery 接线：`SessionStorageHost` 将main现有History恢复与session ledger修复结果注入 `SessionRecoveryPort`；port按History→ledger→snapshot→coordinator→transcript reconciliation→continuation顺序汇总实际计数与失败，保留safe-db-maintenance跳过时的fail-closed gate。快照helper迁入sessionStorage，直接 transcript SQL操作收进存储内部恢复adapter，boundary护栏不新增例外。恢复新增并发合并、顺序、History/ledger故障门禁、readiness测试；恢复及启动定向回归303项通过，Electron类型检查、边界检查及diff check通过。Recovery子项完成；readiness对实际执行入口的完整传播随S4阶段收尾复核。

随后完成 lifecycle 子项初版。复核发现该实现只在窗口ready后包装已经创建的scheduler，且未授权的maintenance请求会返回scheduled；本轮按TDD补足：scheduler现在由lifecycle的授权启动回调创建，启动前请求返回not-needed。原有ready时机、safe-db分支、cleanup gate、参数和策略保持。生命周期定向4项通过；维护/恢复组合回归53项通过，Electron类型检查通过。阶段最终门禁待完成。

随后完成S4职责拆分子项：旧 `runtime/sessionStorageCutover.ts` 入口删除；production query/execution消费者改依赖 `sessionStorage/certification`，清理授权与生产清理依赖 `sessionStorage/maintenance`；缓存清理由 `storage/sessionProjectionCacheMaintenance.ts` 单独拥有，compact orchestration只调用该cache maintenance能力。SQLite认证与清理共享的低层fence实现收在 `sessionStorage/internal/sqliteCutover.ts`，避免复制敏感完整性校验；普通consumer不导入该内部目录。原清理授权/gate/恢复测试全部保留并通过，认证/cleanup/cache/accepted-context/IPC定向10文件336项通过；Electron类型检查、storage boundary（15条既有例外、无新增）及diff check通过。main退出现只有quiescent后才flush/close，deadline超时会跳过数据库flush/close并在Electron进程退出时回收资源。

2026-10-07复核更正：上条“职责拆分完成”仅完成了能力 façade 分层，`internal/sqliteCutover.ts`仍混合认证与清理实现，故不满足物理职责拆分验收。现已按TDD/阶段顺序将清理算法移至`internal/sqliteCleanup.ts`、认证算法移至`internal/sqliteCertification.ts`并删除旧混合实现；cleanup boundary allowlist同步收窄至清理实现。另补足lifecycle类别行为：具名任务按category暂停/续跑，inspect返回对应状态快照；类别测试先红后绿。Electron typecheck与维护/退出定向测试16项通过；真实SQLite recovery readiness测试4项通过（含恢复前pending及恢复后readable/executable）。旧ContextPort contract、cutover/startup/coordinator旧production import扫描无命中；cleanup和session-storage boundary均通过（15条有名既有例外、无新增），`git diff --check`通过。当前重新运行完整阶段门禁。

S4最终收口（2026-10-07）：按计划顺序完成Recovery、Lifecycle、职责拆分和旧adapter/import清理。最终`npm test`通过895个文件、1个跳过；8512项通过、111项跳过。renderer/shared/Electron/Agent SDK类型检查通过；`npm run i18n:check`通过（source 0条硬编码中文）；`npm run build`通过，Electron build内cleanup boundary与session-storage boundary均通过；边界保留15条具名既有例外、无新增。旧ContextPort contract及旧cutover/startup/coordinator production import扫描无命中；`git diff --check`通过。S0至S4及设计门槛全部关闭。build生成物位于忽略目录；没有更改schema、持久格式或维护策略。

### 2026-10-08 评审P1修复进度

1. Context candidate evidence：新增 invocation/session 两侧 output 替换回归，先红后绿（2个用例复现绕过）；registrar现记录不可变base/output并在读取proof时比较完整candidate，拒绝跨base/evidence拼接。`contextPort`与`sessionContextPort`定向14项通过。
2. Shutdown backup：新增真实内存SQLite会话及待flush防抖任务回归；原测试因缺少shutdown loader模块失败，新增`flushPendingSessionBackups(manager, queries)`并由main使用模块级`appSessionQueries`明确传入，退出收尾后清空引用。真实备份文件含消息且pending队列清空；测试通过。
3. SQLite recovery ledger gate：真实host factory回归先红（ledger调用0次、status ready），现factory转发ledgerRepair callback；聚合时保持History已失败状态，ledger无故障不能重置History异常。recovery与备份定向共7项及Electron类型检查通过。
4. SDK闭包隔离：`turn.ts`改用SDK自有`contextIdentity.ts`，实现与宿主surface identity纯规则等价；新增host/SDK identity契约测试。`npm run check:agent-sdk`通过（SDK入口闭包23个模块，零electron/shared/Renderer/node:sqlite），SDK typecheck通过；Context/identity/turn定向5文件146项通过。四项阻断均修复。

评审修复最终验收（2026-10-08）：`npm test`通过897个测试文件、1个跳过；8518项通过、111项跳过。renderer/shared/Electron/Agent SDK typecheck、`npm run check:agent-sdk`、`npm run i18n:check`和`npm run build`全部通过；build执行的cleanup与session-storage boundary均通过，保留15条具名既有例外、无新增。新增真实SQLite shutdown backup flush及host recovery-ledger门禁回归、两类ContextPort candidate替换拒绝回归、SDK/host identity等价回归均通过。`git diff --check`通过。四项P1已关闭。

S4旧adapter审计发现S3遗漏：SDK observer仍有`prepareModelResponseProjection`，Hosted组合点仍以`turnBoundary`命名。已依S3 ContextPort顺序先移除旧响应projection回调命名，改为`prepareContextBoundaryEvidence`；Hosted compaction planner回调改为`onContextReplacementPlan`，boundary adapter/context/type及装配属性改为ContextReplacement命名。统一`planContextReplacement(phase)`继续负责preflight与turn-boundary replacement。Agent SDK/Electron typecheck及定向4文件290项通过；随后全量门禁全部通过（895文件、8508项），S3重新验收完成并回到S4。旧contract扫描无旧projection contract或旧cutover/startup/coordinator import命中。

S4阶段最终验收记录（2026-10-07）为本轮复核前状态，不能视为当前完成标记。本轮按TDD修复lifecycle启动接线及requestMaintenance未授权状态；生命周期4项、维护/恢复组合53项和Electron类型检查通过。S4其余逐项审计、文档状态统一及阶段级最终门禁仍在进行，S0–S4暂不全部关闭。
