# Spill 引用索引与可续跑回填方案

## 目标与边界

当前 spill 目录的维护必须知道 canonical History 是否仍引用某个 locator。完整引用集由 `agent_history_events.payload_json` 和 `session_transcript_entries.messages_json` 中的 spill descriptor 共同构成。扫描不仅服务于启动期 degradable retention，也服务于 source-truth GC、崩溃孤儿文件回收、存储 profile 和清理估算。任何漏记都可能让 GC 删除仍被引用的 source-truth 文件，因此索引的首要目标是保持引用完整性，启动提速排在其后。

本方案分两项：建立事务维护的规范化引用索引；对已有数据库做可暂停、可续跑、可校验的分批回填。索引完整性尚未得到证明前，现有严格全量扫描继续作为安全判据，索引不能单独授权文件删除。

## 与 main 会话存储接口的边界

`main` 已将会话存储组织为 `SessionQueries`、`SessionCommands`、`SessionExecutionStore`、`ContextPort` 和 `SessionRecoveryPort` 等业务端口；SQLite 由 `createSqliteSessionStorage` 在组合根内绑定。`StorageLifecycleControl` 是仅供 host/bootstrap 使用的维护生命周期控制，不属于 SDK 或业务读写接口。后续 Spill 优化必须沿用这一边界：

- `spill_reference_index`、回填状态、generation、SQLite migration 和 SQLite 查询均属于 Electron 持久化实现内部细节。可以放在存储实现拥有的私有 repository/adapter 中，由 SQLite composition root 组合；不得把 `DatabaseSync`、SQL、表名、游标、generation、索引状态或 `SpillDescriptor` 索引行加入 SDK、renderer DTO、`SessionQueries`、`SessionCommands` 或执行业务接口。
- History/transcript 的 canonical 写入仍经各自现有持久化 owner；索引双写作为其内部事务副作用完成，不新增要求 SDK 或业务调用方参与的第二次写入，也不改变 `HistoryPort`/transcript 对外语义。
- 回填和对账作为 host-owned 的后台维护任务注册到现有 `StorageLifecycleControl`/`createSqliteSessionStorageHost` 生命周期，复用 ready、pause、stop、quiesce 时机。若现有 lifecycle 能力不足，只能增加 host-only 的维护编排能力；不得把迁移/索引操作塞进业务端口，也不得另建一套与 host lifecycle 并行的启动调度器。
- `collectSessionStorageProfile` 是 Electron 数据库诊断实现，不是 SDK/业务端口。若将它作为首个索引只读消费者，索引读取只能留在数据库/profile 内部适配器，输出保持现有 profile DTO；不能把索引查询能力透传给调用方。状态无效时保留原 strict scan 回退，且 profile 结果绝不授权删除。
- MCP、Agent 日志等非会话存储任务继续由各自 owner 持有文件和策略语义；共享的只是 host 调度约定/水位机制，不把它们改造成 SessionStorage 端口。

实现验收必须包含边界检查：除明确登记的 Electron SQLite 持久化实现外，SDK、renderer、IPC DTO 与业务模块没有新增 Spill 索引/schema/SQL 依赖；现有业务端口调用方无需感知索引启用、回填或失效。

## 当前行为与需要保持的不变量

- source-truth spill 文件先完整写入、同步并校验，再把 locator 写进 canonical SQLite 事务；事务失败时文件作为可回收孤儿保留。
- 删除 session 时，canonical 删除和 source-truth GC queue 入队位于同一 SQLite 事务。GC 只有在严格扫描完成后才能判断 locator 是否共享，并执行 unlink。
- degradable retention 只可能删除被 canonical 引用且过期的 degradable descriptor，不能删除 source-truth。
- 两张 canonical 表是引用事实源。坏 JSON、未知 descriptor schema、表缺失或扫描中断都必须 fail closed：不得把不完整结果当作完整引用集。
- 扫描涉及 root fence，以便文件写入、引用提交和文件删除之间遵守既有并发顺序。
- 索引状态 `complete` 只是某一受支持写入协议下的一次对账结果，不可脱离数据库版本边界和恢复协议作为永久可信证明。

索引方案必须保持以上行为；不得通过“索引暂时没有记录”推断 locator 已无引用。

## 3. 规范化引用索引

### 数据模型

新增 `spill_reference_index`，一条记录表示一个 canonical owner 中一个 descriptor 引用。建议字段：

| 字段 | 用途 |
| --- | --- |
| `owner_table` | `agent_history_events` 或 `session_transcript_entries` |
| `owner_key` | History 使用稳定 event 主键；transcript 使用 `(session_id, version)` 的稳定编码 |
| `descriptor_path` | descriptor 在 JSON 结构中的位置，用于同 owner 多引用定位和校验 |
| `locator` | spill 文件名，作为共享引用查询键 |
| `kind` | `source-of-truth` / `degradable`，防止清理分类失真 |
| `descriptor_json` | 规范化 descriptor 快照，用于回填核对、冲突诊断和 schema 扩展 |
| `updated_at` | 最近一次事务维护时间，仅用于诊断 |

唯一键为 `(owner_table, owner_key, descriptor_path)`；对 `locator` 建索引。所有字段由 SQLite 本地维护，不放到 renderer 或共享 DTO 中。

`descriptor_json` 是校验材料，不是内容事实源；spill 文件仍由 descriptor 的长度、hash 和协议校验。若实现评估表明快照占用不可接受，可以在落地前改成必要元字段列，但不能删掉 owner 身份、路径和 descriptor 版本校验能力。

引用发现必须由完整遍历语义定义，不能把当前 strict collector 的输出本身当成完整性证明。I-01 先修复/冻结 collector 契约：遍历所有数组元素和对象属性；每个已知 marker 都独立校验并收集；收集 marker 后仍遍历所有非 marker 兄弟字段；未知 spill marker 或格式非法的已知 marker 在任意深度都拒绝整行。若一个对象同时含两个已知 marker，则两个 descriptor 都收集；内联 descriptor 作为当前 path 的单个 leaf，若它同时包含额外 marker/descriptor 子树则拒绝为歧义结构。输出稳定 JSON Pointer path。collector 提供有界 descriptor visitor/iterator，每次最多输出固定行数或字节数，回填/对账不为大 owner 构造无界 descriptor 数组。验收用手工编写的期望 `(owner, path, locator, kind)` 集合，而非用同一 collector 结果互相比对；覆盖双 marker、已知 marker 加兄弟字段嵌套引用、数组/多层嵌套和未知 marker。该完整性回归必须在任何双写和回填前通过。

### 写入与删除的一致性

所有会改变 canonical payload 的写路径必须在同一 SQLite transaction 中更新 canonical 行及索引行：

1. 先在应用层使用与现有扫描相同的 strict collector 从待写 payload 中提取 descriptor；拒绝畸形、未知版本和非法 locator。
2. 写入或更新 canonical 行。
3. 按 owner 删除旧索引行，并批量插入新 descriptor 行。
4. 事务提交后才允许通知 GC 或开始 retention。

覆盖范围必须包含 History event append/replace、transcript snapshot insert/update、session delete，以及所有迁移或修复代码对这两张 canonical 表的直接写入。只改主 writer 不够；需要通过 `rg` 盘点 SQL 写点并为每个写点建立事务测试。session 删除可使用 owner 级索引清理；spill GC queue 的入队仍与 canonical 删除同事务。

优先在统一 repository/write helper 中维护索引，不依赖 SQLite JSON 扩展触发器解析任意嵌套 payload。若有无法收敛到统一 helper 的写路径，应显式登记并由边界检查脚本阻止新增未覆盖写点。

