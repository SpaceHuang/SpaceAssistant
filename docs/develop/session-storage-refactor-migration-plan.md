# 会话存储重构迁移计划

| 字段 | 内容 |
| --- | --- |
| 状态 | A-00…A-12、I-00…I-12、M3-6/A-13、M3-6G、M3-EXEC、R-00/R-01/R-02、SC-SCOPE、SC-00、SC-01A/B/C、SC-SCOPE-PKG、SC-02 独立证据审阅已完成；SC-01B Accepted 记录摘要 `d8c11fc170dfac4b5c43b2ed58f49f1873f802427d5db67848dc8aaf4aed3803` 授权固定 C 候选的 macOS disposable-profile C-on 演练。SC-01C 在固定 C clean identity 上完成 C-on arm64/x64 包级三态 worker 与 R→C-on→R 回读矩阵；90 KB source spill 正读成功，spill missing/tampered 与 History corruption 在两架构 R IPC 均 fail-closed，状态/游标、integrity/FK 检查通过。SC-SCOPE-PKG 对最终 C-on arm64/x64 包验证仅获批 A+C 前进、B 留存；错误 profile、过期 scope 不推进；撤销后 pending cursor/count 跨重启不变，重新授权可续跑；worker 与 packaged direct boundary 范围测试通过。完整 DMG/build/resource hashes、scope、profile 和故障结果见[SC-SCOPE-PKG package matrix manifest](./session-storage-cscope-package-matrix-2026-10-06.json)。**本机功能开发与 synthetic 验收当前无阻断项，SC-02 已通过**。SC-02 报告见 [独立证据审阅](../review/2026-10-06-session-storage-sc02-independent-evidence-review.md)。SC-03/04/05 以及 M3-PROD、R-03…R-07、reader 退役、RC-01/02 均属于用户升级后的独立数据运营/发布流程；真实会话在用户电脑上，不作为本机开发门禁。没有具体 owner/cohort 授权时这些运营项保持未执行，但不阻止功能完成、测试或代码集成。R-03 正式发布、真实 profile 补迁/只读审计、发布后观察、reader 退役和真实清理是独立部署/数据决策，不阻断本机功能完成。TEST ONLY 候选可用于技术审计，但不授权发布/真实清理。已将功能分支 rebase 到当前 main HEAD `c06e52b01a9c53858fa3dd97d6f4c59b23be1709`，保留 origin/main `5440f7764b92d2512593c7bf139c21958b7f26a0` 及 main 上 MCP 表格显示提交 `59aae8df83bb41d98066911fb470cc6424c9d064`、存储/Agent SDK 计划提交 `c06e52b01a9c53858fa3dd97d6f4c59b23be1709`；I-12 历史验收快照仍绑定 rebase 前 HEAD `87794f0c69b5bee1ac77698f9b4844be9f7d2912`。I-12 最终集成树验收 HEAD `87794f0c69b5bee1ac77698f9b4844be9f7d2912`；全量测试、构建、类型检查、i18n、cleanup boundary 和 diff check 结果见技术方案 I-12 清单。M4-8 测量已完成但启动改善未证明；reader 退役与单 session 清理为独立依赖分支。Windows、外部生产分布与发布平台任务不作为本工作区阻断目标；目录授权与 continuation UI 复用 `origin/main`，本分支不重做。 |
| 对应技术方案 | [会话存储重构技术方案](./session-storage-refactor-technical-design.md) |
| 目标 | 明确新旧版本数据库、canonical 数据、修复待办、消息投影、台账与 spill 的迁移顺序，并让每项工作都能凭证据判定完成 |
| 执行原则 | 不在单次升级中重写所有历史消息；迁移可中断、可续跑；任何旧会话始终有明确可读路径；只有门禁通过才切换读写 owner；回滚前先将 canonical 前向桥接到 legacy 读模型并核验 |

## 正式发布执行入口与适用边界

本计划同时记录本机功能/候选包验证与未来正式发布后的数据运营工作，两者不得串成单一完成门槛。**本机功能完成条件**是源码/TDD、`origin/main` 集成、合成 SQLite 与 disposable 候选包验收；不要求真实用户 profile、用户升级、正式发行或生产分布数据。R-03、M3-PROD、M3-8、R-04…R-07、RR-01…03、SC-03…05、RC-01/02 只决定正式部署、真实迁移/清理或旧 reader 退役能否执行；等待这些运营事件不得阻断本机功能结项。开发证据不等于真实用户 profile 已迁移。清理发布仍分 C-off（gate 默认关闭）与 C-on（嵌入 Accepted compatibility record 并 gate=true）两个产物；最终 C-on 审计必须绑定精确 hash，且真实部署另需数据集授权。

本计划保留早期 M0–M4 任务编号，以下边界按当前技术方案执行：

- R 是保留正文、不开启真实停写/清列的兼容发布；C 才接入受控清理。上线 R 不要求 M3 全量补迁、M3-6G coordinator 或 M4 全部完成；只要 R 自身保留 legacy reader、不启动补迁/清理并通过升级、读取、恢复验收即可先行发布；缺 canonical 覆盖的历史会话继续保留 legacy。
- M2-6…M2-9 的开发验收范围是功能层 canonical 读取、写围栏及故障恢复契约：用当前代码和隔离文件 SQLite 测旧会话/新会话、未清/已清状态、冷暖缓存、spill/History 损坏与重开。只有选定回滚目标依赖 legacy reader 时才实现 canonical→legacy 桥接。R/C 安装包切换、正式发布 R、安装产物留存及 C 的真实数据清理放行属于 §8.8.5 发布流程，不是 feature code completion 的前置条件，也不能用本地 smoke 声称 rollback floor 已发布。清列后禁止回填正文或重置 cleanup 状态，任何未来回滚目标都必须支持 canonical-only。
- M4 中旧 transcript 删除、旧读路径退役与 `messages.content` 清理是不同范围。Phase 5.5 只允许逐 session 清理通过认证的正文副本，保留消息骨架、流程状态和协议表；不能据 M4 的早期清理描述扩大删除范围，也不要求先删除所有 legacy reader 才清理获批 session。旧 transcript/协议表删除仍需独立方案与验收。
- 正文停写/清列按 `retained → write-stopped → pending → complete` 协议及兼容发布门禁执行；SQLite 物理空间回收另行安排，不能和首次 schema 升级绑定成一次启动任务。
- 正式发布及真实 profile 操作是部署/运营门槛，不计入本机源码与 disposable-profile 候选验收完成率。C-on 精确产物的包级边界审计是“清理能力可部署”的技术条件，不是整个存储功能交付或合并的门槛；真实清理仍必须另有正式部署、明确数据集授权和维护窗口。

本计划与当前技术方案存在历史表述差异时，以上边界及技术方案 §8.8.3–§8.8.5 优先；未实现的桥接、批迁或门禁保留待办，不能以文档引用代替实现和发布证据。

