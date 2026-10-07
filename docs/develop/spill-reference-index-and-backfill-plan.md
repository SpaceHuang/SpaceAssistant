# Spill 引用索引与可续跑回填方案

## 目标与边界

当前 spill 目录的维护必须知道 canonical History 是否仍引用某个 locator。完整引用集由 `agent_history_events.payload_json` 和 `session_transcript_entries.messages_json` 中的 spill descriptor 共同构成。扫描不仅服务于启动期 degradable retention，也服务于 source-truth GC、崩溃孤儿文件回收、存储 profile 和清理估算。任何漏记都可能让 GC 删除仍被引用的 source-truth 文件，因此索引的首要目标是保持引用完整性，启动提速排在其后。

本方案分两项：建立事务维护的规范化引用索引；对已有数据库做可暂停、可续跑、可校验的分批回填。索引完整性尚未得到证明前，现有严格全量扫描继续作为安全判据，索引不能单独授权文件删除。

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

## 4. 旧数据库的可续跑、分批回填

### 元数据与状态机

新增 migration-owned 的 `spill_reference_backfill_state`，按数据集记录：`status` (`pending/running/paused/complete/failed`)、`source_table`、稳定游标、扫描行数、索引行数、错误摘要、开始/更新时间、回填协议版本和最终校验时间。游标采用 owner 主键的确定性 keyset 顺序，不使用 `OFFSET`，避免深页扫描和并发变更造成跳行。

状态转移：

```text
pending -> running -> complete
                  -> paused -> running
                  -> failed -> running（修复/重试后）
```

只有完整扫描、增量写入已开启、且全量差异校验一致时才可置为 `complete`。进程崩溃后保留最后一个已提交 batch 的游标；重跑 batch 必须幂等。

### 批次流程

1. 迁移创建索引表与回填状态，标记 `pending`。若 SQLite schema migration 需要锁表，只做建表和状态初始化，不在 schema transaction 内遍历大 JSON。
2. 部署支持双写的应用版本：所有新写入在 canonical transaction 中同步维护索引。回填 worker 仅在双写版本启动后工作。
3. 每轮按固定上限（首选 200–500 个 owner 行，并设置最大 payload byte budget）读取一页；对每行 strict parse/collect，在一个短事务中 upsert 索引并推进该表游标。
4. batch 失败则回滚索引行和游标；记录错误类型与 owner key，不记录正文内容。可暂停 worker，修复数据或 parser 后从最后提交游标续跑。
5. History 与 transcript 分别记录游标和进度，避免一类大表阻塞另一类。worker 每批让出事件循环，并在启动时设时间预算；桌面首屏关键路径不等待整库回填。
6. 两表到达末尾后进行一致性校验：用 strict canonical collector 对每个 owner 计算期望 descriptor，与索引按 owner/path 双向比对；同时核对引用总数、locator 集合、kind 和 descriptor 快照。校验可分批持久化进度，未全部完成前状态不能置 `complete`。
7. 完成状态提交后只允许索引 shadow compare 和不授权删除的读路径。影子差异、schema 版本不匹配或新写路径未双写时，将索引标为不可用并继续全量扫描；source-truth GC 与孤儿删除始终执行严格全量扫描，直到 unlink 授权另经评审。

### 并发写入与快照一致性

SQLite 单写者事务使每一批索引更新与 canonical 写入有明确顺序，但长时间回填不能依赖一个跨全库长读事务。双写先行解决新增/修改行；worker 用 keyset 分页，批次开始时读取已提交 canonical 行并在同一短事务内写入对应索引。canonical owner 若在读取后被更新，在线 writer 的事务会写入新索引；回填 upsert 必须检查 owner 当前 revision/hash，避免旧快照覆盖较新的双写结果。建议索引保存 `owner_revision`（如 `updated_at`/version 加 payload hash）；条件不匹配时跳过该批行并让后续校验重读。

删除竞争也必须确定：如果 owner 在回填页之后被删除，删除事务会清除其索引；如果删除先发生，worker 的 owner 查询读不到该行。不得在删除 canonical 行后再异步清索引。

### 故障、损坏与回滚