### 读取与安全门

- 完整回填且验证通过前：索引只做影子查询和差异诊断； retention、GC、孤儿回收继续使用严格 canonical 全量扫描作为 unlink 前置条件。
- 索引双写与回填完成后，首个读切换版本仍以现有严格 canonical 全量扫描作为 source-truth GC 和 spill 孤儿删除的唯一授权依据。索引只可用于候选发现、进度及差异诊断；不得以索引给出的 owner 集合或 locator 定向查询替代全量证明。
- 即使按 locator 定向查询，也无法证明未被索引列出的 owner 不存在共享引用，且无法发现候选之外的坏 JSON/未知 marker。JSON 文本搜索也不能作为完整候选发现协议（合法转义可令原始文本不包含解码后的 locator）。因此，未另行设计并评审独立于索引的全局完整性证明前，所有无法完成严格全量扫描的情况都必须拒绝 unlink。
- 索引读切换只能先用于不授权删除的只读场景，并保留全量扫描对账。未来若要让索引授权 unlink，须另立方案定义全局 canonical 可解析性证明、候选发现完整性、共享 owner 检查，以及证明/复核/unlink 在同一 root fence 与一致性边界内完成；还要覆盖复核期间新增引用。通过独立评审和验证前不得放行该能力。
- 索引查询应返回所有 owner 引用，不能把多个 owner 的共享 locator 压成一条后失去共享检测语义。

首个索引消费者仍可选 `collectSessionStorageProfile`，但实现位置限定在 Electron 数据库/profile 私有实现：在一个显式短只读事务/快照内读取 `status`、协议版本、generation/verified_generation 和全部索引行，任何索引查询失败都回退现有 strict collector 或把引用分类标为未知，绝不把异常变成零。状态检查与索引数据不可跨事务读取。对外 profile 字段与调用接口保持兼容，不暴露索引能力；该 consumer 只产出诊断数据，不授权任何文件删除。spill 目录枚举是独立文件系统观测值，不宣称与 SQLite 状态构成原子快照。验收比较同一数据库上 profile 的 spill locator/类型/字节统计完全一致；2 倍性能门槛仅比较 spill 引用收集阶段，完整 profile 只报告总耗时。

## 4. 旧数据库的可续跑、分批回填

### 元数据与状态机

新增 migration-owned 的 `spill_reference_backfill_state`，按数据集记录：`status` (`pending/running/paused/complete/failed/untrusted`)、`source_table`、稳定回填游标、reconcile generation/cursor、每 activation 已用重启次数、`next_retry_at`、扫描行数、索引行数、错误摘要、开始/更新时间、回填协议版本、canonical 变更代次和最终校验时间。另以 migration-owned 的私有 staging 表暂存分块 owner 结果；索引发布与回填/对账共享持久 maintenance lease，任一时刻只能有一个改变/校验索引的 worker。`untrusted` 是正式状态，表示索引不能用于消费者读取；修复后只能转 `pending` 并重新对账，不能直接改回 `complete`。`paused/generation-churn` 作为暂停原因记录，不是 `complete` 或独立信任状态。游标采用 owner 主键的确定性 keyset 顺序，不使用 `OFFSET`，避免深页扫描和并发变更造成跳行。

状态转移：

```text
pending -> running -> complete
                  -> paused -> running
                  -> failed -> running（修复/重试后）
complete -> untrusted -> pending -> running
```

只有完整扫描、增量双写已开启、且全量差异校验协议通过时才可置为 `complete`。进程崩溃后保留最后一个已提交 batch 的游标；重跑 batch 必须幂等。

### 批次流程

1. 迁移创建索引表与回填状态，标记 `pending`。若 SQLite schema migration 需要锁表，只做建表和状态初始化，不在 schema transaction 内遍历大 JSON。
2. 部署支持双写的应用版本：所有新写入在 canonical transaction 中同步维护索引。回填 worker 仅在双写版本启动后工作。
3. 批次选择必须在 JS 解析前完成 payload 字节数检查：用 SQLite `length(CAST(payload_json AS BLOB))`（或等价 BLOB byte-length）筛选/读取 owner，超过 64 MiB 的行只读其 key 与大小并记录 `failed/owner-payload-over-limit`，不得将 payload 传入 JS、hash/parse/collector，也不得推进游标；消费者继续 strict fallback。最多 200 行或 8 MiB payload（先到者）组成普通批次。单行超过当前剩余预算且不超过 64 MiB 时单独处理，并测量完整批次同步阻塞时间，包含 payload 获取、hash、parse、collector、索引写入和提交。若单 owner 超 100 ms，将解析/hash 移出主线程；descriptor 分块只写入 staging，不得先删或修改已发布索引。每个 staging 清理、chunk 写入和最终发布事务都须校验 canonical owner 仍存在且 revision/hash 与任务一致；revision 改变或 owner 删除时只丢弃该任务 token 的 staging 行，不得触碰 live index。staging 全部完成后，以一个短事务再次校验 revision，原子替换该 owner 的 live index 并推进游标；若 SQLite 写入或任一 chunk 仍无法满足 100 ms，则 owner 标为 `failed/owner-sync-budget-exceeded`、不推进游标，不得以降低批量掩盖；需另行设计异步写入实现后再重试。只有通过超大 owner 场景预算才能完成 I-05。
4. batch/chunk 失败时回滚当前事务并记录错误类型与 owner key，不记录正文内容。大 owner 的分块只会留下不可读 staging；owner 游标不前进。重试按唯一任务 token 清理该任务的 staging，再从同一 canonical revision 幂等重建。不得按 owner 无条件清理 live index。可暂停 worker，修复数据或 parser 后从最后已完成 owner 续跑。
5. History 与 transcript 分别记录游标和进度，避免一类大表阻塞另一类。取消只在安全 batch/chunk 边界生效：当前事务提交或回滚后记录 `paused`，保留最后已完成 owner 游标；未完成 owner 的局部索引行按重试协议清理。每批让出事件循环，首屏关键路径不等待回填。
6. 两表到达末尾后运行一致性校验协议：对每个 owner 用 strict collector 计算期望 descriptor，与索引按 owner/path 双向比对，并核对引用总数、locator 集合、kind 和 descriptor 快照。校验可分批持久化进度，未全部完成前状态不能置 `complete`。
7. 完成状态提交后只允许索引 shadow compare 和不授权删除的读路径。影子差异、schema 版本不匹配或新写路径未双写时，将索引标为不可用并继续全量扫描；source-truth GC 与孤儿删除始终执行严格全量扫描，直到 unlink 授权另经评审。

### 并发写入与快照一致性

SQLite 单写者事务使 canonical 写入和索引发布有明确顺序，但长时间回填不能依赖跨全库长读事务。回填与 generation reconciliation 必须持有同一 SQLite maintenance lease，禁止两者并行；lease 在短事务内获取/续租，带 owner token/expiry，进程崩溃后过期可恢复。canonical 在线 writer 不受该 lease 阻塞，仍在自身事务里双写并增加 generation。

每个 staging 行、stage 清理、chunk 写入、索引发布和游标推进都要在各自事务里检查 canonical owner 当前存在且 revision/hash 等于任务 revision。revision 应由 canonical writer 原子维护（优先使用稳定 revision 列；若无则使用 payload hash 并在事务内比较）。writer 在 chunk 间更新时，下一 chunk 或最终发布发现 revision 不同，只能放弃旧 token 的 staging；若 writer 先提交新 live index，回填不得按 owner 清理 live 行。若回填先发布，后续 writer 会按正常双写替换索引。owner 删除同理：旧任务不得发布，且不得重建删除 owner 的行。重试或崩溃恢复以 staging task token + revision 为范围清理；live index 仅可由满足 revision 条件的 publish 事务替换。