## 1. 迁移决策（直接回答迁不迁）

**迁移，但分对象、分阶段迁。**

1. **每次应用升级时迁 schema。** 通过幂等数据库 migration 创建新表和列；这不等于搬迁历史消息。
2. **Phase 1 迁恢复元数据。** 新写入的 canonical 数据与投影修复待办同事务登记。升级前的 streams 做一次分批分类，为缺失的跨存储修复义务登记待办。此阶段不迁消息正文、不切换会话读路径。
3. **Phase 2 按需迁旧会话投影。** 新写入先按 canonical 新路径落库；旧会话在第一次被打开、resume 或构建 API 上下文时，若 P-1/P-2 证明 canonical 足以重建，就全量折叠该会话并写新投影缓存。之后增量更新缓存。若覆盖度不足，继续走该会话的旧读路径，不写一个不完整的新投影。
4. **后台补迁未访问会话。** 在线切换稳定后，按会话分批处理仍未迁的且 canonical 覆盖充分的会话；可暂停/续跑，不能阻塞主窗口和活跃 turn。旧会话覆盖不足的保留旧路径，直到有独立补齐方案或经产品决策归档。
5. **退役旧读路径。** 只有所有仍需支持的会话已迁移或明确进入受支持的 legacy 路径，且回滚观察期与门禁满足后，才删除旧读路径。旧表数据删除是更晚的独立变更，不与切读路径同批执行。

因此，“旧会话迁移”指从该会话的 canonical history 构建新消息投影缓存；不改写 canonical 历史事件。旧 transcript 在切换新写入 owner 后**不再被当作自动保持最新的回滚来源**。本计划当前采用 §8.8.5 的兼容版本 R 回滚：保留 canonical reader，由 R 直接读取 canonical-only；只有目标确实是 legacy-reader 版本时才需先重建并核验 legacy 读模型。任何路线都不能只关闭读开关或读取陈旧 transcript。

### 1.1 回滚目标与桥接策略

- **目标语义**：回滚是应用版本回退，不回滚 canonical 数据库，不丢弃新投影，也不假设旧 transcript 已被新写路径持续更新。当前发布方案选用 §8.8.5 的兼容版本 R：它继续使用 canonical reader，并必须能打开 C 写出的 schema 与格式。
- **安装包回滚路径（当前方案）**：停止清理并等待在途事务结束 → 完整退出 C → 使用已发布且保留的 R 安装包打开同一 profile → 核验 canonical 正文、账本、骨架、preview/count 和 FK/turn/queue 不变量。R 不得回写 schema、回填已清正文或自动续跑清理；complete 会话仍遵守写围栏。
- **legacy-reader 桥接路径（可选替代）**：只有明确要回滚到依赖旧 reader 的版本时，才栅栏写入，从 canonical history 重建 `session_transcript_entries` 及必要的 `messages` 投影，核验版本、水位、消息顺序/字段和 API context，提交后才切换 reader。桥接失败时继续 canonical reader。
- **新安装会话**：旧 transcript 不作为前置条件。R 必须能读取 C 生成的新 schema/History/spill 格式，覆盖无升级前 transcript 的新会话；C→R 安装包演练按 §8.8.5.B 记录。
- **写入切换期间**：不要求新 owner 持续双写旧 transcript，避免两套权威写入和双写事务不原子的风险。legacy-reader 桥接失败时不得降级到陈旧 transcript；R 路线保持 canonical reader 和已清会话的写围栏。

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
| M2-6 | 确定并验证回滚路线 | 选择 canonical-compatible reader；定义 schema/History/spill 格式、canonical-only 读取和正文写围栏。仅当回滚目标依赖 legacy reader 时，才实现 canonical → legacy 桥接；开发期用代码与隔离 SQLite 验收，不要求安装包切换 |
| M2-7 | 验收已迁移旧会话 | 文件 SQLite 覆盖已有 transcript 的旧会话，在未清/已清状态下验证正文展示、API context 与消息身份；以 canonical oracle 对拍 |
| M2-8 | 验收新安装会话 | 覆盖无升级前 transcript 的新会话，验证 canonical reader 可读当前 schema/History/spill 格式及对应投影 |
| M2-9 | 验收故障与中断恢复 | 覆盖 History/spill 损坏、冷/暖 cache、重开及清理中断续跑；损坏须 fail closed，不能回填旧正文或静默重置清理状态 |

**M2 功能退出门禁：** 代表性 fixture 逐字节/结构化对拍通过；代码级故障恢复与同机性能门槛通过；M2-6…M2-9 的当前代码/隔离文件 SQLite 验收通过。线上观察、安装包版本切换、正式 rollback floor、签名和产物留存按 §8.8.5 发布流程执行，不阻断功能代码完成；真实数据停写/清列仍须满足独立的数据安全放行条件。

### M3：旧会话批量补迁

