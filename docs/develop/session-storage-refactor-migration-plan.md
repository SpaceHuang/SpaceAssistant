# 会话存储重构迁移计划

| 字段 | 内容 |
| --- | --- |
| 状态 | 计划稿；任务未执行前均为“未开始” |
| 对应技术方案 | [会话存储重构技术方案](./session-storage-refactor-technical-design.md) |
| 目标 | 明确新旧版本数据库、canonical 数据、修复待办、消息投影、台账与 spill 的迁移顺序，并让每项工作都能凭证据判定完成 |
| 执行原则 | 不在单次升级中重写所有历史消息；迁移可中断、可续跑；任何旧会话始终有明确可读路径；只有门禁通过才切换读写 owner；回滚前先将 canonical 前向桥接到 legacy 读模型并核验 |

## 1. 迁移决策（直接回答迁不迁）

**迁移，但分对象、分阶段迁。**

1. **每次应用升级时迁 schema。** 通过幂等数据库 migration 创建新表和列；这不等于搬迁历史消息。
2. **Phase 1 迁恢复元数据。** 新写入的 canonical 数据与投影修复待办同事务登记。升级前的 streams 做一次分批分类，为缺失的跨存储修复义务登记待办。此阶段不迁消息正文、不切换会话读路径。
3. **Phase 2 按需迁旧会话投影。** 新写入先按 canonical 新路径落库；旧会话在第一次被打开、resume 或构建 API 上下文时，若 P-1/P-2 证明 canonical 足以重建，就全量折叠该会话并写新投影缓存。之后增量更新缓存。若覆盖度不足，继续走该会话的旧读路径，不写一个不完整的新投影。
4. **后台补迁未访问会话。** 在线切换稳定后，按会话分批处理仍未迁的且 canonical 覆盖充分的会话；可暂停/续跑，不能阻塞主窗口和活跃 turn。旧会话覆盖不足的保留旧路径，直到有独立补齐方案或经产品决策归档。
5. **退役旧读路径。** 只有所有仍需支持的会话已迁移或明确进入受支持的 legacy 路径，且回滚观察期与门禁满足后，才删除旧读路径。旧表数据删除是更晚的独立变更，不与切读路径同批执行。

因此，“旧会话迁移”指从该会话的 canonical history 构建新消息投影缓存；不改写 canonical 历史事件。旧 transcript 在切换新写入 owner 后**不再被当作自动保持最新的回滚来源**。回滚必须先从 canonical 重建并核验 legacy 读模型，再切回 legacy reader；若无法重建，必须继续使用 canonical reader，不能只关闭读开关。

### 1.1 回滚目标与桥接策略

- **目标语义**：回滚是应用代码/读路径回退，不回滚 canonical 数据库，不丢弃新投影，也不假设旧 transcript 已被新写路径持续更新。
- **桥接路径**：停止或栅栏化该会话的新写入 → 从 canonical history 构建 legacy reader 实际依赖的完整数据（包括 `session_transcript_entries` 及必要的 `messages` 投影）→ 核验 transcript version、消息数/顺序/字段摘要和 API context → 事务提交桥接结果 → 才允许 legacy reader 接管。
- **新安装会话**：旧 transcript 可以从空基线补建；必须通过创建后连续多轮新消息、工具结果和 API context 回滚测试。若 legacy reader 不能从 canonical 构建，则该版本不提供 legacy-reader 回滚，只能回滚到仍支持 canonical reader 的兼容应用版本。
- **写入切换期间**：不要求新 owner 持续双写旧 transcript。这样避免两套权威写入和双写事务不原子的风险；需要旧路径时，由显式、幂等、可验证的回滚桥接任务重建。桥接失败则保持 canonical reader，不得降级到陈旧 transcript。

## 2. 状态定义与完成证据

所有迁移状态必须持久化，不能只靠日志或内存标记推断。