- JSON 或 descriptor 不合法：标记 `failed` 并记录 owner/table/error code；继续使用严格全量扫描语义，涉及完整引用集的删除清理暂停或返回失败。不能把坏行当成无引用。
- 磁盘空间不足、进程退出或锁竞争：保留已提交 batch，标记 `paused` 或由下一次启动根据租约恢复；不回滚已完成批次。
- 索引损坏或校验差异：关闭索引读路径，恢复全量扫描；保留索引用于诊断，可删除后重建，但不能清空游标后误报 complete。
- **不支持旧版本打开新 schema**：索引表通过递增 `DB_SCHEMA_VERSION` 引入，沿用 `electron/database/migrations.ts` 的 schema floor；旧二进制遇到更高 schema 必须拒绝打开。回滚只能恢复该旧版本可读且 canonical/index 状态匹配的整库备份，不做 schema 降级，也不承诺旧版本可继续写新 schema。
- canonical-only 恢复/导入工具若受支持，必须在同一事务内先将索引置为 `pending/untrusted`，再替换 canonical 数据；事务提交前不能让应用读切换。若工具无法原子失效索引，则不得用于启用索引读路径的数据集。完整数据库备份/恢复应同时包含 canonical、索引和状态；恢复后仍核对 schema 与索引协议版本。
- `complete` 字段本身不能发现索引外的旧 writer 或 canonical-only 恢复。安全依赖是 schema floor 拒绝旧 writer，加上受支持的恢复入口必须失效索引；版本匹配不被描述为独立完整性证明。重启时若状态不是 `complete` 或恢复协议无法确认，必须保持全量扫描。

## 启动期与周期清理的执行策略

这五类清理都是保留策略或容量策略，不需要阻塞每次启动。建议统一改为“窗口可用后低优先级执行 + 持久化成功水位 + 条件触发补跑”。清理失败时不推进水位；文件/行级删除保持幂等，下次继续即可。配置策略改变时重新计算策略指纹并立即安排一次维护。维护任务必须有单实例运行保护、可取消/可让出事件循环，并记录 `skipped / completed / failed`、扫描量、删除量和耗时。

启动只负责检查是否有过期水位或待处理标记，并安排任务；不在首屏路径同步遍历大目录或 canonical 大表。各清理的“一天一次”是初始节流建议，不改变保留期、删除对象或授权语义；之后根据耗时和清理及时性指标调整。

| 清理项 | 当前启动行为 | 建议执行策略 | 每次启动仍需做的事 |
| --- | --- | --- | --- |
| Spill degradable retention | 每次启动扫描并解析所有 History / transcript payload，再筛选过期 degradable descriptor；扫描在 spill root fence 内执行 | 窗口显示后按本地自然日运行；若 retention 配置变化则立即重跑。索引未获删除授权前，只做 shadow compare；严格全量扫描仍决定可删除的 locator、kind 和过期时间。若全量扫描持锁时间明显影响活跃 spill 写入，需先实现有一致性保证的短锁/分段协议，不可直接把扫描移出 fence | 仅检查 last-success 水位、策略指纹和任务是否正在运行；source-truth GC 仍独立处理 pending queue |
| MCP artifact 清理 | 启动时做 TTL 和目录配额清理；当前调用链对 TTL 文件列表重复扫描 | 合并为单一清理遍历：同次枚举收集文件信息，同时决定 TTL 删除和配额淘汰；TTL 每日执行，达到配额阈值时由 artifact 写入路径安排一次 quota sweep。清理放到窗口可用后；该模块在 DB 打开前调用，因此状态可用 userData 下的独立小型状态文件，或采用幂等每日执行而不引入状态文件 | 检查是否需要安排 TTL sweep；不可因状态文件损坏跳过清理 |
| SessionEvent 保留清理 | 每次启动扫描所有配置 workDir 下的 session 目录，按 `lastAt` 清理超出 maxSessions 的台账，并保护 canonical/compaction 依赖 | 窗口可用后每日执行；maxSessions 策略变化时重跑。session 创建/关闭后可安排合并的低优先级 sweep。保留前的 `shouldRetainSessionDir` 和 `prepareProjectionForRetention` 继续逐候选执行，不缓存授权/依赖结论 | 检查 workDir 集合、策略指纹和 last-success 水位；路径/profile 集合变化时使相关 root 水位失效 |
| Agent 日志保留清理 | 每次启动枚举 Agent 日志目录，按日期删除超期文件 | 窗口可用后每日执行；保留天数或日志目录变化时重跑。删除按文件幂等，只有完整枚举成功后才推进水位 | 检查目录、策略指纹和日期水位；日志目录缺失按空目录处理 |
| 用量事实保留清理 | 每次启动按本地自然日 cutoff 删除超期 usage facts | 窗口可用后每日执行；保留天数改变时立即重跑。保留策略设为 `forever` 时跳过并记录该策略指纹 | 检查 retention 值、local day 和 last-success；cutoff 未前进且策略未变时不重复 DELETE |