删除竞争也必须确定：如果 owner 在回填页之后被删除，删除事务会清除 live index；如果删除先发生，worker 的条件检查将发现 owner 不存在并放弃 staging。不得在删除 canonical 行后再异步清 live index。

### 对账一致性协议

新增单调递增的 `canonical_change_generation`，每次 canonical owner insert/update/delete 与索引双写在同一 SQLite transaction 中递增。索引回填写入不递增此 generation；回填必须用 owner revision/hash 条件 upsert，不能覆盖更晚的在线双写。

由于回填 staging/publish 会改变索引但不改变 canonical generation，generation 不能用来发现并发回填。maintenance lease 必须覆盖 staging 清理、全部 chunk 与 publish；reconciliation 也持相同 lease，确认无遗留未发布 staging 后才开始。lease fencing token 写入每条 staging 记录，旧/过期 worker 不能续租、发布或推进游标。在线 canonical writer 不拿该 lease，只通过其事务原子维护 live index 与 generation。

对账按以下协议执行，避免跨批次校验期间的并发变更使旧结果失效：

1. 开始完整对账时读取 generation `G`，记录为本次校验代次；按 keyset 分批验证每个 owner，持久化校验游标和 `G`。
2. 对账继承 I-05 的资源契约：每轮最多 200 个 owner 或 8 MiB canonical payload，单 owner 上限 64 MiB，超限先由 SQLite BLOB byte-length 检查并拒绝 payload 读取。owner payload 以不超过 512 KiB 的 SQLite BLOB chunk 读取并让出事件循环；hash、parse、完整 collector traversal 在 worker thread 执行，descriptor 结果按有界消息批次返回。对账两侧都使用 keyset/descriptor_path 有序分页：canonical 期望 descriptor 分批流出，index extra/missing 检查每页不超过 200 行或 8 MiB `descriptor_json`，不得 `.all()` 一次取全 owner 或全索引。每次同步 SQLite chunk 读取/查询/比较提交预算 ≤100 ms；取消仅在读取 chunk 或比较页边界生效，保留 generation 与双向游标并进入非 complete 的 `paused`，续跑前重新核对 lease、generation 和 owner revision。若单次读取/比较仍超 100 ms，该 owner 标记失败、游标不前进，不能用异步 parse 掩盖超预算 SQLite 工作。
3. 任一 canonical owner 在校验期间新增、更新或删除都会在同一事务增加 generation。worker 每批前后发现 generation 不等于 `G` 时，废弃本轮校验游标，从头以新 generation 重验；已验证 owner 后续变化不能留在成功结果里。
4. 最后一批校验后，在一个短 SQLite transaction 内再次比较当前 generation 与 `G`，并核对两张 canonical 表均到末尾、双向游标均到末尾、无失败 owner、无遗留 staging、回填游标已完成、索引协议/schema 版本匹配及当前 lease fencing token 仍有效。SQLite 单写者事务串行化 canonical writer；generation 在提交事务内仍等于 `G`，就是该提交点没有遗漏并发 owner 变更的可查询判据，不额外依赖未定义的“无待处理 writer”状态。只有全部成立才原子设置 `status='complete'` 和 `verified_generation=G`；若 generation 已变化或 lease 已过期，保持非 complete 并重启校验。
5. 已处于 complete 时，受支持的 canonical 双写事务同步更新 `verified_generation` 为递增后的 generation，因为该事务原子维护 canonical 和索引。未覆盖的写入/恢复入口必须先把状态改为 `untrusted`，再改 canonical 数据。

因此 `complete` 不是靠游标到尾或时间戳推断；它由稳定 generation 的全量双向对账和最后事务提交共同证明。测试必须覆盖已校验 owner 随后变化、暂停期间变化，以及最后一批校验与 complete 提交之间变化。

持续写入时的收敛策略：每次 host maintenance activation 最多启动 3 轮完整 generation 校验；一次 activation 内每次 generation churn 都使当前轮作废并从头开始，但达到上限后立即停止，不在主线程或事件循环中忙循环。跨 activation 按 1、2、4 分钟指数退避，单次延迟上限 15 分钟；每次重试只运行一轮。进入对账前须观察到 generation 连续 30 秒不变，未满足时记为 `paused/generation-churn` 并延后，不推进校验游标。活跃写入始终由 canonical/index 原子双写维持索引行一致，但在没有通过完整对账前状态保持非 `complete`，profile 使用 strict fallback；不承诺持续写入期间完成切换。写入停止并出现稳定窗口后，对账应从头有限次完成。重启/新启动可按已持久化退避状态续约，不得重置为立即无限重试。

lease fencing 的过期测试属于 I-05/I-06 必测项：暂停旧 worker 后让 lease 过期，再由新 token 接管；旧 worker 继续尝试 staging 写、live publish、游标推进或置 `complete` 时，每个事务都必须因 token 不匹配/过期而失败，且不得覆盖新 worker 的 staging、索引或状态。

### 故障、损坏与回滚

- JSON 或 descriptor 不合法：标记 `failed` 并记录 owner/table/error code；继续使用严格全量扫描语义，涉及完整引用集的删除清理暂停或返回失败。不能把坏行当成无引用。
- 磁盘空间不足、进程退出或锁竞争：保留已提交 batch，标记 `paused` 或由下一次启动根据租约恢复；不回滚已完成批次。
- 索引损坏或校验差异：关闭索引读路径，恢复全量扫描；保留索引用于诊断，可删除后重建，但不能清空游标后误报 complete。
- **不支持旧版本打开新 schema**：索引表通过递增 `DB_SCHEMA_VERSION` 引入，沿用 `electron/database/migrations.ts` 的 schema floor；旧二进制遇到更高 schema 必须拒绝打开。回滚只能恢复该旧版本可读且 canonical/index 状态匹配的整库备份，不做 schema 降级，也不承诺旧版本可继续写新 schema。
- canonical-only 恢复/导入工具若受支持，必须在同一事务内先将索引置为 `pending/untrusted`，再替换 canonical 数据；事务提交前不能让应用读切换。若工具无法原子失效索引，则不得用于启用索引读路径的数据集。完整数据库备份/恢复应同时包含 canonical、索引和状态；恢复后仍核对 schema 与索引协议版本。
- 状态机只使用 `untrusted` 作为失效状态；恢复事务先写 `untrusted`，完成数据替换后置 `pending`。回填/对账从头开始，禁止跳过对账直接置 `complete`。
- `complete` 字段本身不能发现索引外的旧 writer 或 canonical-only 恢复。安全依赖是 schema floor 拒绝旧 writer，加上受支持的恢复入口必须失效索引；版本匹配不被描述为独立完整性证明。重启时若状态不是 `complete` 或恢复协议无法确认，必须保持全量扫描。

## 启动期与周期清理的执行策略

这五类清理都是保留策略或容量策略，不需要阻塞每次启动。建议统一改为“窗口可用后低优先级执行 + 持久化成功水位 + 条件触发补跑”。清理失败时不推进水位；文件/行级删除保持幂等，下次继续即可。配置策略改变时重新计算策略指纹并立即安排一次维护。维护任务必须有单实例运行保护、可取消/可让出事件循环，并记录 `skipped / completed / failed`、扫描量、删除量和耗时。