| ID | 具体任务 | 完成判据（满足全部才标完成） |
| --- | --- | --- |
| M3-1 | **完成（范围纠偏已重验）** | 只读 census 仅分类产品消息会话：`user/primary`、IM `remote/primary`、自动化 `automation/section`；明确排除 `internal/hidden`，单独折叠校验有 History 的内部 transcript 并报告 internal History 健康摘要。未知 scope fail closed；已知 ID 对账按所有 live IDs 判断删除，排除项不算 deleted。父会话 approval 生命周期仍纳入 fold。canonical-backed 损坏不得降级伪装成 `legacy_required`，不写 cache/eligibility；扫描前后 `data_version` 与 total_changes 不变。聚焦 inventory 测试覆盖上述分类。 |
| M3-2 | **完成（durable scope 与并发对账已重验）** | 每个 durable run 持久记录 DB session 总数、迁移 cohort 数、internal-hidden 排除数、内部 History 计数/健康数与摘要 SHA-256；完整 scope metadata 参与 inventory hash。文件 SQLite 覆盖创建、reopen/resume 与篡改摘要拒绝复用；独立连接在 census 后新增并删除 session 会令旧 inventory 拒绝启动。internal-hidden 不产生 migration item；remote/automation 进入目标 cohort 并计入总数。 |
| M3-3 | **完成（范围纠偏已重验）** | 批次报告列出成功/失败/跳过数及原因；每个成功会话满足 M2-4 完成判据；失败均可重试或转入有原因的 legacy 队列。worker 领取前重新验证 scope；范围漂移到 internal-hidden/unknown 则 needs_attention 且不读/写 projection、不产生 legacy/failure；运行中新增内部会话不进入固定 run。remote IM/automation 正常迁移，metadata 和 IM reuse 保持。 |
| M3-4 | **完成（范围纠偏已重验）** | 每项有明确原因、责任角色/决策和中英文用户可读行为；当前安全决策为保留兼容读取路径与源消息数据；清理 API 必须拒绝这些会话；同一只读事务快照内将 M3-1 清单中的 legacy 数与其队列子集精确对账，补迁时新增的 legacy 项单独计数。internal-hidden/unknown/deleted 项不能生成用户 retain-legacy 决策，污染队列 fail closed。 |
| M3-5 | **完成（范围纠偏已重验）** | 全量比对新缓存水位与 canonical、generation、事件身份；分别对账迁移 cohort、internal History 健康与 scope anomalies；抽样及边界会话新旧结果一致；所有差异归零或有批准的 legacy 例外。 |
| M3-6 | **完成（源码评审通过）** | 在最终集成树提供默认关闭、main-process-only 的受控应用入口；支持固定 inventory、bounded batches、active turn defer、pause/cancel、reopen/retry、幂等与 scope fail-closed。评审 finding 均修复，证据见技术方案 v427 与 M3-6 源码评审记录。 |
| M3-EXEC | **完成（操作规程已归档）** | cohort/run 角色、owner 授权、固定 census/hash 复核、开始/观察/暂停/重试/终止/回滚/对账流程已写入 `session-storage-m3-execution-runbook.md`。实际人名与 cohort 授权由 M3-PROD 记录填写。 |
| M3-PROD（旧编号 M3-7） | **等待授权（部署后数据任务）** | 目标 profile 经正常安装/升级运行一个由组织认可、包含 M3-6 coordinator 且通过 M3-6G 最终树验收的部署产物后，仅对 owner 明确授权的数据集经正式入口执行 durable projection migration；该任务是生产数据操作，不是用户测试，不能替代上线前 disposable-profile 演练。归档 app version、commit、完整 artifact identity/hash 和 profile 安装/升级确认，以及 run/item/inventory hash/cursor 与 success/failure/skipped 原因。该部署产物可来自受控发布，公开发行不是技术前置。不得从开发进程直接操作真实 profile。未获补迁写授权的 eligible session 必须有明确 retain-legacy owner/read-path 决定；无未分类 session、run 可重开续跑、总量摘要对账。补迁写入授权与正文清理授权分开。 |
| M3-8（由 R-04 承接） | **等待正常 schema upgrade（发布后只读任务）** | 只读执行新 schema 的 census、canonical consistency/internal History audit，并与 M3-PROD run/item/legacy queue 对账；输出完整 session disposition 及摘要。不得手动升级/写入真实 profile；该 audit 是 M4-1/R-05 reader-retirement 清单输入，不是 M4-6 单 session cleaner 的全局前置。执行入口、依赖及恢复条件统一见技术方案 R-04，避免重复计为另一条发布门禁。 |

**M3 生产批迁运行退出条件（部署后数据运营专用，不是本机功能退出门禁）：** 对本次获批 cohort，所有 eligible 会话均已迁移或有可重放迁移任务；legacy_required 均有明确支持策略；没有未分类记录。未获得真实 cohort 授权、用户尚未正常升级时，M3-PROD/M3-8 保持等待，不影响 M3-1…M3-6 的代码实现、synthetic 验收或整个本机功能完成。M3-8 只由 R-04 执行并向 R-05 提供 disposition 输入，不是另一份用户设备工作。

### M4：体积归因、旧数据清理与物理空间回收（代码验收与部署后目标分开）

M4 的本机工程交付和部署后结果分开记录：M4-1 候选范围生成器/报告的 synthetic SQLite 集成验收已完成，完整真实 session 去向清单是 C 类 R-05，须等用户正常升级后读取其设备上的 census/audit；M4-3 reader 代码退役还需真实观察与 owner 决策。两者只决定 reader 退役分支，不阻断本机存储功能。M4-2 观测工具、M4-4…M4-9 的估算/清理/维护实现与 synthetic 验收按各自代码任务完成；真实 profile 上的逻辑清理、VACUUM、冷设备/生产分布观察只属于部署后数据运营，不作为本机源码/TDD/集成的前置。任何生产数据操作仍须满足该操作自身的授权、备份、兼容和维护窗口条件。

M4 要分别回答两个问题：**启动是否变快**与**数据库文件是否变小**。前者由按需恢复及读路径耗时衡量；后者必须在旧数据删除、spill 落盘和 SQLite 空间回收后实测。M4 完成不预设一定能达到某个缩减比例：若 canonical 必留数据占绝大多数，文件可能只能有限缩小；必须报告实测和可解释的下限/上限，不能把 `freelist` 增加算作文件已变小。

