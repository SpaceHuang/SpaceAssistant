# 存储设置占用刷新卡顿分析与优化方案

| 字段 | 内容 |
| --- | --- |
| 文档状态 | 代码路径分析与实施计划 |
| 影响入口 | 设置 → 存储设置 → 页面首次打开、刷新按钮、清理/压缩后刷新 |
| 主要结论 | Renderer 调用是异步等待，但 profile 采集同步运行在 Electron 主进程，扫描期间阻塞主进程事件循环 |

## 1. 现象与结论

存储设置组件在挂载时立即调用 `window.api.storageGetProfile()`。Renderer 通过 Promise/IPC 等待结果，所以从 UI 代码外观看是异步的；但主进程 IPC handler 直接调用同步函数 `collectSessionStorageProfile()`。该函数在主进程线程中同步打开 SQLite、执行查询、遍历数据、解析 JSON 和计算 SHA-256，同时同步检查 spill 文件目录。数据量越大，主进程事件循环被占用越久，窗口输入、动画、IPC 响应和设置页切换都会出现卡顿。

问题不在 React 渲染量本身，也不只是目录扫描。核心瓶颈是一次“存储体积展示”请求触发了完整的数据覆盖与一致性审计：遍历 canonical history 事件正文并解析 JSON，构造摘要集合，再遍历全部 messages 计算摘要进行匹配。该项工作与页面展示的字节统计耦合，使打开设置页执行了远超展示需求的工作。

## 2. 调用链

1. `ConfigModal` 选择 `storage` tab 后渲染 `StorageSettingsTab`。
2. `StorageSettingsTab` 的挂载 effect 执行 `refresh()`。
3. `refresh()` 调用 preload 暴露的 `storageGetProfile()`。
4. Preload 调用 `ipcRenderer.invoke('storage:get-profile')`。
5. `registerStorageMaintenanceIpc` 注册的 handler 直接执行 `collectSessionStorageProfile(ctx.db.filePath)`。
6. 采集函数同步完成全部 I/O、SQL、遍历和哈希工作后才返回结果。

Promise 只异步化调用方等待和 IPC 往返，不会自动将 handler 中的同步计算移出主进程线程。

## 3. 具体阻塞来源

### 3.1 主进程同步文件系统操作

`sessionStorageProfile.ts` 中的 `scanSpillDirectory()` 使用 `lstatSync`、`readdirSync`、逐文件 `lstatSync`。另有 SQLite/WAL/SHM 的 `statSync`，pending GC 项逐个 `lstatSync`。当 spill 文件较多、目录所在磁盘较慢或杀毒软件介入时，会放大同步阻塞。

### 3.2 同步 SQLite 查询与全表扫描

采集通过 `node:sqlite` 的 `DatabaseSync` 打开只读连接，使用同步 `.all()`、`.get()`、`.iterate()`。包含表统计、dbstat、canonical coverage 聚合、required-data 聚合和完整消息覆盖核验。部分查询会扫描大表或大范围 JOIN/GROUP BY；同步 SQLite API 在当前主线程中执行时同样阻塞事件循环。

### 3.3 潜在高成本 CPU 路径：正文 JSON 解析和哈希覆盖核验

- 遍历 `agent_history_events` 中的 `invocation-context-committed` 与 `model-response-committed` 行。
- 对每条 `payload_json` 执行 `JSON.parse`，再从消息中抽取文本并生成 SHA-256 摘要。
- 将正文摘要和身份摘要放进 `Set`。
- 再逐条遍历 `messages`，计算正文和身份 SHA-256 并查询集合。
- 统计各角色匹配数、候选正文字节数等审计字段。

此过程读取、解析并反复处理可能很大的正文；它是完整性/覆盖率分析，不是计算存储占用所必需。随着消息数和 canonical history 增长，CPU 时间和临时内存都会增长。当前没有分段实测，不能断定它是实际环境中的最大耗时项；应由 Phase 0 基线确认排序。

### 3.4 页面生命周期导致每次进入都触发完整采集