| 状态 | 含义 | 可判定条件 |
| --- | --- | --- |
| `schema_ready` | 当前 DB schema 已具备迁移所需结构 | `schema_meta` 版本达到目标；必需表、列、索引存在；重复执行 migration 不改变数据且成功 |
| `repair_classification_pending` | 升级前 streams 尚未全部分类 | 持久化分类器有未消费游标区间 |
| `repair_enqueued` | 某 canonical stream 的跨存储修复义务已登记 | `canonical_projection_repairs` 有该幂等键且状态为 `pending`/`retry` |
| `repair_complete` | 对应义务执行成功 | 队列行状态为 `completed`，并有目标投影的可查询确认或审计结果 |
| `projection_eligible` | 会话 canonical 覆盖满足新投影折叠契约 | 该会话的 P-1 覆盖判定为 eligible，且无未解决的缺字段类别 |
| `projection_migrated` | 新投影已从 canonical 完整构建 | 新缓存行 `ver` 匹配；session generation 与水位身份有效；对拍摘要与迁移输入一致 |
| `legacy_required` | canonical 不足以安全生成新投影 | 持久化原因码（如缺上下文、旧 compact 形态未覆盖）；读请求明确走旧路径 |
| `rollback_bridge_pending` | 回滚桥接尚未完成 | 会话读写仍由 canonical 路径服务；禁止切换 legacy reader |
| `rollback_bridge_complete` | legacy 读模型已由 canonical 重建且核验通过 | 桥接批次状态完成；目标 transcript/messages 版本与 canonical 边界一致；消息/API context 对拍通过 |
| `legacy_retired` | 旧读路径已可退役 | 全部保留会话均为 `projection_migrated` 或有已批准且测试覆盖的替代；退役门禁表全部通过 |

每项任务完成时，执行记录至少填写：任务 ID、代码/schema 版本、数据库 fixture 或样本范围、命令/查询、结果摘要、产物路径、执行时间、失败项（若有）。状态只允许按任务验收条件推进；没有证据不标完成。

## 3. 阶段与任务清单

状态枚举：`未开始`、`进行中`、`阻塞`、`完成`。下表的任务逐项验收，不用阶段口头状态代替。

### M0：冻结旧版基线

| ID | 具体任务 | 完成判据（满足全部才标完成） |
| --- | --- | --- |
| M0-1 | 固定迁移前 schema 与数据分类基线 | 记录支持升级的最低/最高 schema 版本、表/索引清单、streams 数、终态/非终态数、每类 canonical 事件数、transcript 行数；查询脚本只读且结果归档 |
| M0-2 | 建立旧/新投影对拍语料 | 固定代表性会话集合：空会话、普通对话、工具调用成功/失败、usage、compact 前后、图片/附件、终态后台账缺失；每个 fixture 有来源版本、脱敏说明和校验摘要 |
| M0-3 | 形成字段覆盖判定表 | 对 §5.4 全部目标字段标注 canonical 来源、旧值来源、可否重建、缺失时行为；评审确认 P-1/P-2 通过，未覆盖字段不得标 eligible |

### M1：Schema 与 Phase 1 修复待办迁移

| ID | 具体任务 | 完成判据（满足全部才标完成） |
| --- | --- | --- |
| M1-1 | 增加幂等 schema migration | 从每个支持的旧 schema fixture 升级成功；新建库直接到目标版本；重复执行不丢数据、不重复插入逻辑记录；升级中断后重启能继续 |
| M1-2 | 增加逐项投影修复队列表 | schema 含唯一幂等键、stream/session 归属、repair kind、目标范围、状态、重试元数据；唯一约束能阻止同义务重复入队；状态迁移与索引有测试 |
| M1-3 | 新写入事务性登记修复义务 | 对每种需要跨存储补偿的 canonical 写路径，canonical 事件与待办在同一 DB transaction；注入事务中断后两者同生同灭；同幂等键重放只留一项待办 |
| M1-4 | 实现待办 worker 与失败重试 | worker 只读未完成待办；成功后标完成；模拟台账/usage/tool 投影 I/O 失败，重启后按同一幂等键重试且不产生重复投影；错误与尝试次数持久化 |
| M1-5 | 升级前 streams 初次分类 | 从旧库分批、持久化游标扫描 canonical；分类结果能区分非终态、终态待修复、终态无需修复及需人工/legacy 处理；任意批中断后续跑，最终游标到尾且独立全量核对无遗漏 |
| M1-6 | 切换常规启动恢复 | 仅查询非终态 streams、未完成修复待办和未完成分类批次；启动 SQL/trace 证明不枚举已完成终态 streams；分类未完成时保持旧恢复路径且 UI/日志明确显示迁移未完成 |
| M1-7 | Phase 1 性能对拍 | 固定非终态流和待办数，逐步增加已完成终态 streams 及事件量；扫描行数、解析事件数保持稳定；增加非终态或待办时工作量按其数量增长。报告包含样本规模、计数和耗时 |