| ID | 具体任务 | 完成判据（满足全部才标完成） |
| --- | --- | --- |
| M4-1 | 实现退役候选范围生成器；部署后生成完整真实 session disposition | **本机部分完成**：以 synthetic SQLite 完成 inventory/report 的 TDD，覆盖 migration run→consistency audit→候选报告、逐项分类、approved legacy owner registry、unknown/差异 fail closed；不读取用户 profile，也不宣称真实全量清单完成。**真实运营部分由 C 类 R-05 承接**：用户设备正常升级后，以完整稳定的 M3-5/M3-8 census 逐项覆盖全部 live sessions；projection migrated 或有注册表支持的 `retain-legacy` 决策；差异/未知项为 0 后才进入 reader owner review。这份真实清单仅约束 M4-3 reader 退役，不是本机功能交付或单 session 清理门禁。 |
| M4-2 | 建立版本化观察与归档工具 | transcript 读事件记录 app version、canonical/legacy/failure、耗时和稳定错误码；复用 shadow 差异、transcript recovery 与 History cutover 事件。只读报表按显式版本、时间窗、读耗时预算汇总 p50/p95、路径计数和事故，并将空样本、坏日志、差异、失败、recovery/cutover 事故或预算超限标为未完成。工具及隔离日志验收属于本机开发任务（已完成）；真实版本/周期的线上观察属于发布后证据，不阻断功能完成，只在 M4-3 实际移除旧 reader 前要求归档并经 owner 复核。 |
| M4-3 | （C 类部署后事项）移除旧读路径代码 | 仅在 M4-1 完整 session disposition、M4-2 真实版本观察和产品/技术 owner 批准齐备后才单独实施；legacy_required 会话必须有已验证替代读取方案。删除后做受支持会话回归及旧 flag/分支代码搜索。本项可无限期保留旧 reader，不阻断本机存储功能交付；它只约束旧 reader 删除决策。 |
| M4-4 | 建立数据库体积与启动耗时基线 | 在同一代表性数据库上记录 DB/WAL/SHM 字节、`dbstat` 各表/索引页数、`page_count`、`freelist_count`、spill 字节、canonical 必留数据量；记录新 Electron 进程启动至 renderer load 的总耗时及迁移/恢复分段耗时。报告含 SQLite 版本、运行环境、缓存条件和取数脚本。该单机可复现基线不宣称 OS/文件缓存冷态、慢设备 p95 或生产分布，也不等待这些发布后观察来阻断独立功能开发 |
| M4-5 | 估算可清理空间和不可清理下限 | 对候选旧 transcript、重复正文投影、可降级 spill、索引分别称重；列出可删、必须保留、等待 spill 后才可删的数据集合；计算清理后 DB 的理论体积区间，并注明 canonical/流程状态等必须保留数据 |
| M4-6 | 实现并隔离验收旧数据逻辑清理 | 开发有界、事务化、可续跑的清理器及备份/恢复核验；只针对有明确 owner 决议、已证实无受支持 reader/recovery 依赖的数据建候选，legacy_required 和当前 turn/recovery 必需 transcript 一律保护。隔离 SQLite 覆盖逐批行数/字节、断点续跑、失败回滚、canonical/新投影读取和备份恢复。M4-3 的全局 reader 删除批准不是清理器开发门禁；若候选仍被旧 reader 消费，则该数据不能清理。生产执行仍需 §8.8.5 rollback-floor 发布审计和逐数据集授权 |
| M4-7 | 实现并隔离验收 SQLite 文件空间回收 | 为经授权且已逻辑清理的隔离 profile，在无活跃 claim/queue/turn/queued-stream、完成 WAL checkpoint 后执行 `VACUUM` 与 incremental reclaim；归档 DB/spill 并校验后才改库。记录耗时、DB/WAL/SHM、page/freelist 前后值、执行前可用空间、归档字节和 VACUUM 临时副本的保守峰值空间上界；同步归档成功/失败 manifest。进程级同步 `VACUUM` 的瞬时峰值不可在本线程精确采样，必须明确报告为上界而非观测值。真实 profile 操作须有独立维护窗口。验收以 DB 文件实际字节下降为准，freelist 变化单独报告 |
| M4-8 | 复测启动收益与体积归因 | **工程测量完成；启动性能目标未证明通过（2026-10-05，schema v50 合成样本）**。5 组交错顺序配对新进程测量；认证后的 DB 202,379,264 B，清理一条正文并 VACUUM 后 201,670,656 B，净降 708,608 B；相比未认证输入仍大 233,472 B。before/after 总启动 p50 为 905/866 ms，但首次 before 样本 1,983 ms；配对差值中位数仅 −2 ms，不能归因改善。报告拆分认证准备、消息页回收及 History/cache 等阶段；OS 缓存未控，不宣称冷启动/生产收益。见[2026-10-05 复测报告](./session-storage-refactor-maintenance-profile-2026-10-05.md)及 JSON |
| M4-9 | 验证空间维护安全性 | 验证取消/进程中断、磁盘不足、活跃 turn 阻止维护、VACUUM 失败等情况不会造成数据损坏；维护任务能安全重试；维护完成后抽样会话、API context、canonical/spill 校验通过 |

**M4 结果分开报告，不汇总成单一本机功能退出门禁：**

- **启动性能结论**：M1-7 证明恢复扫描复杂度脱离已完成终态历史规模；M4-8 报告当前 synthetic 工程样本结果。当前证据未证明启动改善；慢设备、OS 冷缓存与生产分布只在具备合适部署观测条件后补充，不阻断功能完成，也不得据此宣称性能目标通过。
- **隔离数据库缩小结论**：M4-4…M4-9 的 synthetic 验收可报告隔离数据库是否缩小；若字节未下降，只能判定该样本未缩小并解释原因，不阻断存储功能交付。真实用户 profile 的空间变化是独立运营结果。
- **旧读路径退役目标**：M4-1…M4-3 独立通过；只要仍有需支持的 `legacy_required` 会话且没有迁移方案，旧读路径就不能退役。此目标可以保持未完成，不阻断新存储功能交付。

**两条部署后执行路径不互为前置，也不属于本机功能完成门禁：** reader 退役使用“全体受支持 session disposition → 正式版本观察 → owner 批准 → 删除 reader → 全量回归”；单 session 正文清理使用“兼容 R/C 候选包回滚演练与审计 → 正式部署 gate → 该 session 精确认证及无活动引用 → 该 session 清理 → 可选的独立空间回收”。后一路不要求 M3 全量补迁成功，也不要求 reader 全局删除；只要求获批 session 的所有受支持 reader/recovery 路径均能严格读 canonical，且 `legacy_required` 不进入候选。候选包回滚演练可在本机 disposable profile 完成；正式部署、owner 授权和真实数据清理只约束生产操作。不得因两个清单相邻而串行化。

没有给 M4 设定日历日期；分别由上述独立结果触发。迁移完成本身不代表启动收益和磁盘收益均已达成；这些结果未达成也不反向阻断本机功能完成。

## 4. 版本升级与中断恢复矩阵