### 调度水位与时区规则

- 每项维护使用独立的 `last_success_day`、`policy_fingerprint`、`root_fingerprint`（适用时）和 `last_error`。DB 内维护项使用 schema-owned maintenance state；MCP 在 DB 尚未打开时运行，应使用专属 userData 状态文件，或选择无水位的幂等每日执行，不能依赖稍后才打开的 SQLite。
- 日周期按既有业务口径计算：usage facts 使用其 `localDayString` 对应的本地自然日；Agent 日志按文件名日期；其他维护用统一本地自然日。跨日启动触发 sweep，避免用 UTC 日界改变保留结果。
- 只有整轮扫描和必要删除都成功后才写 success 水位。部分文件删除成功但之后失败时，重跑应安全地略过已不存在文件并继续；不得提前写水位导致漏删。
- 数据库清理的策略指纹至少包含生效保留值和算法版本；文件清理的 root fingerprint 包含规范化路径。策略/算法升级可显式递增版本，使旧水位失效。
- 初次发布新调度器时水位为空，首次 sweep 在窗口可用后执行。维护失败不阻塞应用；失败状态下后续启动或后台退避重试。任务互斥按维护类型和 root 限定，避免同一目录并发删除。

### 与恢复工作的边界

此处只调整策略型 retention，不延迟有明确崩溃恢复语义的工作。特别是 spill source-truth GC：session 删除事务已经写入 durable queue，启动仍需尽早检查并恢复 pending 项；周期 full-directory 分类也继续按现有持久 cursor 与周期运行。usage 的 `reconcileUsageTurnFacts` 是崩溃事实补齐，不属于保留清理，应与每日 retention 分开。SessionEvent 的完整 ledger reconcile 也不在本节直接改成每日；需要先证明有持久 dirty/pending 标记能覆盖所有 append、index stale、崩溃尾行和 profile 切换，否则只能优化候选发现，不能降低恢复覆盖面。

### 按项落地顺序

1. **MCP 重复扫描先收敛**：让一个入口完成 TTL 与 quota 两种策略，消除 `cleanupMcpArtifactsOnStartup` 先调 `cleanupExpiredOutputArtifacts`、随后又调内部重复 TTL 清理的情况；补充每文件只 stat 一次的观测。
2. **统一低优先级调度约定**：窗口 ready 后再启动维护；分项水位、策略指纹、运行互斥、失败重试和耗时指标。不能让某一项失败阻止其余清理。
3. **迁移低风险文件清理**：Agent 日志、MCP TTL/quota、SessionEvent retention 先切每日/策略变更触发；验证删除上限、依赖保护、失败重试与路径变化行为一致。
4. **迁移 usage facts retention**：按自然日和策略指纹跳过无变化的 DELETE；crash reconciliation 保持每次启动。
5. **迁移 spill retention**：先按每日/策略变化触发降低首屏频率；索引双写、回填、全量对账完成前仍使用严格扫描，不缩小引用范围。切换到索引后继续保留不可信状态回退和 source-truth 独立 GC。

### 验收指标

- 冷启动首屏时间不再包含上述周期 sweep；每项启动只进行常数级水位判断，spill 除外的水位不可导致大目录枚举。
- 同一成功日期和策略指纹下，第二次触发结果为 skipped，扫描行数/文件数为零；策略变化、跨本地日、root/profile 集合变化能触发维护。
- 在清理中途注入失败并重启，水位不前进且重跑可完成；同一 root 不并发运行；其他维护项仍可运行。
- 对比迁移前后的删除集合完全一致：spill 仅删过期 degradable；SessionEvent 保留 canonical 投影和 compaction 依赖保护；Agent/MCP 保留原阈值/配额；usage 按相同 local-day cutoff 删除。
- 记录各 sweep 的启动前等待时间、窗口 ready 时间、运行耗时、扫描量、删除量、锁等待和失败重试。spill 还需记录 root fence 占用时长；周期化不能以未测量的活跃写入阻塞换取首屏指标改善。

## 分阶段实施与放行条件