**M1 退出门禁：** M1-1…M1-7 全完成。未达到时不得在发布说明中宣称启动恢复已按需化或 Phase 1 性能目标已通过。

### M2：双读兼容与新投影上线

| ID | 具体任务 | 完成判据（满足全部才标完成） |
| --- | --- | --- |
| M2-1 | 实现投影折叠器和语义版本 | P-2 字段表已批准；折叠器纯函数测试覆盖所有字段与多 invocation 顺序；语义变化会递增 `ver`，旧缓存必然失效 |
| M2-2 | 建立会话 eligibility 判定 | P-1 结果可机器判定为 `eligible`/`legacy_required` 并持久化原因；边界、compact、缺上下文类别有测试；未知类别默认 legacy，不猜测 eligible |
| M2-3 | 接入双读路径 | feature flag 可按会话选择 legacy/new；eligible 会话缺新缓存时 L2 重建；ineligible 会话走旧读路径；新旧两路错误都可观测且不返回静默空历史 |
| M2-4 | 首次访问懒迁移 | 对 eligible legacy 会话，首次打开/resume/API context 触发一次完整折叠；事务写缓存及 watermark；并发首次访问只产生一份有效缓存；失败回滚/下次重试；迁移后立即从新路径读回并通过对拍 |
| M2-5 | 新会话使用新写入 owner | 新会话自创建起由 canonical 驱动投影；所有 message mutation 都通过统一投影更新；禁止 legacy writer 与新 projector 同时成为权威；关键写路径有唯一 owner 测试 |
| M2-6 | 实现 canonical → legacy 回滚桥接 | 停止/栅栏写入后，从 canonical 重建 legacy reader 所需 transcript/messages；桥接幂等、事务化、可续跑；失败时状态保持 `rollback_bridge_pending` 且继续 canonical reader；成功须核验版本、水位、消息数/顺序/字段摘要与 API context |
| M2-7 | 回滚演练：旧会话切换后新增消息 | 选取已迁移旧会话，在新 owner 下产生至少两轮消息（含工具结果）；执行桥接再切 legacy reader；逐条对比会话 UI 历史和 API context，结果与切换前后 canonical 完整历史一致 |
| M2-8 | 回滚演练：新安装会话 | 从空库创建新会话，在新 owner 下产生多轮消息、工具调用/结果及终态；执行桥接再切 legacy reader；逐条核对 UI/API context；不得依赖升级前存在 transcript |
| M2-9 | 桥接失败与中断恢复 | 注入 canonical 读取失败、旧模型写入失败、进程在提交前退出；不得切 legacy reader；重启后按游标续跑，桥接完整并核验后才切换 |

**M2 退出门禁：** 双读线上观察期间，新路径错误率/耗时达到技术方案门槛；代表性 fixture 逐字节/结构化对拍通过；M2-6…M2-9 回滚桥接与演练全部通过。任何仅关闭新读 flag、未完成桥接的操作都不算回滚。M2 完成只表示新路径可用，不代表 legacy 可删除。

### M3：旧会话批量补迁