启动只负责检查是否有过期水位或待处理标记，并安排任务；不在首屏路径同步遍历大目录或 canonical 大表。各清理的“一天一次”是初始节流建议，不改变保留期、删除对象或授权语义；之后根据耗时和清理及时性指标调整。

| 清理项 | 当前启动行为 | 建议执行策略 | 每次启动仍需做的事 |
| --- | --- | --- | --- |
| Spill degradable retention | 每次启动扫描并解析所有 History / transcript payload，再筛选过期 degradable descriptor；扫描在 spill root fence 内执行 | 窗口显示后按本地自然日运行；若 retention 配置变化则立即重跑。索引未获删除授权前，只做 shadow compare；严格全量扫描仍决定可删除的 locator、kind 和过期时间。若全量扫描持锁时间明显影响活跃 spill 写入，需先实现有一致性保证的短锁/分段协议，不可直接把扫描移出 fence | 仅检查 last-success 水位、策略指纹和任务是否正在运行；source-truth GC 仍独立处理 pending queue |
| MCP artifact 清理 | 启动时做 TTL 和目录配额清理；当前调用链对 TTL 文件列表重复扫描 | 合并为单一清理遍历：同次枚举收集文件信息，同时决定 TTL 删除和配额淘汰；TTL 使用每日日期水位，quota 使用容量 dirty/变更代次独立触发。artifact 写入路径不枚举目录：从持久化容量估算器读取累计 bytes；状态缺失/损坏时保守标记 rebuild-required，由一次目录扫描重建。userData 下的原子小状态文件维护 `capacity_generation`、estimated bytes、pending write intents、quota dirty 和 rebuild-required。写文件前持久化 intent/generation，文件原子发布后以实际字节数结算并再次增加 generation；崩溃遗留 intent 时下次 rebuild 对账目录。成功 unlink 后扣减估值；unlink 失败不扣减并保留 dirty。quota sweep 捕获起始 generation，仅在扫描成功、无 pending intent 且当前 generation 仍相同时清理对应 dirty；扫描期间新写入会递增 generation 并保留后续 sweep 请求。清理放到窗口可用后 | 按 local day 判断 TTL；quota 无日期跳过规则，dirty 或 rebuild-required 始终安排扫描；损坏状态触发 rebuild，不可因此跳过清理 |
| SessionEvent 保留清理 | 每次启动扫描所有配置 workDir 下的 session 目录，按 `lastAt` 清理超出 maxSessions 的台账，并保护 canonical/compaction 依赖 | 窗口可用后每日执行；maxSessions 策略变化时重跑。session 创建/关闭后可安排合并的低优先级 sweep。保留前的 `shouldRetainSessionDir` 和 `prepareProjectionForRetention` 继续逐候选执行，不缓存授权/依赖结论 | 检查 workDir 集合、策略指纹和 last-success 水位；路径/profile 集合变化时使相关 root 水位失效 |
| Agent 日志保留清理 | 每次启动枚举 Agent 日志目录，按日期删除超期文件 | 窗口可用后每日执行；保留天数或日志目录变化时重跑。删除按文件幂等，只有完整枚举成功后才推进水位 | 检查目录、策略指纹和日期水位；日志目录缺失按空目录处理 |
| 用量事实保留清理 | 每次启动按本地自然日 cutoff 删除超期 usage facts | 窗口可用后每日执行；保留天数改变时立即重跑。保留策略设为 `forever` 时跳过并记录该策略指纹 | 检查 retention 值、local day 和 last-success；cutoff 未前进且策略未变时不重复 DELETE |

MCP 容量状态更新必须由一个 owner 内串行化，使用原子临时文件替换避免并发 artifact writer 丢失 generation/估值。若 intent 持久化失败，artifact 不得发布；intent 在发布前/后崩溃均保留 rebuild-required 证据，下次枚举目录与所有未完成 intent 对账后才能清 dirty。容量估值可保守偏大并触发额外 quota sweep，不可偏小到跳过已超额清理。

### 调度水位与时区规则

- 每项策略型维护使用独立的 `last_success_day`、`policy_fingerprint`、`root_fingerprint`（适用时）和 `last_error`。MCP TTL 日期水位与容量 quota 状态独立；quota 以容量代次/dirty 触发而不受当天 TTL 成功水位抑制。由于 MCP 在 DB 打开前运行，状态放在专属 userData 原子文件，不能依赖稍后打开的 SQLite。
- 日周期按既有业务口径计算：usage facts 使用其 `localDayString` 对应的本地自然日；Agent 日志按文件名日期；其他维护用统一本地自然日。跨日启动触发 sweep，避免用 UTC 日界改变保留结果。
- 只有整轮扫描和必要删除都成功后才写 success 水位。部分文件删除成功但之后失败时，重跑应安全地略过已不存在文件并继续；不得提前写水位导致漏删。
- 数据库清理的策略指纹至少包含生效保留值和算法版本；文件清理的 root fingerprint 包含规范化路径。策略/算法升级可显式递增版本，使旧水位失效。
- 新维护任务/水位首次接入时水位为空，首次策略型 sweep 在窗口可用后执行。维护失败不阻塞应用；失败状态下后续启动或后台退避重试。任务互斥按维护类型和 root 限定，避免同一目录并发删除。

### 与恢复工作的边界

此处只调整策略型 retention，不延迟有明确崩溃恢复语义的工作。特别是 spill source-truth GC：session 删除事务已经写入 durable queue，启动仍需尽早检查并恢复 pending 项；周期 full-directory 分类也继续按现有持久 cursor 与周期运行。usage 的 `reconcileUsageTurnFacts` 是崩溃事实补齐，不属于保留清理，应与每日 retention 分开。SessionEvent 的完整 ledger reconcile 也不在本节直接改成每日；需要先证明有持久 dirty/pending 标记能覆盖所有 append、index stale、崩溃尾行和 profile 切换，否则只能优化候选发现，不能降低恢复覆盖面。

### 按项落地顺序

本节与文末任务编号保持一致，拆成两个互不阻塞的本机工作流。会话存储索引与回填是 SQLite adapter 内部工作；调度沿用 `createSqliteSessionStorageHost` 的 host lifecycle，公共会话端口不承载这些能力：

- **清理调度线 S**：S-00 MCP 单遍历与失败结果契约 → S-01 host 私有水位契约 → S-02 复用现有 host lifecycle 做 post-window 接入 → S-03 Agent/MCP/SessionEvent、S-04 usage facts retention、S-05 spill retention 可并行开发 → S-06/S-07 总体验收与性能报告。spill 建议最后接入以观测 root fence 对写入的影响；该工作流不依赖索引完成。
- **索引线 I**：I-00 canonical 写点/恢复入口盘点 → I-01 完整 collector 与前置拒删回归 → I-02 schema/staging/lease 与 schema floor → I-03 恢复失效边界 → I-04 全量双写 → I-05 staged 回填 → I-06 generation 对账 → I-07 同快照 profile 只读接入 → I-08 安全拒删矩阵 → I-09 本机收益基准 → I-10 索引线独立回归门。

清理线和索引线可分别交付；F 删除授权独立评审、其他平台试运行及正式数据副本上的实际性能结论都不阻断本机工作流完成。

### 验收指标