该 tab 在选中后挂载并立即刷新。组件没有缓存、请求去重或后台预计算，因此每次重新进入都会重复完整 profile。清理缓存和压缩结束后也会再次调用同一完整采集。`loading` 仅控制按钮状态，不能避免主进程被阻塞。

## 4. 影响判断与证据边界

代码已能确认“同步工作位于主进程事件循环”及工作内容；尚未在用户机器上采集具体耗时，因此本文件不声称已量化单次卡顿毫秒数，也不将文件扫描断定为唯一最大耗时。预计主要成本由数据库规模、正文体量、spill 文件数量和磁盘状况共同决定。

应在优化前补充分段耗时数据：总耗时、SQLite 打开/查询耗时、canonical 事件解析与哈希耗时、messages 扫描耗时、spill 扫描耗时，以及行数/文件数。只记录计数、耗时、错误码，不记录正文、文件路径之外的敏感内容或摘要值。

## 5. 优化目标和约束

- 打开存储设置和点击刷新不得在 Electron 主进程事件循环执行大规模同步扫描。
- 页面展示所需的常用容量数据应快速返回；昂贵的历史覆盖审计不应阻塞首屏。
- 保持只读采集、不泄漏正文、保留 WAL/SHM 和 spill 容量统计，以及现有安全的符号链接/普通文件检查。
- profile 可以标注部分统计未知或审计仍在计算；不能把未知伪装成 0，也不能悄悄改变现有审计语义。
- 清理和压缩仍按其既有维护锁、进度和错误语义运行。Worker 迁移必须一并实现 profile 任务与维护操作之间的互斥和排空协议；现有维护锁不视为已覆盖 profile worker。

## 6. 建议实施方案

### Phase 0：建立基线与可观测性

给 profile 采集各阶段加低开销计时和数量指标，记录到诊断日志或受控 telemetry：数据库字节数、messages/event 行数、spill 文件数、各阶段耗时、总耗时、失败码。不得记录任何消息正文或正文 hash。用小、中、大三档本地 fixture 和真实大库采样确认主要成本分布。

验收：可从一次刷新日志区分 SQL、正文审计、文件扫描耗时；埋点本身不显著增加耗时。

### Phase 1：先拆分“容量概览”与“深度审计”

将 API 响应分成轻量概览和可选审计结果（字段名需在实现时统一）。容量概览必须有明确的扫描上界：不得调用 `readCanonicalSpillReferences()` 或其他遍历 canonical history/transcript 正文 JSON 的 fallback。

- **容量概览**：db/WAL/SHM 文件大小、spill 和 spill-degraded 物理字节数、pending GC 容量、表级行数/字节估算、必要的 SQLite 元信息。数据库访问改用 worker 执行，避免同步 SQLite 在主进程阻塞。spill 引用分类仅可使用满足现有可信条件的索引：backfill 状态完整、协议版本正确、verified generation 与 canonical generation 一致。索引缺失、未完成、代际不一致或索引读取失败时，分类返回 `unknown`/不完整及原因码；物理 spill 字节仍可独立报告，不得把未知分类当作 0，也不得将文件误报为 orphan。此时 `sourceOfTruthBytes`、`degradableBytes`、`orphanBytes` 均为未知。物理 spill 总字节仅在目录扫描完整时可知；整体 `totalBytes` 沿用现有完整性语义，只有所有组成项完整且所需分类/引用检查完整时才提供数值，否则为 `null`。
- **深度审计**：`canonicalCoverage`、`canonicalSessionCoverage`、`canonicalRequiredData`、`messageBodyCoverage` 等覆盖率与正文一致性分析，显式按需启动，或在后台/worker 中计算并通过状态更新。结果应有 `pending/complete/failed` 状态和采集时间。
- **严格 spill 引用扫描**：`readCanonicalSpillReferences()` 的全量 JSON fallback 归入显式深度审计/分类任务，不属于容量概览。仅在用户显式请求或低优先级审计调度时运行，并维持原有严格解析语义；结果按深度审计状态返回，不能静默改变为可信索引结果。