| ID | 具体任务 | 完成判据（满足全部才标完成） |
| --- | --- | --- |
| M3-1 | 生成待迁会话清单 | 所有会话恰分为 `projection_migrated`、`projection_eligible`、`legacy_required`、`deleted`；分类计数与 DB 独立盘点一致，无未分类会话 |
| M3-2 | 实现后台分批迁移器 | 每批有上限、事务边界、持久游标、速率限制、暂停/恢复；活跃 turn 优先不迁；重复执行幂等；单会话失败不阻塞后续批次 |
| M3-3 | 执行 eligible 会话补迁 | 批次报告列出成功/失败/跳过数及原因；每个成功会话满足 M2-4 完成判据；失败均可重试或转入有原因的 legacy 队列 |
| M3-4 | 处理 legacy_required 队列 | 每项有明确原因、责任人/决策和用户可读行为；若无安全补齐策略，保留旧读路径且禁止清理其依赖数据；队列数与 M3-1 对账一致 |
| M3-5 | 全量一致性抽查 | 全量比对新缓存水位与 canonical、generation、事件身份；抽样及边界会话新旧结果一致；所有差异归零或有批准的 legacy 例外 |

**M3 退出门禁：** 所有 eligible 会话均已迁移或有可重放迁移任务；legacy_required 均有明确支持策略；没有未分类记录。

### M4：体积归因、旧数据清理与物理空间回收

M4 要分别回答两个问题：**启动是否变快**与**数据库文件是否变小**。前者由按需恢复及读路径耗时衡量；后者必须在旧数据删除、spill 落盘和 SQLite 空间回收后实测。M4 完成不预设一定能达到某个缩减比例：若 canonical 必留数据占绝大多数，文件可能只能有限缩小；必须报告实测和可解释的下限/上限，不能把 `freelist` 增加算作文件已变小。

| ID | 具体任务 | 完成判据（满足全部才标完成） |
| --- | --- | --- |
| M4-1 | 定义退役候选范围 | 统计仍支持的 session 总数；每个会话为新投影已迁移或批准的 legacy 例外；legacy 例外仍有持续维护的读取 owner |
| M4-2 | 完成观察期 | 新读路径在约定版本/周期内作为默认路径运行；无未处理的数据差异、恢复失败或性能回退；仪表数据与事故记录归档 |
| M4-3 | 移除旧读路径代码 | 只有 M4-1/M4-2 完成且产品/技术 owner 批准后移除；回归测试证明所有受支持会话仍可读；代码搜索确认旧 feature flag/分支无活引用 |
| M4-4 | 建立数据库体积与启动耗时基线 | 在同一代表性数据库上记录 DB/WAL/SHM 字节、`dbstat` 各表/索引页数、`page_count`、`freelist_count`、spill 字节、canonical 必留数据量；记录冷启动总耗时及迁移/恢复/投影加载分段耗时。报告含 SQLite 版本、运行环境和取数脚本 |
| M4-5 | 估算可清理空间和不可清理下限 | 对候选旧 transcript、重复正文投影、可降级 spill、索引分别称重；列出可删、必须保留、等待 spill 后才可删的数据集合；计算清理后 DB 的理论体积区间，并注明 canonical/流程状态等必须保留数据 |
| M4-6 | 执行旧数据逻辑清理 | 满足 M4-3 后先做备份/恢复校验，再分批删除已退役 transcript/冗余投影；逐批记录删除行数和字节估算；canonical、新投影及 legacy_required 会话仍可完整读取；失败可从游标续跑 |
| M4-7 | 执行 SQLite 文件空间回收 | 在无活跃 turn、完成 WAL checkpoint 后按目标策略执行 `incremental_vacuum` 或 `VACUUM`；记录耗时、锁定/空间峰值、前后 DB/WAL 字节及 `page_count`/`freelist_count`。验收以 DB 文件实际字节下降为准，freelist 变化单独报告 |
| M4-8 | 复测启动收益与体积归因 | 用与 M4-4 相同环境和数据库工作负载复测冷启动及分段耗时；把收益拆为恢复扫描、旧投影读取、迁移任务和其他启动步骤。说明变快是否来自恢复按需化，体积下降来自哪些表/索引/清理及 vacuum；无法达到预估下限时必须给出可复现原因 |
| M4-9 | 验证空间维护安全性 | 验证取消/进程中断、磁盘不足、活跃 turn 阻止维护、VACUUM 失败等情况不会造成数据损坏；维护任务能安全重试；维护完成后抽样会话、API context、canonical/spill 校验通过 |

**M4 退出门禁分开判定：**