- 冷启动首屏时间不再包含上述周期 sweep；每项启动只进行常数级水位判断，spill 除外的水位不可导致大目录枚举。
- 无新增容量触发且日期/策略指纹未变化时，第二次策略型触发结果为 skipped、扫描量为零；策略变化、跨本地日、root/profile 集合变化能触发维护。MCP quota 属容量触发任务，不受 TTL 日期水位跳过。
- 在清理中途注入失败并重启，水位不前进且重跑可完成；同一 root 不并发运行；其他维护项仍可运行。
- 对比迁移前后的删除集合完全一致：spill 仅删过期 degradable；SessionEvent 保留 canonical 投影和 compaction 依赖保护；Agent/MCP 保留原阈值/配额；usage 按相同 local-day cutoff 删除。
- 记录各 sweep 的启动前等待时间、窗口 ready 时间、运行耗时、扫描量、删除量、锁等待和失败重试。spill 还需记录 root fence 占用时长；周期化不能以未测量的活跃写入阻塞换取首屏指标改善。

## 分阶段实施与放行条件

| 阶段 | 变更 | 放行条件 |
| --- | --- | --- |
| A. 契约收敛 | 盘点 canonical 所有写点；统一 strict descriptor 提取和 owner key；补事务测试 | 每个 canonical insert/update/delete 写点都有索引维护设计，source-truth/degradable 语义不变 |
| B. 建表双写 | SQLite 私有 migration 与索引 repository；canonical owner 的 SQLite 持久化实现内部同事务双写，读端仍全量扫描 | 新旧扫描结果一致；事务失败不出现半写；session delete/共享 locator 行为不变；SDK/业务端口签名与 DTO 不增加索引概念 |
| C. 分批回填 | host lifecycle 管理的后台 keyset worker、暂停/恢复、字节预算、错误状态 | kill/reopen/重复 batch/并发更新删除测试均通过；启动关键路径不等待全表；任务不要求 SDK/业务模块提供数据库访问 |
| D. 全量对账 | 以稳定 canonical change generation 完成 owner/path 双向校验；索引只做 shadow compare | 本机确定性 fixture 与故障注入零差异；generation 变化不能产生 `complete` |
| E. 首个只读消费者 | Electron profile 私有实现可在 complete/generation 有效时使用索引，否则回退全量扫描；不授权 unlink | 对外 profile 形状不变、spill 统计逐字段一致；失效状态自动回退；无索引字段/查询 API 泄漏到 SDK 或业务端口；本机性能基准达到下方量化门槛 |
| F. 删除授权另行评审 | 如需让索引替代全量扫描授权 unlink，另立完整性证明协议及评审，不属于本方案默认放行 | 覆盖漏记共享 owner、JSON 转义、嵌套 marker、候选外坏行/未知 schema、表缺失、并发新增引用；任何证明失败都拒绝删除 |
| G. 性能报告（非实现阻断） | 本机合成基准量化 consumer 收益；取得正式数据库隔离副本后可补充实际规模报告 | 本机结果按固定规模/重复次数输出 JSON；正式副本是否可用不阻断本机实现完成，也不自动放宽 GC 安全门 |

## 必须覆盖的验证矩阵

- History 与 transcript 各自 0/1/多 descriptor；同 locator 多 owner 共享；source-truth/degradable 混合。collector 完整性测试使用人工定义的精确 JSON Pointer 路径和 locator 集合，覆盖同一对象双已知 marker、已知 marker 的兄弟字段中嵌套已知/未知 marker、数组和多层嵌套；未知结构要求整行拒绝，不能以 strict collector 自身作为期望值。
- append、owner 更新、session delete、事务提交失败、descriptor 校验失败后索引与 canonical 原子一致。
- 回填时并发 insert/update/delete；重复 batch；游标边界；同一 locator 被不同 owner 引用。
- 大 owner staging 在 chunk 间遭在线 update/delete；writer 在回填进程崩溃后、续跑前更新 owner；旧 revision 清理不得触碰新 live index；backfill 与 reconciliation 同时申请 lease 时只允许一方进入。
- 每个 batch 后杀进程并重开；暂停与续跑；错误修复后重试；磁盘/锁失败；较大 payload 触发 byte budget。
- 坏 JSON、未知 spill marker/schema、缺少任一 canonical 表、索引缺行/多行/旧版本时都不允许 GC unlink；漏记共享 owner、JSON Unicode 转义 locator、任意嵌套引用及候选外坏行不能被索引定向复核漏过。
- schema floor 拒绝不支持的旧版本；完整备份恢复；canonical-only 恢复事务先失效 `complete` 后替换数据；恢复协议不确定时持续使用全量扫描。
- 全量扫描与索引逐 owner 对账；索引关闭时原有 spill retention、source-truth GC、孤儿清理、profile 和清理估算功能结果不变。
- profile 使用同一 SQLite 读快照读取 trusted state 与索引；通过第二连接在这两类读取之间执行 canonical-only restore/失效的并发测试。spill 文件目录枚举单独报告为观测值，不要求与数据库读快照原子一致。
- 本机常规基准使用固定 seed 的合成数据库：20,000 条 History + 2,000 条 transcript、约 4 KiB/owner、固定 descriptor 密度、kind 分布和共享 locator 比例，生成与 descriptor 一致的非空 spill 文件；5 次计时（另加 1 次预热），输出 JSON。2 倍门槛仅比较相同 canonical 数据上的 spill 引用收集阶段（strict collector 与索引 collector），并要求 locator/kind/bytes 等非零统计逐字段一致。完整 profile 耗时单独报告，不设 2 倍门槛。
- 大 owner 压力基准独立覆盖接近 8 MiB、接近 64 MiB、超过 64 MiB 和 descriptor 密集场景，记录 payload 读取、hash、parse、collect、SQLite 写入/提交和完整主线程批次阻塞时间及 RSS。超过 64 MiB 用例须证明不将 payload 送入 JS；可处理 owner 与每个写入 chunk 的同步阻塞均不超过 100 ms，无法满足时按 I-05 失败策略暂停该 owner，不允许通过常规小 owner 基准代替。
- 正式数据库隔离副本的耗时、CPU/RSS、锁占用、真实启动提速属于实际性能结论的补充材料，不是本机实现完成或合并的阻断项；真实数据库不作为试验写入目标。

## 当前可先做的安全优化

当前工作区 `readCanonicalSpillReferences` 已逐行迭代 History 与 transcript 表，不再使用 `.all()` 同时保留整表 JSON 字符串；严格解析仍需遍历所有 canonical 行，descriptor 结果集仍占内存。基准需同时测耗时和 RSS，不能仅凭代码形态断言启动有明显提速。扫描计数、字节数和分表耗时用于判断索引收益是否值得写放大与迁移复杂度。

## 评审修订记录（2026-10-07）

- **P1：定向 canonical 复核不能证明全局零引用。** 阶段 E 改为索引只读/影子使用；source-truth GC 与孤儿 unlink 继续以严格全量 canonical 扫描作为唯一授权依据。任何未完成全量扫描的情况 fail closed。
- **P1：`complete` 状态的回滚/恢复失效机制不充分。** 明确通过提升 `DB_SCHEMA_VERSION` 使用现有 schema floor 拒绝不支持旧版本；canonical-only 恢复入口必须事务性失效索引，无法做到则不得支持索引读切换。完整性不依赖状态字段版本匹配本身。
- **P2：MCP 清理不能安全推进成功水位。** 迁移调度前，清理 API 必须返回结构化成功结果或抛错：仅 ENOENT 可按空目录/已删除处理；readdir/stat/unlink 的其他错误使整轮失败且水位不前进；配额总量只在 unlink 成功或确认文件已不存在后扣减。重试应重新枚举并完成未成功项目。
- MCP 对应测试需覆盖目录枚举失败、单文件 stat 失败、TTL/quota unlink 失败、quota 不因失败删除而误降，以及修复错误后重跑成功。TTL helper 不得把非 ENOENT 的 readdir 失败吞成空目录。