| 阶段 | 变更 | 放行条件 |
| --- | --- | --- |
| A. 契约收敛 | 盘点 canonical 所有写点；统一 strict descriptor 提取和 owner key；补事务测试 | 每个 canonical insert/update/delete 写点都有索引维护设计，source-truth/degradable 语义不变 |
| B. 建表双写 | 新表与状态 migration；canonical 与索引同事务双写，读端仍全量扫描 | 新旧扫描结果一致；事务失败不出现半写；session delete/共享 locator 行为不变 |
| C. 分批回填 | 后台 keyset worker、暂停/恢复、字节预算、错误状态 | kill/reopen/重复 batch/并发更新删除测试均通过；启动关键路径不等待全表 |
| D. 全量对账 | owner/path 双向核验，影子索引查询和差异遥测 | 多次正式规模副本对账为零差异；损坏与旧版本回滚能 fail closed |
| E. 受控只读切换 | 在受支持 schema/write protocol 与恢复边界确认后，profile/retention 可影子读取或采用索引；GC unlink 和孤儿删除仍由严格全量扫描授权 | 旧版本打开新 schema 被拒绝；canonical-only 恢复会原子失效索引；差异时即时回退；不得出现索引单独授权 unlink |
| F. 删除授权另行评审 | 如需让索引替代全量扫描授权 unlink，另立完整性证明协议及评审，不属于本方案默认放行 | 覆盖漏记共享 owner、JSON 转义、嵌套 marker、候选外坏行/未知 schema、表缺失、并发新增引用；任何证明失败都拒绝删除 |
| G. 性能决策 | 评估全量扫描是否可在特定读场景减少，或是否引入持久化摘要 | 基于正式规模副本的耗时、CPU、RSS、锁占用和索引写放大另行评审，不自动放宽 GC 安全门 |

## 必须覆盖的验证矩阵

- History 与 transcript 各自 0/1/多 descriptor；同 locator 多 owner 共享；同 owner 多位置引用；source-truth/degradable 混合。
- append、owner 更新、session delete、事务提交失败、descriptor 校验失败后索引与 canonical 原子一致。
- 回填时并发 insert/update/delete；重复 batch；游标边界；同一 locator 被不同 owner 引用。
- 每个 batch 后杀进程并重开；暂停与续跑；错误修复后重试；磁盘/锁失败；较大 payload 触发 byte budget。
- 坏 JSON、未知 spill marker/schema、缺少任一 canonical 表、索引缺行/多行/旧版本时都不允许 GC unlink；漏记共享 owner、JSON Unicode 转义 locator、任意嵌套引用及候选外坏行不能被索引定向复核漏过。
- schema floor 拒绝不支持的旧版本；完整备份恢复；canonical-only 恢复事务先失效 `complete` 后替换数据；恢复协议不确定时持续使用全量扫描。
- 全量扫描与索引逐 owner 对账；索引关闭时原有 spill retention、source-truth GC、孤儿清理、profile 和清理估算功能结果不变。
- 性能比较必须使用正式数据库的隔离副本，记录 History/transcript 行数、字节数、descriptor 数、耗时、RSS 峰值、启动首屏时间与 SQLite 写放大；真实数据库不作为试验写入目标。

## 当前可先做的安全优化

当前工作区 `readCanonicalSpillReferences` 已逐行迭代 History 与 transcript 表，不再使用 `.all()` 同时保留整表 JSON 字符串；严格解析仍需遍历所有 canonical 行，descriptor 结果集仍占内存。基准需同时测耗时和 RSS，不能仅凭代码形态断言启动有明显提速。扫描计数、字节数和分表耗时用于判断索引收益是否值得写放大与迁移复杂度。

## 评审修订记录（2026-10-07）

- **P1：定向 canonical 复核不能证明全局零引用。** 阶段 E 改为索引只读/影子使用；source-truth GC 与孤儿 unlink 继续以严格全量 canonical 扫描作为唯一授权依据。任何未完成全量扫描的情况 fail closed。
- **P1：`complete` 状态的回滚/恢复失效机制不充分。** 明确通过提升 `DB_SCHEMA_VERSION` 使用现有 schema floor 拒绝不支持旧版本；canonical-only 恢复入口必须事务性失效索引，无法做到则不得支持索引读切换。完整性不依赖状态字段版本匹配本身。
- **P2：MCP 清理不能安全推进成功水位。** 迁移调度前，清理 API 必须返回结构化成功结果或抛错：仅 ENOENT 可按空目录/已删除处理；readdir/stat/unlink 的其他错误使整轮失败且水位不前进；配额总量只在 unlink 成功或确认文件已不存在后扣减。重试应重新枚举并完成未成功项目。
- MCP 对应测试需覆盖目录枚举失败、单文件 stat 失败、TTL/quota unlink 失败、quota 不因失败删除而误降，以及修复错误后重跑成功。TTL helper 不得把非 ENOENT 的 readdir 失败吞成空目录。