- **启动性能目标**：M1-7 证明恢复扫描复杂度脱离已完成终态历史规模；M4-8 报告冷启动分段耗时。仅在此门禁通过后，才能宣称启动瓶颈已改善。
- **数据库缩小目标**：M4-4…M4-9 完成，且回收后 DB 文件字节数低于回收前；若字节未下降，则“数据库文件已变小”判定失败，需继续查明保留数据占比或回收机制原因。
- **旧读路径退役目标**：M4-1…M4-3 独立通过；只要仍有需支持的 `legacy_required` 会话且没有迁移方案，旧读路径就不能退役。

没有给 M4 设定日历日期；分别由上述量化门禁触发。迁移完成本身不代表启动收益和磁盘收益均已达成。

## 4. 版本升级与中断恢复矩阵

| 升级场景 | 启动行为 | 完成标志 |
| --- | --- | --- |
| 新安装 | 建立最新 schema；新数据走 canonical 新写路径；无历史分类任务；若需回退 legacy reader，先为新会话执行回滚桥接 | `schema_ready`；回滚时还须 `rollback_bridge_complete` |
| 旧 schema 升级，M1 初次分类未完 | 执行 schema migration；旧恢复路径继续兜底；分类 worker 按持久游标分批推进 | 分类状态 `complete`；未完成修复均有队列项 |
| 旧 schema 升级，M1 已完成 | 只恢复非终态 streams 与 pending/retry 待办；不全量读取终态 streams | 启动 trace 的访问集合符合验收 M1-6 |
| eligible 旧会话首次访问 | 使用旧路径不作为最终返回；全量折叠 canonical，校验后写新缓存，再由新路径返回 | `projection_migrated` 且缓存 watermark/generation 有效 |
| ineligible 旧会话访问 | 走 legacy 读路径，标明 eligibility 原因；不伪造/写入不完整新缓存 | `legacy_required` 保持可查询，旧数据未清理 |
| 迁移中升级中断 | 已提交批次保留；未提交批次回滚；重启按 cursor/待办幂等续跑 | 无重复义务、无漏项，游标与已完成批次一致 |
| 新版本需要回滚 | 保持 canonical reader；停止/栅栏写入；执行 canonical → legacy 桥接并核验；成功后才关闭新读 flag 切换 legacy reader。若目标旧版本不支持读取 canonical 且桥接失败，则禁止降到该版本 | `rollback_bridge_complete`，会话 UI 与 API context 对拍通过；否则继续 canonical reader |

## 5. 发布门禁与执行记录

每次发布迁移版本前，发布记录必须附：

1. schema 起止版本与 migration 结果；
2. 初次分类进度和剩余待办数；
3. `eligible`、`legacy_required`、已迁移会话数量；
4. 新旧投影对拍结果、错误率、启动扫描行数/解析事件数；
5. 回滚开关验证和数据保留检查；
6. 所有任务 ID 状态与证据链接。

执行 M4 时另附数据库文件前后字节、表/索引占用、canonical 必留体积、freelist、VACUUM/`incremental_vacuum` 实际结果以及冷启动分段耗时对比；不得用“数据库逻辑删除完成”替代物理缩小证据。

任务状态台账（实现启动后填写）：

| 任务 ID | 状态 | 证据链接/路径 | 备注 |
| --- | --- | --- | --- |
| M0-1…M4-9（各 ID 单独建行） | 未开始 | — | 汇总占位；执行时按 ID 拆成独立记录，不可整体标完成 |

## 6. 与技术方案的同步要求

本计划确定迁移时机后，技术方案 §7 的“老会话按需懒迁移”应解释为：**Phase 2 双读上线后，eligible 旧会话在首次打开/resume/API context 时从 canonical 全量折叠并建立新缓存；其余 eligible 会话在 M3 后台分批补迁；ineligible 会话保留 legacy 路径；M4 满足门禁后才退役旧读路径。回滚不是直接关闭新读 flag，而是先由 canonical 重建、核验 legacy 读模型，再切换 reader。**

任何会改变 eligibility、投影语义版本、回滚能力或 legacy 例外策略的设计修改，必须同时更新本计划对应任务与完成判据。