## main 接口边界复核（2026-10-08）

- 对照 `electron/sessionStorage/contracts.ts`、`electron/sessionStorage/sqliteSessionStorage.ts`、`electron/sessionStorage/lifecycle.ts` 和公共接口设计，明确索引/schema/generation 属于 SQLite 持久化实现内部；SDK、renderer、IPC/business DTO 与 `SessionQueries`/`SessionCommands` 不增加 Spill 细节。
- 将回填/对账接入方式限定为现有 host-only `StorageLifecycleControl`/`createSqliteSessionStorageHost`，不另建并行 scheduler；维护水位是 host/owner 私有状态，不加入业务存储接口。
- `collectSessionStorageProfile` 保留为可选首个只读 consumer，但索引读取仅可放在 Electron profile 私有实现，保持现有 profile 输出形状和 strict-scan 回退；删除授权仍完全依赖 strict 全量扫描。
- 任务 I-00、I-04、I-05、I-07 和 S-01、S-02 已加入接口边界完成判据。此项为设计核对与文档更新，未修改实现代码，未运行测试。
- 依据后续复核补充 MCP quota 容量 dirty 触发、generation churn 的有界重试/稳定窗口、大 owner 超限预检与批次预算、spill-only 2x 基准口径，以及两条工作流汇合后的全量本机质量门。
- 新一轮完整性/并发复核要求：I-01 前置修复完整 traversal 并以人工期望集合验收；I-05 改 staging + revision 条件发布并与对账 lease 互斥；I-07 同一只读快照读信任状态和索引；S-03 使用持久容量代次/intent；S-02 明确长期调度器唤醒、跨日、pause/resume 与 start 异常隔离；新增 I-10/S-08 独立完成门，Q-00 只做联合交付检查。这些要求已在下方任务表实现并通过各自完成门。
- 最新评审补充 I-06 继承大 owner 的 200 行/8 MiB/64 MiB、512 KiB SQLite 读块、worker-thread collector、有界双向索引分页、100 ms SQLite chunk 与取消续跑验收；增加 lease 过期旧 token 的 staging/publish/cursor/complete fencing 测试。将 MCP 容量说明移至策略表之后，修复 Markdown 表格结构。

## 任务明细（本机可自动执行）

状态定义：`[x]` 已在本机实现并验证；`[～]` 实现决策、交付物和验收条件已闭合，代码待做；`[ ]` 尚有实现决策或仓库入口盘点未闭合。每项列出前置任务、交付物、命令和通过条件。仅列可在本机代码、测试、脚本或合成数据库上自动执行的任务；其他平台试运行、正式数据副本可用性、发布及人工审批不作为阻断项。当前任务表中的所有自动执行项均已完成。

实现决策：回填按最多 200 行或 8 MiB payload 组批，超出当前剩余预算但不超过 64 MiB 的单行单独成批；超过 64 MiB 时在 JS parse/hash 前记录失败并停止该 owner，不推进游标、不切换索引读。每个 owner/chunk 的同步主线程预算为 100 ms；超预算后解析/hash 移出主线程，索引写入分有界事务；若 SQLite 写入本身仍超预算，则 owner 保持失败且不推进游标，须另行实现可满足预算的写入策略，不能靠降低其他批次预算放行。取消只在安全 batch/chunk 边界生效，当前事务提交或回滚后记录 `paused`。启动优化以 Electron `ready-to-show` 为边界；任何策略 sweep 不得在该事件之前开始。测量 `ready-to-show` 而非操作系统首次绘制。

### 已完成的本机基线

| ID / 状态 | 交付物 | 本机验证命令 | 完成判据 |
| --- | --- | --- | --- |
| B-01 `[x]` | `readCanonicalSpillReferences` 逐行迭代 History/transcript；引用统计含行数、字节数、descriptor/locator 数和耗时 | `npx vitest run --project electron electron/storage/spillStore.test.ts` | spillStore 37 项通过，引用集合和既有 fail-closed 行为不变 |
| B-02 `[x]` | spill retention 启动日志打印 reference scan 统计；调用 API 保持默认兼容 | `npx tsc -p tsconfig.electron.json --noEmit` | Electron TypeScript 检查通过；启动日志包含扫描统计字段 |
| B-03 `[x]` | 本方案已记录索引安全门、清理策略、评审阻断和本机自动任务清单 | `git diff --check -- docs/develop/spill-reference-index-and-backfill-plan.md` | 文档差异无空白错误；安全结论明确禁止索引授权 unlink |

### 工作流 I：Spill 引用索引（SQLite 实现内部）