Worker 迁移和维护互斥必须作为同一交付阶段，不能先上线 worker、后补互斥。压缩前暂停概览与审计任务准入；取消现有任务，或等待它们完成并确认 worker 已关闭 SQLite 连接、释放读事务；只有全部排空后才允许执行 `wal_checkpoint(TRUNCATE)` 和后续压缩。等待必须在主进程进入同步 checkpoint 之前完成，不能依赖 checkpoint 后的主进程 IPC 回调释放 worker。维护成功或失败后都恢复任务准入。若取消任务，取消完成条件必须包括连接关闭，而非只忽略其结果。清理操作也必须纳入同一维护准入协调，按实际是否写库/移动 spill 决定维护范围。

若短期内暂不拆 API，完整 profile 可先迁入独立 Worker Thread 并以异步 IPC 返回，但容量概览仍不得运行正文覆盖扫描或不可信索引的严格 JSON fallback；worker 生命周期和上述维护互斥协议须同步落地。

### Phase 2：控制重复计算与请求并发

- 以数据库身份（规范化 DB 路径及适当的文件身份信息）和维护失效代际管理概览、审计任务与缓存；概览和审计分别维护缓存与 single-flight。
- 普通并发请求只有在数据库身份、任务类型和代际完全相同时才能合并。手动刷新必须绕过已完成缓存，但在相同代际下可复用正在执行的同类任务。
- 清理或压缩成功后推进该数据库的维护代际并失效受影响的概览/审计结果。旧代际任务不得写回缓存，也不得满足维护后的强制刷新；维护后的刷新必须在新代际启动新任务并读取维护后快照。仅忽略 renderer 旧响应不足以保证此语义。
- 维护失败时按操作语义处理：不得推进“成功维护”代际或展示维护后新鲜数据；恢复任务准入，并允许之后的手动刷新。若维护在失败前已造成部分写入，则实现需报告维护失败并失效可能受影响的缓存，后续读取使用新代际或显式 dirty 标记，不能继续宣称缓存有效。
- 组件卸载或新请求发出时，renderer 忽略旧请求结果；这只保护 UI 状态，不替代主进程代际隔离。
- 深度审计设置独立 single-flight，避免重复点击创建多个全库扫描。

### Phase 3：降低深度审计的扫描成本

- 将正文覆盖核验从普通容量刷新移出。若产品仍需该审计，提供明确的“完整性检查”动作或低优先级后台任务。
- 评估通过已有可靠索引/预计算摘要得到结果，避免每次从所有事件 JSON 重建摘要集合；任何持久化摘要必须定义版本、失效和迁移策略，并保持可重算。
- SQL 聚合先检查索引和查询计划；只保留 UI 实际需要的字段。`dbstat` 全量对象列表、schema/runtime 细节等诊断字段应只在诊断入口采集。
- 文件大小扫描改用 `node:fs/promises`，限制并发并定期让出调度；拒绝符号链接、继续处理普通文件并传播可解释的“不完整”状态。
- 对 worker 任务定义超时、取消/丢弃旧请求、单任务并发上限和关闭清理。取消/超时只有在读连接确实关闭后才算释放维护互斥。不要通过主进程 `setImmediate` 分块来掩盖仍同步的单块 SQLite/JSON/哈希操作。

### Phase 4：UI 状态与结果说明

- 首屏使用最近一次有效概览；没有缓存时显示轻量 skeleton/loading，不在主线程等待深度审计。
- 把“容量统计”和“完整性审计”状态分别呈现。容量可用而审计未完成时正常显示容量，并明确审计状态。
- 显示“统计时间”或刷新状态；采集失败/部分失败时区分未知项与 0。
- 对用户主动刷新提供进行中状态和防重复交互。

## 7. 推荐落地顺序