| 升级场景 | 启动行为 | 完成标志 |
| --- | --- | --- |
| 新安装 | 建立最新 schema；新数据走 canonical 新写路径；无历史分类任务；若需回退 legacy reader，先为新会话执行回滚桥接 | `schema_ready`；回滚时还须 `rollback_bridge_complete` |
| 旧 schema 升级，M1 初次分类未完 | 执行 schema migration；旧恢复路径继续兜底；分类 worker 按持久游标分批推进 | 分类状态 `complete`；未完成修复均有队列项 |
| 旧 schema 升级，M1 已完成 | 只恢复非终态 streams 与 pending/retry 待办；不全量读取终态 streams | 启动 trace 的访问集合符合验收 M1-6 |
| eligible 旧会话首次访问 | 使用旧路径不作为最终返回；全量折叠 canonical，校验后写新缓存，再由新路径返回 | `projection_migrated` 且缓存 watermark/generation 有效 |
| ineligible 旧会话访问 | 走 legacy 读路径，标明 eligibility 原因；不伪造/写入不完整新缓存 | `legacy_required` 保持可查询，旧数据未清理 |
| 迁移中升级中断 | 已提交批次保留；未提交批次回滚；重启按 cursor/待办幂等续跑 | 无重复义务、无漏项，游标与已完成批次一致 |
| 新版本需要回滚 | 开发阶段验证回滚读者的数据契约与 canonical-only 写围栏；正式回滚操作按 §8.8.5 使用已发布并验证的安装产物执行。若目标依赖 legacy reader，必须先完成受栅栏保护的 canonical→legacy 桥接。 | 开发验收以代码/隔离 DB 测试证明读写不变量；生产回滚前须有对应发布审计记录与实际安装包演练 |

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
| M1-7 启动恢复复杂度 | **完成（v50 持久化 workset 实证）** | `electron/runtime/sqliteAgentHistory.ts`、`sqliteAgentHistory.test.ts`、`electron/database/schema.ts`、`migrations.ts`、`migrations.agentHistory.test.ts` | 原测试仅检查终态 `read()` 调用数，未发现 SQL 枚举所有 stream；现将非终态集合物化为 `canonical_history_recovery_work`，用事件/stream trigger 同事务维护，历史通过有界可续跑 cursor 分类。128→640 条终态增长时 workset 固定为 1，实际 recovery 仅读取该条；`EXPLAIN QUERY PLAN` 不访问 History 源表。覆盖 reopen/resume、游标前新增、终态化/反终态化、删除及 session owner 更新。全量 872 文件/8,223 项通过，Electron incremental build 通过。首次 backfill 完成前保留旧恢复路径；这项复杂度证明不等于 M4-8 总体启动耗时已改善 |
| profile 升级后只读 canonical audit | 待正常 schema upgrade | [M3-6 scope census 复核](../review/2026-10-05-session-storage-scope-census-review.md) | 当前本机 profile 为 schema v46，缺少 v49 durable run/audit 水位结构。待应用正常升级后只读重跑 canonical fold audit；不在本计划开发步骤中手动迁移真实 profile，也不将此等待项当作独立功能开发阻断 |
| M2-6 | 功能验收完成 | `electron/runtime/sessionStorageShadow.test.ts`、`sessionStorageCutover.test.ts`、`sessionTranscriptProjection.test.ts`、`electron/database/migrations.sessionContentCutover.test.ts` | 选择 canonical-compatible reader 与已清正文写围栏；代码/隔离 SQLite 覆盖 History/spill/cursor/owner 故障。安装包切换和正式发布按 §8.8.5 办理，不计入功能完成 |
| M2-7 | 功能验收完成 | `sessionTranscriptProjection.test.ts`、`sessionStorageCutover.test.ts`；[旧 profile schema 升级 smoke](../review/2026-10-03-session-storage-rollback-floor-audit.md#v024-arm64-legacy-schema-19-profile-upgrade-2026-10-04) | 已有/已迁移会话覆盖 canonical 正文读取、写围栏与重开；R→C→R 安装包演练属于发布验收 |
| M2-8 | 功能验收完成 | `sessionStorageShadow.test.ts`、`sessionTranscriptProjection.test.ts` | 新建会话从 canonical 写入到 shadow/read projection 的 SQLite 行为已覆盖；不依赖安装包版本切换 |
| M2-9 | 功能验收完成 | `migrations.sessionContentCutover.test.ts`、`sessionStorageCutover.test.ts`、`sessionTranscriptProjection.test.ts` | History/spill 损坏、allocator/cursor/owner 漂移、cache miss/reopen 与清理中断均按 fail-closed/可恢复契约验证；跨版本安装演练留在 §8.8.5 |
| 发布流程 | 本地 schema-v50 arm64 R→C→R pending 技术演练完成；源码级 renderer→preload→IPC 消费者审计完成，R v50 arm64 实包 renderer display/summary/fault isolation 与 route/reuse-user preload 本地路由已验证；route probe 发现 terminal/message 状态竞态，当前源码已测试修复，并由当前源码构建的本地 arm64 app 经 renderer→preload→IPC 复验失败路径：turn 与 assistant 均持久为 failed、reopen 后 integrity/FK 正常；该包 sourceTreeClean=false、清理关闭且兼容记录为空，仅为开发复验；使用 unsupported synthetic model 在 provider 前失败，真实服务成功生成/流式输出未验证，也不据此断言模型配置缺失；Windows x64 `pack:win` 交叉构建成功（TEST ONLY、`sourceTreeClean=false`，未安装运行）；当前源码 arm64 app 的 schema-v19→R 升级/IPC/restart 复验已通过；固定 clean R snapshot `837a9c7` 与 C candidate `3bd50b2` 均基于 I-12 HEAD `87794f0c`，相关 `ChatView` renderer 文件包含 v255 终态接管修复且两候选一致；SC-01C 的 R→C-on→R 矩阵与 SC-02 独立包审已通过。`ChatView.abort.test.tsx` 本轮定向回归 2/2 通过，因此关闭此前“待本机复验”状态，不重复执行完整矩阵；正式 R/C 发布证据及其余平台原生安装验收另按发布流程完成（Windows 移交 Windows 主机/CI，不阻断本机开发） | [源码消费者架构复核](./session-storage-reader-architecture-audit.md)、[R v50 renderer display/summary 包验证](../review/2026-10-03-session-storage-rollback-floor-audit.md#r-v50-arm64-renderer-ipc-displaysummary-and-fault-isolation-2026-10-05)、[route/reuse-user preload 与终态竞态](../review/2026-10-03-session-storage-rollback-floor-audit.md#r-v50-renderer-preload-reuse-user-route-and-terminal-status-recovery-2026-10-05)、[修复后终态失败路径实包复验](../review/2026-10-03-session-storage-rollback-floor-audit.md#local-schema-v50-post-fix-renderer-route-failure-recheck-2026-10-05)、[当前源码 arm64 旧 profile 复验](../review/2026-10-03-session-storage-rollback-floor-audit.md#current-source-arm64-app-schema-v19-old-profile-upgrade-recheck-2026-10-05)、[Windows x64 构建探测记录](../review/2026-10-03-session-storage-rollback-floor-audit.md#local-schema-v50-windows-x64-installer-build-probe-2026-10-05)、[技术方案 §8.8.5](./session-storage-refactor-technical-design.md#885-兼容回滚版本的制作与发布流程待实施)、[schema-v50 arm64 演练](../review/2026-10-03-session-storage-rollback-floor-audit.md#local-schema-v50-r-to-c-to-r-arm64-technical-drill-2026-10-05)、[旧 profile/retry 追加证据](../review/2026-10-03-session-storage-rollback-floor-audit.md#local-schema-v50-old-profile-upgrade-and-retryrecovery-readers-2026-10-05)、[route/reuse-user 与写围栏追加证据](../review/2026-10-03-session-storage-rollback-floor-audit.md#local-schema-v50-r-routereuse-user-and-completed-fence-check-2026-10-05)、[backup/restore reader 追加证据](../review/2026-10-03-session-storage-rollback-floor-audit.md#local-schema-v50-r-canonical-only-backup-and-restore-reader-2026-10-05)、[冷/暖缓存与 API switch 追加证据](../review/2026-10-03-session-storage-rollback-floor-audit.md#local-schema-v50-r-coldwarm-projection-cache-and-api-read-switch-2026-10-05)、[source spill 故障追加证据](../review/2026-10-03-session-storage-rollback-floor-audit.md#local-schema-v50-r-source-spill-fault-isolation-2026-10-05)、[History 故障追加证据](../review/2026-10-03-session-storage-rollback-floor-audit.md#local-schema-v50-r-history-payload-fault-isolation-2026-10-05)、[owner/watermark/allocator 追加证据](../review/2026-10-03-session-storage-rollback-floor-audit.md#local-schema-v50-r-owner-watermark-and-allocator-fault-cases-2026-10-05)、[cursor UPDATE/DELETE 追加证据](../review/2026-10-03-session-storage-rollback-floor-audit.md#local-schema-v50-r-allocator-cursor-updatedelete-fault-cases-2026-10-05)、[全局水位/未配对 cursor 追加证据](../review/2026-10-03-session-storage-rollback-floor-audit.md#local-schema-v50-r-global-commit-order-gap-and-unpaired-cursor-2026-10-05)、[v45 marker 重建实包证据](../review/2026-10-03-session-storage-rollback-floor-audit.md#local-schema-v45-allocator-marker-reconstruction-in-r-v50-package-2026-10-05)、[x64 reader smoke](../review/2026-10-03-session-storage-rollback-floor-audit.md#local-schema-v50-r-macos-x64-canonical-only-reader-smoke-2026-10-05)、[x64 spill/History fault smoke](../review/2026-10-03-session-storage-rollback-floor-audit.md#local-schema-v50-r-macos-x64-spill-and-history-fault-isolation-2026-10-05) | v50 clean snapshot arm64 R/C DMG 均通过校验；C 实际 worker 清理 102 条中的 100 条至 pending，R 包 renderer IPC 的 message page/API context/search corpus 精确读取 102 条，全局搜索命中且 preview 正确；超过 60 秒不推进，C 再升级续跑至 complete。补充 schema-v19→v50 旧 profile 升级、retry/recovery 只读 IPC，以及当前 R main handler 对 canonical-only `reuse-user` route 的读取；complete 样本的新 turn 被写围栏拒绝且无副作用。v50 backup 文件 writer 与 production restore reader 对拍 102 条零差异；冷 L1 cache/warm restart/关闭 API read switch 后 page、API baseline 与 search corpus 仍返回相同 102 条；R 对 warm-cache 缺失 spill、损坏 History、event/stream owner drift fail-closed，健康会话隔离可读；错误 cache anchor 自动从 History 修复，allocator invalid marker 全局 fail-closed。仅 TEST ONLY 元数据、本地 ad-hoc 包；macOS arm64 完成本地 R/C 演练，macOS x64 仅 cleanup-disabled reader/fault smoke；配对/未配对 cursor 与全局 commit-order gap 已在当前 R v50 arm64 包覆盖；schema-v45→R v50 安装包迁移与 marker 重建已验证；macOS arm64/x64 本地 reader 与 x64 spill/History 故障 smoke 均通过（x64 cleanup disabled）；Windows 原生安装运行移交对应平台流程、不阻断本机计划；正式发布审计与真实数据停写/清列仍按独立发布及数据授权门禁执行 |
| §8.8.5 schema-v50 R/C arm64 本地技术演练 | **pending R→C→R 与续跑已通过；正式 rollback floor 未放行** | [2026-10-05 schema-v50 R→C→R 演练](../review/2026-10-03-session-storage-rollback-floor-audit.md#local-schema-v50-r-to-c-to-r-arm64-technical-drill-2026-10-05) | clean snapshot `773f5abeeeef34c27accaf7945fdc5423fbc0ba8`；R DMG SHA-256 `063a78504562dc15f1a69900459ebc9ebc0be50d1d7f58039a7683b098405c7a`，C DMG SHA-256 `9cabd9dfb0f01771bb41ac115497286509f05a1c0697baf786d6e0c1877769d5`。C 实际 worker 建立 pending，R renderer IPC 覆盖 page/API context/search corpus、global search 和 preview；pending 不续清，C 再启动完成续跑；仅 arm64、本地 TEST ONLY 元数据，非正式发布/全消费者审计或生产清理授权 |
| M3-1 | **完成（v310 范围纠偏）** | `electron/runtime/sessionProjectionMigrationInventory.ts`、`sessionProjectionMigrationInventory.test.ts` | 测试覆盖 internal/hidden 排除及内部 History 健康/损坏；摘要绑定 stream 元数据和所有原始 event 行；stream/event session 错配 fail closed；父会话 approval lifecycle、IM remote/primary、automation section 均在迁移 cohort；未知归属 fail closed；scope 只读且 deleted reconciliation 不误计排除项。 |
| M3-2 | **完成（v310 durable scope）** | `electron/runtime/sessionProjectionMigration.ts`、`sessionProjectionMigration.test.ts`、`sessionProjectionMigrationInventory.ts`、`electron/database/schema.ts` v49 | durable count/History health summary 与 digest 持久化并参与 inventory hash；文件 SQLite reopen/resume、篡改摘要拒绝复用、跨连接 census 后并发新增/删除拒绝旧 run；internal-hidden 无 item，remote/automation 正常入队。8 个聚焦文件 69 项通过，Electron incremental build 与 `git diff --check` 通过。下一步 M3-3。 |
| M3-3 | **完成（v311 范围纠偏）** | `electron/runtime/sessionProjectionMigration.ts`、`sessionProjectionMigrationInventory.ts`、`sessionProjectionMigration.test.ts` | worker 在处理 item 前复核当前 scope；internal-hidden/unknown scope 漂移会让 run 进入 `needs_attention`，不调用 transcript reader、不写 eligibility/cache、不生成 legacy/failure，且不能自动续跑。运行中新增内部有/无 History 会话不进入 item 集；remote IM/automation 正常迁移且 IM reuse 不变。8 个聚焦文件 72 项通过，Electron incremental build 与 `git diff --check` 通过。 |
| M3-4 | **完成（v312 范围纠偏）** | `electron/runtime/sessionProjectionMigration.ts`、`sessionProjectionLegacyQueue.test.ts`、`sessionStorageCutover.test.ts` | legacy queue report 在同一只读事务快照内复核所有队列项当前仍属于产品 cohort；internal-hidden/unknown/deleted 污染项 fail closed，不会变成用户 retain-legacy 决策。原有 owner/decision/中英文说明、补迁新增项计数、legacy 正文读取与 cleanup 拒绝保持。8 个聚焦文件 73 项通过，Electron incremental build 与 `git diff --check` 通过。下一步 M3-5。 |
| M3-5 | **完成（v313 范围纠偏）** | `electron/runtime/sessionProjectionConsistencyAudit.ts`、`sessionProjectionConsistencyAudit.test.ts`、`sessionProjectionRetirementCandidates.ts`、相关迁移/清单测试 | audit 仅以产品迁移 cohort 为投影分类范围，并分别对账 internal History 健康与原始事件摘要、scope anomalies、迁移 run/items/legacy queue、cache 与 canonical watermark；未知 scope、内部 History 损坏/变化及分母漂移均 fail closed。M4-1 候选仅按 migration cohort 计数。混合场景覆盖 user/remote/automation/internal/unknown。8 个聚焦文件 75 项通过，Electron incremental build 与 `git diff --check` 通过。 |
| 历史只读预检（旧编号 M3-6） | **完成（实际 profile 只读复核，legacy schema 边界已记录）** | `scripts/session-projection-scope-profile-audit.ts`、`electron/database/sqliteStore.ts` 的 `openSqliteDatabaseReadOnly`、[2026-10-05 复核记录](../review/2026-10-05-session-storage-scope-census-review.md) | 真实 profile 只读查询：schema v46，291 sessions；26 `user/primary`、265 `internal/hidden`、scope anomaly 0；141 个内部会话有 900 个旧格式 events，stream 版本/数量不符、序号不连续、JSON 无效均为 0。`data_version` 前后 2、该连接 `total_changes` 前后 0；未运行 migration/worker。因 profile 没有 v49 run 表且 events 缺少新 audit 水位列，完整 canonical fold audit 待正常 schema upgrade 后再做。 |
| M4-1 | **候选范围按 M3-5 已重验；owner review 可恢复** | `electron/runtime/sessionProjectionRetirementCandidates.ts`、`sessionProjectionRetirementCandidates.test.ts`、`electron/runtime/sessionProjectionConsistencyAudit.ts` | 候选分母已改为 `migrationSessionCount`，internal-hidden 不再成为候选或未分类 blocker；新增 history-absent 正文基线→M3 audit→M4-1 报告隔离集成，验证合格 user 会话归为 projection-migrated、system-role 会话按已登记 reader 保留 exception，legacy 正文不清理。真实 profile schema v46 尚无新格式 migration run，故不生成或批准真实 profile 的退役候选。 |
| M4-2 | 功能验收完成；真实版本观察待发布后执行 | `electron/runtime/sessionTranscriptProjection.ts`、`sessionProjectionObservation.ts`、`sessionProjectionObservation.test.ts`、`sessionProjectionObservationReport.test.ts`、`scripts/session-projection-observation-report.ts`、`electron/agentLogger/*` | transcript read 结构化记录路径/结果/耗时/稳定错误码和 app version，不记录正文；离线 CLI 递归读取 agent log，按版本/时间窗汇总 read p50/p95、shadow 差异、reconciliation/cutover 事故，输出可归档 JSON。空样本、缺 shadow、坏日志、缺耗时、未知 event/outcome、failed read 缺稳定错误码、startup-blocked/startup-failed/commit-uncertain、shadow 不可用/差异、legacy-fallback/rejected、失败/事故及超预算均不能通过。CLI 测试已纳入 electron Vitest project；两文件 8 项与脚本 TypeScript 检查通过。生产观察尚无已发布版本证据；只在 M4-3 reader 移除时作为安全门，不阻断其它 feature code 工作 |
| M4-3a | **方案 B 正文基线和 M4-1 合成候选集成 TDD 已通过** | `electron/runtime/sessionProjectionLegacyBaseline.ts`、`sessionProjectionLegacyBaseline.test.ts`、`sessionProjectionMigration.ts`、`sessionProjectionConsistencyAudit.ts`、相关 migration/audit/projection 测试 | 仅对 census 中 `history-absent` 的产品会话尝试按消息顺序写 canonical ID/role/content/timestamp 快照；消息骨架字段留在 SQLite。事务写围栏复核 session generation、ownership/visibility、History 水位和 `message_revision`；不合格 role/status 保持 legacy-required，清理围栏/范围或骨架变化 fail closed。M3 audit/legacy queue 已分别统计仍需 legacy reader 与已成功基线补迁项；提交后认证失败可重试收敛，既有且与旧正文冲突的 History 不会重复补写。8 个聚焦文件 181 项、Electron incremental build、`git diff --check` 通过；重开、重复调用、system role、未完成状态、cleanup write-stop、History 冲突、超大正文 spill/cache-loss 与并发漂移均有隔离测试。M4-1 合成候选端到端验证已通过；profile 正常升级后只读补 audit 属后续真实环境证据，不运行真实 profile migration。 |
| M4-3 | **本机集成已完成；reader 退役是上线后独立决策，不阻断功能完成** | `electron/runtime/sessionTranscriptProjection.ts`、M4-1 候选清单、M4-2 真实版本观察、[M4-3 reader 退役门槛状态](./session-storage-refactor-m4-3-status.md) | 本分支 I-12 集成验收已完成，HEAD `87794f0c69b5bee1ac77698f9b4844be9f7d2912` 包含 `origin/main` HEAD `5440f7764b92d2512593c7bf139c21958b7f26a0`。旧 reader 仍保留；是否退役要等真实用户升级观察、完整会话去向和 owner 决议，属于上线后的兼容性维护，不是本机 feature 完成条件。真实 profile audit 由用户设备在正常升级后执行。 |
| M4-4 | 合成工程基线完成；生产分布不是本项门禁 | `electron/database/sessionStorageProfile.ts`、`sessionStorageProfile.test.ts`、`scripts/create-session-storage-profile-fixture.ts`、`scripts/session-storage-profile.ts`、`scripts/session-storage-cold-start-profile.ts`、`electron/main.ts`、[2026-10-04 基线报告](./session-storage-refactor-profile-baseline-2026-10-04.md) | 在同一 schema v48 合成数据库上完成只读体积画像和 Electron 新进程至 renderer load 分段采样。包含 DB/WAL/SHM、全部 dbstat 表/索引对象、page/freelist、spill、canonical 必留 payload/stream bytes、SQLite/OS/Node/Electron 元数据。新增 35 表/索引测试复现原 top-30 截断并红绿修复；profile 聚焦测试 5/5 通过，Electron incremental build 与冷启动完整阶段采样成功。报告记录样本较历史画像 3,895 个 canonical events 少（本样本 546），故启动耗时仅作单机工程参考，不宣称生产 workload、冷 OS 缓存或 p95；慢设备/生产分布观察不阻断独立功能开发 |
| M4-5 | 完成 | `electron/database/sessionStorageCleanupEstimate.ts`、`sessionStorageCleanupEstimate.test.ts`、`scripts/session-storage-cleanup-estimate.ts`、`scripts/create-session-storage-cleanup-fixture.ts`、[合成样本报告](./session-storage-refactor-cleanup-estimate-2026-10-04.md)、[完整估算 JSON](./session-storage-refactor-cleanup-estimate-2026-10-04.json) | 只读估算覆盖两个配置 workspace roots、按每 root 100 个目录计量、未索引目录保护、精确 identity 正文候选、transcript snapshot 保护、过期 degradable spill、source-of-truth/orphan spill、全量 index 和 canonical/流程状态下限。schema v48 合成样本：105 个 indexed dirs 中 2 个超出保留数、1 个未索引；1 条精确正文候选 472,600 B；178 个 transcript snapshot 10,732,981 B；expired degradable 34 B、source-of-truth 31 B、orphan 28 B；不授权任何删除。样本 DB 在估算前后 SHA-256 相同。TDD 新增页面上限回归：旧逻辑将缩小上限错误限制为正文 14,000 B，而 `messages` 表占 16,384 B；改为按可变表 dbstat 页面给保守上限后聚焦 profile/estimate 7/7 通过。实际估算 shrink 区间 0–18,317,312 B 仅为整表页理论上限，不是收益预测；物理缩小仍需后续 VACUUM 实测 |
| M4-6 | 清理算法/隔离验收、SC-SCOPE 源码/TDD、SC-SCOPE-PKG 最终候选包范围矩阵及 SC-02 独立证据审阅完成；SC-03 真实数据集授权待具体 owner 决议；真实 profile 清理未执行 | `electron/runtime/sessionStorageCutover.ts`、`electron/storage/sessionMessageContentCleanupMaintenance.ts`、`electron/main.ts`、`sessionStorageCutover.test.ts`、`sessionMessageContentCleanupMaintenance.test.ts` | 复用 Phase 5.5 逐 session canonical 认证、write-stopped/pending 状态机、有界事务批次、游标/manifest/generation CAS、失败记账和 reopen 终验；canonical/spill/cursor/活跃 turn 漂移 fail closed，legacy_required 不获清理资格。生产 worker 仅 packaged app 注册、延迟 60 秒启动、每 15 分钟运行，每轮最多 2 个 session、每个 session 1 个 100 行批次；每个 retained session 在 write-stop 前经逐次 release gate 执行完整 canonical API/route 认证，以便恢复资格撤销或 transcript cache 缺失情形；失败候选保持 retained 并计入 ineligible。begin/batch/终验各阶段也重新读取 §8.8.5.C 发布门禁，最终验证使用重开 SQLite 连接。fake-timer 隔离测试证明延迟、周期复核及 stop 后不再调度。部署开关默认 false 且兼容记录为空，因此当前构建不运行清理。SC-SCOPE 已将持久 owner scope 接入 worker 与直接 production boundary：worker 查询只限授权 session IDs，每个 destructive phase 在同一 DB transaction 中复核 profile identity、session snapshot、期限和撤销；无有效 scope 不注册 worker，pending 需明确重新授权后才能续跑。SC-SCOPE-PKG 已在最终 C-on arm64/x64 候选上验证 A/C 授权、B 拒绝、错误 profile、过期/撤销/重启、pending 暂停续跑及 worker/直接 boundary；具体 artifact/resource hashes 与结果见 [SC-SCOPE-PKG manifest](./session-storage-cscope-package-matrix-2026-10-06.json)。SC-02 已通过；真实 C-on 清理仍须完成 SC-03 的具体 dataset owner scope 授权及 RC-02 部署门禁。端到端隔离回归清理后关闭/重开 SQLite，再由 canonical-only reader 备份恢复原始正文。transcript snapshots 因 turn/recovery 依赖继续保留，待 owner 决议；真实用户数据清理仍须逐数据集授权 |
| M4-7 | 功能及隔离验收完成；未对用户数据库执行压缩 | `electron/storage/sessionStorageMaintenance.ts`、`sessionStorageMaintenance.test.ts`、`src/shared/api.ts` | 红测发现 maintenance 只看 execution claim/queue，会漏掉无 claim 的 active persisted turn；补查 active turn 与 queued/streaming message fence。红测发现压缩后半程异常会删除唯一归档；现仅清理未验证的 partial archive，归档验证后故障则保留 DB/spill 并写 failed manifest，可重试。成功归档 manifest 记录耗时、DB/WAL/SHM、page/freelist、归档字节、可用空间及保守峰值估算。SQLite vacuum 测试验证文件实降、归档可读、active turn 拒绝、后半程失败归档保留并可重试；5/5 通过。瞬时峰值字段明确是上界估算，不冒充采样值；未操作真实用户数据库 |
| M4-8 | 工程测量完成；启动性能目标未证明 | `scripts/session-storage-maintenance-profile.ts`、`scripts/session-storage-cold-start-profile.ts`、[2026-10-05 复测报告](./session-storage-refactor-maintenance-profile-2026-10-05.md)、[机器可读 JSON](./session-storage-refactor-maintenance-profile-2026-10-05.json) | 当前 schema v50 合成负载、5 组交错顺序配对。认证后到清理/VACUUM 后减少 708,608 B；对比原始样本仍大 233,472 B。总启动 p50 905→866 ms，但配对差值中位数 −2 ms，且首样本噪声高；不证明性能改善。History 分类 33→32 ms、恢复 5→5 ms。OS/文件缓存未控，不宣称冷启动或生产收益 |
| M4-9 | 故障安全及隔离验收完成；未对真实 profile 操作 | `electron/storage/sessionStorageMaintenance.ts`、`sessionStorageMaintenance.test.ts`、`sessionBackupManager.test.ts`、`sessionTranscriptProjection.test.ts`、`spillStore.test.ts` | 覆盖活动 claim/turn 拒绝；AbortSignal 在 archive/VACUUM 边界取消；初始及归档后空间不足由 `statfs` 探针 fail closed，前者不留 archive root，后者保留已验证归档且源库不变；VACUUM 阶段错误与 reclaim 后错误保留归档/失败 manifest，可重试；独立子进程在 SQLite VACUUM 中 SIGKILL 后重开 `integrity_check=ok`、FK 无差异并可安全重试。新增事件循环红测发现归档后主动 yield 会让排队中的会话写入落入 VACUUM 前、却不在归档快照；移除两处 yield 后写入只能在维护完整结束后执行。带真实 canonical History、骨架、API context 与 source-truth spill 的文件 SQLite 清除 projection cache/压缩/重开后逐项对拍，归档 spill 与原文件字节一致。相关 5 文件 173/173 通过，Electron incremental build、shared typecheck、diff check 通过。磁盘不足为注入容量探针；硬杀演练使用隔离 SQLite，不人为填满设备磁盘 |

## 6. 与技术方案的同步要求

本计划确定迁移时机后，技术方案 §7 的“老会话按需懒迁移”应解释为：**Phase 2 双读上线后，eligible 旧会话在首次打开/resume/API context 时从 canonical 全量折叠并建立新缓存；其余 eligible 会话在 M3 后台分批补迁；ineligible 会话保留 legacy 路径；M4 满足门禁后才退役旧读路径。回滚必须使用已演练的路线：需要 legacy reader 的目标版本先执行并核验 canonical→legacy 桥接；采用 §8.8.5 兼容版本 R 时则安装 R 并原样读取 canonical-only，不能只关新读 flag，也不能回填已清正文。**

任何会改变 eligibility、投影语义版本、回滚能力或 legacy 例外策略的设计修改，必须同时更新本计划对应任务与完成判据。