| ID / 状态 | 前置 | 交付物 | 本机验证命令 | 完成判据 |
| --- | --- | --- | --- | --- |
| I-00 `[x]` 写点、恢复入口与接口边界盘点 | — | canonical 两表所有 insert/update/delete、session delete、迁移/修复/导入恢复入口清单；登记 SQLite 私有实现归属；自动边界检查 | `npm run check:spill-reference-boundary` | History append：`electron/database/agentHistoryStorage.ts`；transcript insert：`electron/database/sessionTranscript.ts` 两处；session delete：`electron/database/operations.ts` 两表各一处；v32 History update 仅回填排序元数据、不改 payload。未发现 canonical-only restore/import 入口。检查对已登记 SQL 写签名计数并阻止 SDK/renderer/contracts 泄漏，通过 |
| I-01 `[x]` 完整 Descriptor/owner collector 与前置拒删回归 | I-00 | 全结构 traversal、稳定 JSON Pointer、未知 marker fail closed；人工声明精确 path/locator/kind 的回归 | `npx vitest run --project electron electron/storage/spillProtocol.test.ts electron/storage/spillStore.test.ts` | 双已知 marker、兄弟字段嵌套引用、数组、JSON Pointer 转义、inline 歧义和未知 marker 有人工期望测试；visitor 惰性输出，单次消费不保留额外无界结果数组 |
| I-02 `[x]` Schema、staging、lease 与回滚 floor | I-00、I-01 | schema v54 migration 新增 live/staging/state/lease/generation；`DB_SCHEMA_VERSION` floor 提升 | `npx vitest run --project electron electron/database/migrations.spillReferenceIndex.test.ts electron/database/migrations.v11.test.ts electron/database/migrations.sourceTruthSpillGc.test.ts` | migration 幂等；旧 schema 可升级；未来 schema 由 `DatabaseUpgradeRequiredError` 拒绝；Electron 类型检查通过；私有表未进入业务合同 |
| I-03 `[x]` 恢复失效边界 | I-00、I-02 | canonical-only restore/import 入口盘点；本仓库无受支持入口；完整数据库 SQLite 备份自然包含同库索引/state | `npm run check:spill-reference-boundary` | I-00 盘点无 canonical-only restore/import 写入口，因此无需增补恢复代码；SQLite 同库备份包含 canonical/index/state；无索引读取切换可由恢复行为授权 |
| I-04 `[x]` Canonical SQLite 双写 | I-02、I-03 | History append、transcript commit/reconcile、session delete 在 SQLite adapter 同事务维护索引；SQLite trigger 原子递增 generation | `npx vitest run --project electron electron/database/agentHistoryStorage.spillReferenceIndex.test.ts electron/storage/spillReferenceIndex.test.ts electron/runtime/sqliteAgentHistory.test.ts electron/database/sessionTranscript.test.ts electron/database/operations.test.ts` | I-00 所有 SQL 写点已登记；rollback、双写、共享 locator、多路径、session delete 测试通过；端口调用方无需感知索引；boundary 与 Electron 类型检查通过 |
| I-05 `[x]` Host-owned staged backfill worker | I-04 | 两表独立 keyset 游标、200 行/8 MiB 组批、64 MiB 单 owner 上限、revision 条件 staging/publish、持久 lease；注册为 `derived-index` task | `npx vitest run --project electron electron/storage/spillReferenceBackfill.test.ts electron/sessionStorage/lifecycle.test.ts`；`npm run bench:spill-reference-index -- --scenario owner-size-boundaries` | >64 MiB 在 JS parse/hash 前拒绝；8/64 MiB 附近、descriptor 密集样本各 chunk ≤100 ms；chunk 间在线 update/delete 不会被旧任务覆盖或清除；崩溃后 writer 更新再续跑保留新 live index；revision 不符时只删本 token staging；失败和取消保持游标不前进且能幂等续跑；子进程终止可恢复；lease 过期后旧 token 写 staging/publish/推进游标均失败；lease 禁止 backfill 与 reconcile 并行 |
| I-06 `[x]` 对账 generation 协议 | I-04、I-05 | 继承 I-05 资源预算的独占 lease、分批双向只读对账 worker；固定 G 校验、有界重启/退避/稳定窗口、末尾事务比较并原子置 complete | `npx vitest run --project electron electron/storage/spillReferenceReconciliation.test.ts`；`npm run bench:spill-reference-index -- --scenario reconciliation-owner-size-boundaries` | 200 owner/8 MiB 行批、64 MiB owner 上限、512 KiB BLOB 读块、worker-thread hash/parse/collector、有界 descriptor visitor、两侧 ≤200 行/8 MiB keyset 页、每个 SQLite chunk >100 ms 即 fail；覆盖大 owner、descriptor 密集 extra/missing path、canonical 删除后残留的 orphan index owner；owner revision 变化期间对账会保留 G/cursor 并有界退避重启；取消保留 generation/cursor；>64 MiB parse 前拒绝；backfill/reconcile 互斥且遗留 staging 不参与 complete；fencing token 过期后失效；两侧 keyset 审计完成且 generation 末尾事务稳定后才 complete |
| I-07 `[x]` Profile 同快照只读接入与索引失效回退 | I-03、I-06 | 一个短只读事务读取状态、协议、generation 与全部索引行；索引读取仅在 Electron profile/SQLite 私有实现；索引不得授权 unlink | `npx vitest run --project electron electron/database/sessionStorageProfile.spillReferenceIndex.test.ts electron/storage/spillStore.test.ts` | 另一连接在状态检查后、索引读取前执行 restore 时，本次 profile 仍从同一 SQLite 快照读到一致旧态，或整组回退/标未知；查询错误不得变零；文件目录统计标记为独立观测；原 profile 形状不变，unlink 仍只由 strict 全扫描授权 |
| I-08 `[x]` 安全拒删矩阵 | I-07 | canonical 全量扫描 fail-closed 回归测试 | `npx vitest run --project electron electron/storage/spillStore.test.ts electron/storage/spillReferenceIndexSafety.test.ts` | 漏记共享 owner、Unicode 转义 locator、嵌套引用、候选外坏 JSON/未知 marker、缺任一表、迭代中断、fence 内并发新增引用都不能导致错误 unlink |
| I-09 `[x]` 首个只读收益与基准 | I-07 | 本机合成数据库 benchmark 脚本，固定 seed、descriptor/kind/shared-locator 分布及非空匹配 spill 文件；常规样本 20,000 History + 2,000 transcript、约 4 KiB/owner、1 次预热 + 5 次计时；另有回填和对账大 owner 场景；输出 JSON | `npm run bench:spill-reference-index -- --rows 20000 --payload-bytes 4096 --warmup 1 --runs 5`；`npm run bench:spill-reference-index -- --scenario owner-size-boundaries`；`npm run bench:spill-reference-index -- --scenario reconciliation-owner-size-boundaries` | 2026-10-08 本机结果：strict median 159.51ms / p95 164.12ms，索引 median 23.88ms / p95 24.96ms，6.68x；22,000 引用、1,100 locator、70,400 bytes 逐字段一致。8/64 MiB + 500 descriptor 回填 2.36s、RSS 623MB，>64 MiB parse 前拒绝；对账 4.67s、RSS 479MB，G=3 稳定 complete。chunk 运行时强制 100ms 上限；完整 profile 耗时只报告 |

索引线顺序为 **I-00 → I-01 → I-02 → I-03 → I-04 → I-05 → I-06 → I-07 → I-08 → I-09 → I-10**。其中完整 collector 的人工期望集合拒删回归（I-01）先于 schema 双写和回填；I-07 只接入 profile 等只读 consumer，不开启索引 unlink 授权。删除授权的独立证明方案不在本工作流中，也不阻断以上任务。

### 工作流 S：五类清理调度

该工作流与索引线独立，可单独开发、测试和交付；五类清理全部完成不作为索引回填或只读 consumer 的前置条件。数据库维护任务的注册/暂停/退出复用 host-only `StorageLifecycleControl`；它不注入 `SessionStorage` 业务端口或 SDK。非数据库任务仍由原有模块 owner 实现清理语义，main/bootstrap 负责生命周期组合。

周期任务明确采用**长期存活的 owner scheduler**：`allowBackgroundWork` 后 `start()` 启动轻量调度器并保留 handle；调度器在本地日期边界、下次 retry 时间、capacity dirty、policy/scope 变化时唤醒并启动各自 owner 的一次 sweep。它按 local day 重新计算下一次 deadline，处理时区/DST 和系统时钟变化；不假设固定 24 小时定时器能代表跨日。扩展 host-only task handle 的通知能力，使 `requestMaintenance(reason, category)` 对已有 handle 发送/合并唤醒请求；不能只因 handle 存在返回 coalesced 而丢掉 quota/config 事件。`pause` 停止调度器并等待当前安全边界 quiesce；`resume` 重启后从持久水位、dirty 和 retry state 恢复。单个 `task.start()` 同步抛错需捕获并只将该 task 标记 failed/安排退避重试，不能中断同批其它任务启动。owner scheduler 内单项 sweep 失败也不能终止 scheduler。