1. 加入分段耗时指标，生成优化前基线。
2. 明确并实现 profile worker 与清理/压缩的维护准入暂停、在途任务排空及连接关闭确认；与 worker 迁移同一阶段交付。
3. 拆分轻量容量概览、严格 spill 引用扫描和深度覆盖审计；概览只接受可信索引，调整设置页默认只请求概览。
4. 对概览和审计按数据库身份/维护代际分别加 single-flight、缓存及维护后的强制失效刷新。
5. 按基线优化 SQL、spill 文件扫描与深度审计算法。
6. 用固定规模数据库验证耗时、响应性、数据一致性和失败状态。

如果时间允许，Phase 1 与 Phase 2 可以合并开发；但不能把完整大规模扫描留在同步 IPC handler 中作为最终方案。

## 8. 验收标准

- 存储设置首次进入、手动刷新、清理后刷新期间，窗口交互和主进程 IPC/心跳不出现与数据库规模线性增长的长停顿。
- 主进程事件循环延迟有明确测量；大库基准中 profile worker 计算不阻塞主进程。
- 默认容量响应不执行全量正文 JSON.parse/hash 覆盖扫描。
- 同代际、同数据库身份、同类型的普通并发请求合并；手动刷新绕过完成缓存。
- 清理/压缩成功后代际推进，维护前任务既不能回填缓存也不能满足维护后刷新；维护后结果来自维护后的数据库快照。维护失败后准入恢复，并按部分写入风险失效缓存。
- worker 持有读快照期间由主连接写入 WAL，再启动压缩；验证压缩先排空 worker 并成功 checkpoint，维护期间不启动新读任务，worker 连接确已关闭，任务不悬挂，失败后读任务准入恢复。
- 索引缺失、backfill 未完成、generation 不一致、索引查询失败均使概览 spill 分类为未知/不完整；概览不得调用严格 canonical 引用扫描，不能把未知分类改成 0 或误报 orphan。独立严格审计仍保持原有语义。
- 用可控延迟任务验证缓存竞态：维护前任务 A 在途，维护成功后发起强制刷新 B；断言 B 不合并到 A、取得维护后数据，A 不能回填缓存。普通同代请求仍合并。
- 组件卸载后不触发无效状态更新；旧 renderer 响应被忽略。
- 文件访问异常和 worker/SQLite 错误展示为未知/失败，不作为零容量；只读行为和符号链接安全约束维持。
- 现有容量统计语义（db、WAL/SHM、两类 spill、pending GC）由回归验证覆盖；深度审计仍可单独运行并保持结果语义。

## 9. 涉及代码位置

- `src/renderer/components/Config/StorageSettingsTab.tsx`：挂载即刷新、刷新和维护完成后刷新。
- `src/renderer/components/Config/ConfigModal.tsx`：存储 tab 的懒渲染入口。
- `electron/preload.ts`：`storageGetProfile` IPC 桥接。
- `electron/ipc/storageMaintenanceIpc.ts`：同步 handler 直接运行采集，是主进程阻塞入口。
- `electron/database/sessionStorageProfile.ts`：同步 SQL、文件扫描及正文覆盖审计。
- `electron/database/sessionStorageCleanupEstimate.ts`、`scripts/session-storage-profile.ts`、`scripts/session-storage-maintenance-profile.ts`：其他采集调用方；迁移采集执行模型时须避免破坏 CLI/维护流程。

## 10. 后续验证清单

- 检查其他调用方是否依赖完整审计字段；按调用场景保留独立诊断接口或脚本。
- worker 与主进程之间只传递可序列化 profile 数据；不传正文、DatabaseSync 对象或 renderer 句柄。
- 明确 SQLite 快照和文件扫描不是同一原子时点；响应应包含采集时间及部分完成状态。
- 验证大量行、超大 payload、文件快速新增/删除、符号链接、缺目录、权限错误、worker 退出和维护任务并发场景。
- 固定小/中/大 fixture 的数据规模与生成方式，规定重复次数、概览响应时间和主进程事件循环延迟阈值，作为自动回归基准；阈值由 Phase 0 基线与产品目标确定并写入实现验收记录。
- 验证 worker 入口在开发环境、Electron 编译产物和打包应用中的加载路径；worker 加载失败必须返回明确错误，不得回退到主进程同步 profile 采集。