| ID / 状态 | 前置 | 交付物 | 本机验证命令 | 完成判据 |
| --- | --- | --- | --- | --- |
| S-00 `[x]` MCP 清理结果契约 | — | 合并 TTL + quota 为一个目录遍历；每文件最多 stat 一次；返回结构化整轮成功/失败；仅 ENOENT 当空/已删 | `npx vitest run --project electron electron/mcp/mcpArtifactCleanup.test.ts electron/shell/outputArtifactCleanup.test.ts` | readdir/stat/unlink 非 ENOENT 令结果失败；unlink 失败不减少 quota 统计；TTL 7 天与 256 MiB 行为不变；错误修复后重跑成功 |
| S-01 `[x]` Host 私有水位与结果契约 | S-00 | 内部 job result、local day、policy/root fingerprint、algorithm version、success/error watermarks；持久化位置按 DB-open 前后由任务 owner 决定 | `npx vitest run --project electron electron/storage/maintenanceWatermark.test.ts` | 只有整轮成功推进水位；策略、日期或 root 变化会重跑；损坏状态 fail safe 重扫；失败后第二次触发不会被标成 skipped；类型/状态不加入 SDK 或业务 SessionStorage contracts |
| S-02 `[x]` 复用 Host lifecycle 的长期调度器 | S-01 | 在现有 `StorageLifecycleControl`/bootstrap task registration 上接入 ready-to-show 后长期 owner schedulers；host-only handle 可接收/合并唤醒通知；同步 start 错误隔离 | `npx vitest run --project electron electron/sessionStorage/lifecycle.test.ts electron/storage/maintenanceScheduler.test.ts`；`npm run bench:startup-maintenance -- --seed 20261008 --runs 5` | 应用不重启跨日能执行下一日任务；已启动 scheduler 收到 policy/quota 请求会唤醒 sweep；pause/resume 恢复 timer 与水位；一个 start 同步抛错不阻止其它 task 启动并可退避重试；ready-to-show 前不运行策略 sweep |
| S-03 `[x]` MCP、Agent、SessionEvent 接入 | S-02 | MCP TTL 使用本地日期水位；artifact 写入入口在容量阈值/配额超限时先持久化写入 intent/capacity generation，再发布文件并结算估值、通知 quota scheduler；Agent logs、SessionEvent retention 使用各自每日水位，workDir/root 分开记账 | `npx vitest run --project electron electron/mcp/mcpArtifactCapacity.test.ts electron/mcp/mcpArtifactCleanup.test.ts electron/shell/outputArtifactCleanup.test.ts electron/storage/agentLogRetention.test.ts electron/storage/sessionEventRetention.test.ts` | 无新增容量触发时，同日已完成 TTL 扫描量为零；当天 TTL 完成后新写入导致超额仍触发 quota sweep；测试 sweep 期间新写入导致 generation 变化、dirty 不丢且再次 sweep；在 intent 前/后与 publish 前/后崩溃均可通过 rebuild 收敛；只有确认 unlink 才扣减估值；失败/损坏状态可重试；SessionEvent 原删除集合与保护不变 |
| S-04 `[x]` Usage retention 接入 | S-02 | usage facts retention 按 local day 和 policy fingerprint 调度；与 crash recovery 分开 | `npx vitest run --project electron electron/usageStats/usageStatsMaintenance.test.ts`；Electron main 将 crash reconcile 保留为启动工作、usage retention 注册独立 daily task | retention 删除集合与当前 cutoff 一致；forever 稳定 skipped；reconcileUsageTurnFacts 每次正常启动仍执行，不受 retention 水位影响 |
| S-05 `[x]` Spill retention 接入 | S-00、S-01、S-02；与 I-07 无依赖 | spill degradable retention 按日/策略触发；root fence 期间计时；source-truth GC 启动恢复保持独立 | `npx vitest run --project electron electron/storage/spillStore.test.ts electron/storage/maintenanceScheduler.test.ts` | 同水位不再全表解析；策略变化/跨日重跑；任何 sweep 删除仍以 strict 全量 scan 的 descriptor/kind/createdAt 为准；source-truth GC queue 行为不变 |
| S-06 `[x]` 调度总体验收 | S-03、S-04、S-05 | 本机确定性 fixture、错误注入和启动顺序测试 | `npx vitest run --project electron electron/sessionStorage/lifecycle.test.ts electron/storage/maintenanceScheduler.test.ts electron/storage/maintenanceWatermark.test.ts electron/mcp/mcpArtifactCapacity.test.ts electron/mcp/mcpArtifactCleanup.test.ts electron/storage/sessionEventRetention.test.ts`；`npm run bench:startup-maintenance -- --seed 20261008 --runs 5` | fake clock 覆盖应用运行跨本地午夜/DST、同日水位、容量代次变化、配置变化和退避；运行任务收到 wake 后触发新 sweep；pause/resume 不丢事件；同步 start 抛错隔离；跨目录/root 失败互不阻塞；ready-to-show 前不执行策略 sweep。DST 子进程验证 23/25 小时本地日；午夜及策略变更后重跑、暂停后从水位恢复、root 失败隔离用例通过 |
| S-07 `[x]` 本机启动性能报告 | S-06 | 五类维护 job 的合成数据 JSON 耗时、扫描/删除量、spill root fence 持有时间和 ready-to-show 启动边界检查 | `npm run bench:startup-maintenance -- --seed 20261008 --runs 5` | 2026-10-08 seed 20261008、5 轮合成样本通过，`deferredUntilWindowReady=true`；每轮扫描 260 MCP / 40 Agent / 150 session / 1 spill / 1 usage，分别删除 4 / 11 / 50 / 1 / 1；五轮 spill root fence 0.48–1.59ms，MCP 20.1–30.5ms，SessionEvent 18.4–20.8ms。基准直接计时 job owner，ready-to-show 路径静态断言不等待任务 |

调度线的技术依赖为 **S-00 → S-01 → S-02 → (S-03 / S-04 / S-05) → S-06 → S-07**；S-03、S-04、S-05 在 S-02 后可并行开发。为单独观测 root fence 对活跃 Spill 写入的影响，实施排期建议把 S-05 放在 S-03/S-04 后；这是风险观测顺序，不是代码或接口依赖。工作流 F（索引 unlink 授权）和正式数据副本上的实际性能结论均是后续独立事项，不属于本机交付阻断项。

### 工作流独立完成门

每条工作流完成自身回归门即可独立交付；不要求另一条工作流先完成。

| ID / 状态 | 前置 | 交付物 | 本机验证命令 | 完成判据 |
| --- | --- | --- | --- | --- |
| I-10 `[x]` 索引线回归与边界门 | I-08、I-09 | SQLite 索引/回填/profile 全套 Electron 回归、类型与接口边界记录 | `npm run test:electron`；`npx tsc -p tsconfig.electron.json --noEmit`；`npm run typecheck:agent-sdk`；`npm run check:agent-sdk`；`npm run check:session-storage-boundary`；`npm run check:spill-reference-boundary` | 2026-10-08 Electron 回归 593 文件通过、1 跳过，6,299 tests 通过、109 跳过；Electron/agent-sdk 类型及所有边界命令通过；人工期望集合、竞态/快照/持续写入和性能场景证据见 I-01/I-05–I-09 |
| S-08 `[x]` 调度线回归与边界门 | S-06、S-07 | 五类清理调度 Electron 回归、生命周期和触发语义记录 | `npm run test:electron`；`npx tsc -p tsconfig.electron.json --noEmit`；`npm run check:session-storage-boundary` | 2026-10-08 Electron 回归 593 文件通过、1 跳过，6,299 tests 通过、109 跳过；跨日/DST、quota 代次、唤醒、pause/resume、同步 start 失败隔离、root 失败隔离及清理失败恢复用例通过；启动基准五轮通过 |

### 两条工作流共用的联合交付质量门

| ID / 状态 | 前置 | 交付物 | 本机验证命令 | 完成判据 |
| --- | --- | --- | --- | --- |
| Q-00 `[x]` 全量联合回归与跨层边界验收 | I-10、S-08 | 两条工作流联合后的全仓测试、Electron/renderer/shared/agent-sdk 类型检查及边界检查记录 | `npm test`；`npx tsc -p tsconfig.electron.json --noEmit`；`npm run typecheck:renderer`；`npm run typecheck:shared`；`npm run typecheck:agent-sdk`；`npm run check:agent-sdk`；`npm run check:session-storage-boundary`；`npm run check:spill-reference-boundary`；`git diff --check` | 2026-10-08 全量测试 909 文件通过、1 跳过，8,584 tests 通过、111 跳过；Electron/renderer/shared/agent-sdk 类型及全部边界命令通过，`git diff --check` 通过；main=`codex/spill-reference-index-backfill`，base=`HEAD`（本 worktree 创建点）。不等待正式数据副本或其他平台试运行 |
