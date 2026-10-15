# 存储设置占用刷新卡顿：本机开发与自动化验证计划

> 依据：[`docs/develop/storage-settings-profile-latency-analysis-and-optimization-plan.md`](../develop/storage-settings-profile-latency-analysis-and-optimization-plan.md)、[`docs/review/2026-10-10-storage-settings-profile-latency-plan-review.md`](../review/2026-10-10-storage-settings-profile-latency-plan-review.md)、[`docs/develop/2026-10-10-storage-settings-profile-latency-development-plan-review.md`](../develop/2026-10-10-storage-settings-profile-latency-development-plan-review.md)。
> 范围：本机 TypeScript/Vitest、临时 SQLite/文件 fixture、Electron worker 实际启动和打包 smoke test，以及本机真实安装数据只读采样。不依赖外部服务或人工 UI 观察。
> 日期：2026-10-10
> 计划状态：执行中（worktree `codex/storage-settings-profile-latency`，基线 `ed3dac54`）。

## 执行约定

- 本计划是唯一执行清单，按编号顺序推进；一个任务是可独立验收的行为包，测试先行是任务内部步骤，不另设 RED/GREEN 任务。
- 开始任务前将其标为 `- [～]`。若测试因目标行为缺失而预期失败，记录该 RED 证据并继续同一任务的实现；fixture、导入、编译等非预期失败须先修复。任务全部验收通过后标为 `[x]` 并记录命令、结果和证据，再进入下一项。
- 初次锁定现有行为的测试可以直接通过；记录这是兼容基线，不要求制造失败。
- 一项任务失败时保留 `[～]` 并记录首错、预期/实际及堆栈，不得开始后续任务。无关既有测试失败须记录归因；只有与本任务相关或阻止安全验收时才阻断当前项。
- 每项限定目标文件范围；如发现需增改文件，先更新本计划的文件清单与依赖，再实施。
- 正确性/无写入验证使用临时 DB。真实安装仅用于只读性能采样；不运行压缩、清理、迁移或写入 PRAGMA。
- 优化前和优化后性能基准使用同一版本 fixture、探针、重复次数和统计口径。门槛在优化前基线任务中依据产品目标固定，不能由最终实现数据反推或自动放宽。

## 数据安全和真实样本规则

- 真实样本通过 Electron `app.getPath('userData')` 和仓库既有 DB 定位规则唯一确定；不遍历猜测其他目录。dry-run 显示是否唯一可采样及脱敏身份，不显示绝对路径。
- 真实样本工具只记录 allowlist：脱敏 DB 身份、文件/行数级数量、阶段耗时、event-loop delay、分类完整状态、错误码。不得输出正文、hash、附件、凭据、绝对路径或完整 profile。
- 真实安装缺失/损坏/不可读/无法只读打开时记录 `skipped` 与原因并继续，不要求用户提供数据库副本。
- 活动数据库只读采样期间可有应用外部写入。外部变化标为 `concurrent-change/inconclusive`，不能据此归因采样器违规写入，也不作为无写入证明；不停止应用、不操作真实 DB/WAL 来制造静止条件。
- 采样器是否写入由只读打开方式、允许操作审计和无外部写入者的临时 fixture 验证；真实采样不能承担确定性写入归因。

## 任务 1：基线、合成性能探针与优化前证据

状态：**[x]**

**依赖：** 无。

**目标文件：** 新增 `scripts/storage-profile-perf-baseline.ts`、`scripts/storage-profile-perf-baseline-fixture.ts`、`electron/database/storageProfilePerfBaseline.test.ts`；新增 `docs/plan/evidence/storage-profile-before.json`；更新本计划。不得改 profile 生产代码。

**工作与验收：**

- 记录分支、`git status --short`、Node/npm、依赖状态及目标文件既有改动。
- 记录并运行当前相关正确性测试：
  `npx vitest run electron/database/sessionStorageProfile.test.ts electron/database/sessionStorageProfile.spillReferenceIndex.test.ts electron/ipc/storageMaintenanceIpc.test.ts electron/storage/sessionStorageMaintenance.test.ts src/renderer/components/Config/StorageSettingsTab.test.tsx`。
- 建立固定、版本化的小/中/大合成 DB fixture，显式固定 schema、行数、payload 字节数、spill 文件数、索引状态及生成 seed。
- 实现相同探针测量原同步 profile handler 总耗时，以及主进程轻量 timer/IPC 响应延迟；指标只含计数和耗时，不含正文。逐阶段内部计时待 collector 拆分后由同一探针接入。
- 固定每档预热 2 次、正式重复 7 次、median 与 nearest-rank p95；主进程响应 p95 目标 50 ms，最终以独立 IPC smoke 测量确认，不从后续实现成绩推导。
- 运行优化前基线；即使同步方案违反目标阈值，也把它记录为有效基线证据，不因预期性能失败阻断任务。

**证据：** `docs/plan/evidence/storage-profile-before.json`，仅含合成样本指标、fixture 版本、命令与运行时版本。

**执行记录：** 2026-10-10；分支 `codex/storage-settings-profile-latency`，基线 `ed3dac5479e9ff3f21e1a41d2474faa2f9a97500`；Node `v26.4.0`、npm `11.17.0`、依赖已安装。原工作树含无关 remote IM 文档改动及本计划输入文件的未提交改动，均未覆盖；计划及其两份输入文档已复制到新 worktree。相关正确性基线命令通过：5 files / 26 tests。fixture 测试命令 `npx vitest run electron/database/storageProfilePerfBaseline.test.ts` 通过：1 file / 2 tests。`storage-profile-before.json` 记录 2 次预热、7 次测量和 nearest-rank p95；large 档主事件循环响应 p95 `766.753ms` 超出固定 `50ms` 目标，作为有效优化前证据继续。最终重跑补全运行时 npm `11.17.0`。

## 任务 2：数据合同与严格审计兼容边界

状态：**[x]**

**依赖：** 任务 1。

**目标文件：** `src/shared/storageTypes.ts`、`src/shared/storageTypes.test.ts`、新增 `typeTests/storageTypes.typecheck.ts` 及 `tsconfig.storage-type-tests.json`（项目无既有 `typeTests/`，并更新 `scripts/check-shared-config-types.mjs` 以纳入新检查）、`electron/database/sessionStorageProfile.ts`、相关测试及严格审计调用方 `electron/database/sessionStorageCleanupEstimate.ts`、`scripts/session-storage-profile.ts`、`scripts/session-storage-maintenance-profile.ts`。

**工作与验收：**

- 先写类型/运行时回归测试，明确 `StorageOverview`、spill 分类状态和 `StorageAudit` DTO：unknown 不用 0 表示；采集时间、完整状态和错误码明确；DTO 可结构化克隆且不含正文、摘要、DB connection 或非传输对象。
- 用 `typeTests/` 编译期检查覆盖 renderer/shared 边界；运行 `npm run typecheck:shared`。
- 将采集内部边界整理为 overview 与 strict audit 可独立调用的函数，但暂不改变现有 IPC 执行模型。
- 锁定完整审计和现有脚本/cleanup estimate 的结果语义、只读行为及正文不泄漏；同一临时 DB 上拆分前后严格审计结果等价。
- 任务记录涉及文件的实际路径和聚焦 Vitest/typecheck 结果。

**执行记录：** 新增 `StorageOverview`、`StorageAudit` 及兼容 strict profile 类型；原完整 collector 保持同步执行且字段不变，CLI 与 cleanup estimate 显式走 strict profile 包装。DTO 运行时测试覆盖 structured clone、unknown/null 与正文脱敏；typeTests 已接入 `npm run typecheck:shared`。命令 `npx vitest run scripts/session-storage-profile.test.ts electron/database/sessionStorageProfile.test.ts electron/database/sessionStorageProfile.spillReferenceIndex.test.ts electron/database/sessionStorageCleanupEstimate.test.ts electron/ipc/storageMaintenanceIpc.test.ts electron/storage/sessionStorageMaintenance.test.ts src/shared/storageTypes.test.ts` 通过：6 files / 29 tests；`npm run typecheck:shared` 通过两个 gate；`git diff --check` 通过。

## 任务 3：轻量 Overview Collector 与可信 spill 分类

状态：**[x]**

**依赖：** 任务 2。

**目标文件：** `electron/database/sessionStorageProfile.ts`、`electron/database/sessionStorageProfile.overview.test.ts`、`electron/database/sessionStorageProfile.spillReferenceIndex.test.ts`、`electron/storage/spillReferenceIndex.ts`（仅在需共享只读查询时）。

**执行记录：** Overview 独立执行只读 SQL 和文件元数据扫描；可信索引严格要求两个 owner、协议版本 1、complete backfill 和 generation 一致。索引不可用时分类 unknown、各分类 bytes 为 null，overview 不调用 strict scanner，也不遍历或解析正文 JSON。扫描异常保留已观测物理 bytes 并标记 incomplete；totalBytes 仅完整时返回。命令 `npx vitest run electron/database/sessionStorageProfile.overview.test.ts electron/database/sessionStorageProfile.test.ts electron/database/sessionStorageProfile.spillReferenceIndex.test.ts electron/database/sessionStorageCleanupEstimate.test.ts src/shared/storageTypes.test.ts` 通过：5 files / 23 tests；`npm run typecheck:shared` 与 `git diff --check` 通过。

**工作与验收：**

- 测试先行覆盖：DB/WAL/SHM、表级容量、spill 物理文件数/字节、pending GC、必要 SQLite 元数据及错误状态。
- spill 分类只使用可信索引：两个 owner backfill 均 complete、协议版本正确、verified generation 与 canonical generation 相同。
- 索引缺失、backfill 未完成、协议错误、generation 不符或索引查询失败时分类为 unknown 并给出稳定原因码；不能归零或将未知文件算作 orphan。
- 物理 observed bytes 独立于分类返回；目录不完整时相应物理完整标志为 false。整体 `totalBytes` 只有全部必需组成项完整时返回数值，否则为 null。
- spy/调用计数测试证明 overview 不调用 `readCanonicalSpillReferences()`，也不解析 history/transcript 正文 JSON。
- 用缺目录、符号链接、普通文件、扫描中消失、权限错误 fixture 验证局部失败结果。只读取文件元数据，不读取 spill 正文。

## 任务 4：Strict Audit Collector 与现有诊断调用兼容

状态：**[x]**

**依赖：** 任务 3。

**目标文件：** `electron/database/sessionStorageProfile.ts`、`electron/database/sessionStorageProfile.test.ts`、`electron/database/sessionStorageProfile.spillReferenceIndex.test.ts`、`electron/database/sessionStorageCleanupEstimate.ts`、`electron/database/sessionStorageCleanupEstimate.test.ts`、`scripts/session-storage-profile.ts`、`scripts/session-storage-maintenance-profile.ts`、`scripts/session-storage-profile.test.ts`。

**执行记录：** legacy strict collector 字段语义保留；CLI/cleanup estimate 显式调用 strict profile 包装。Strict audit DTO 只返回覆盖率和引用计数；trusted index 失效仍触发原 canonical JSON fallback，畸形 JSON 保持 incomplete。命令 `npx vitest run electron/database/sessionStorageProfile.spillReferenceIndex.test.ts electron/database/sessionStorageProfile.test.ts electron/database/sessionStorageProfile.overview.test.ts electron/database/sessionStorageCleanupEstimate.test.ts scripts/session-storage-profile.test.ts src/shared/storageTypes.test.ts` 通过：5 files / 25 tests；`npm run typecheck:shared`、`git diff --check` 通过。

**工作与验收：**

- 将 canonical coverage、session coverage、required data、message body coverage 和严格 spill 引用扫描保留在显式 audit 路径。
- 严格 scanner 在可信索引不可用时仍按既有逻辑调用 `readCanonicalSpillReferences()`；仅 audit 可触发该全量 JSON fallback。
- 现有 CLI 与 cleanup estimate 明确调用完整审计接口，字段和行为兼容；audit 结果、日志、CLI stdout 不泄漏正文/hash。
- 临时 DB 回归覆盖可信索引、fallback、畸形 JSON 和表缺失场景；overview 仍保持无 fallback。

## 任务 5：真实 Worker Client 与可中断性合同

状态：**[x]**

**依赖：** 任务 3、任务 4。

**目标文件：** 新增 `electron/storageProfile/storageProfileWorker.ts`、`electron/storageProfile/storageProfileWorkerClient.ts`、`electron/storageProfile/storageProfileWorkerClient.test.ts`；Electron 构建沿用现有 `tsconfig.electron.json`，不需额外 emit 配置。

**执行记录：** 增加独立 one-shot worker 和 client，成功、SQLite 错误、异常退出、缺 worker 入口、timeout 与 abort 均 settle；取消/超时 Promise 在 `exit` 后才结束。合成大库严格 audit 在同步扫描期间触发 150ms watchdog 后，实际 worker 退出、checkpoint 成功，后续 overview 成功。worker client 聚焦测试通过：1 file / 6 tests。同步 SQLite/单次 JSON/hash 不宣称可即时 cooperative cancel，主进程 watchdog terminate。初次 build 因 worktree 依赖树缺失 `@earendil-works/pi-ai`，执行 `npm install` 后恢复；依赖审计报告 42 项（5 low、11 moderate、22 high、4 critical），未升级依赖。

**工作与验收：**

- 实现只接收 overview/audit DTO 请求的 worker 入口和 client；本任务先以直接 client 调用验收，不依赖尚未切换的 IPC。
- worker 真实执行对应 collector；成功、SQLite 错误、加载失败、异常退出均在规定超时内 settle，拒绝主进程同步 fallback。
- 明确同步 SQLite `.get/.all/.iterate`、单次 JSON.parse 和哈希调用无法被 worker 自身事件循环消息即时中断。可分块循环检查共享取消标志；不可中断调用由主进程 watchdog 监测。
- watchdog 到期时终止 worker，等待 `exit` 事件和 SQLite 文件锁释放证据后才报告 drained；不得将“取消消息已发送”或“Promise 已拒绝”当作资源释放。
- 用真实 Worker Thread + 合成 DB 测试：在长同步 CPU 阶段、持有读快照阶段触发取消/超时（含 worker 无法处理消息的情况）；在上限内 worker 退出、checkpoint 成功、后续采集成功。强制终止路径不得依赖 JS finally。
- 临时 fixture 的只读证明覆盖 SQLite 打开模式、禁止写 SQL/维护调用、运行前后持久数据一致；活动真实 DB 的文件时间变化不用于证明采样器写入。

## 任务 6：Coordinator 身份、缓存代际、single-flight 与并发上限

状态：**[x]**

**依赖：** 任务 5。

**目标文件：** 新增 `electron/storageProfile/storageProfileCoordinator.ts`、`electron/storageProfile/storageProfileCoordinator.test.ts`；shared/telemetry DTO 仅在需要时改动。

**执行记录：** 完成 identity/type/generation key、single-flight/cache/force、generation cache fencing、全局与每库 worker 上限、有限队列、overview 优先和 worker reject 后释放计数。任务 7 完成后又加入 lease 活跃时拒绝旧缓存与在途结果的回归测试。`npx vitest run electron/storageProfile/storageProfileCoordinator.test.ts` 通过：1 file / 11 tests。

**工作与验收：**

- coordinator 按规范化 DB 身份隔离任务和缓存；任务 key 包含 overview/audit 类型及维护代际。
- 普通同身份、同类型、同代际并发合并；不同类型/代际/DB 不合并。手动刷新跳过完成缓存；同代际可复用同类在途任务。
- 成功维护推进代际并失效受影响的 overview/audit cache；旧代际任务既不能回填，也不能满足维护后强制刷新。失败维护按 dirty 规则处理可能部分写入的缓存。
- 设置全局与每 DB worker 最大并发、有限等待队列及明确拒绝策略；overview 优先级高于 audit，审计不能饿死概览或无限积压。测试覆盖 overview+audit 并发、跨代任务和跨 DB 总量上限。
- 测试可控竞态：A 旧代际在途、维护成功、B 强制刷新；B 启动新任务读取新快照，A 不能回填；普通并发仍合并。
- 限制 worker 崩溃、拒绝、超时、取消后任务表与 semaphore 均释放，无未完成 Promise 悬挂。

## 任务 7：维护互斥、IPC/Preload 一次性接入

状态：**[x]**

**依赖：** 任务 5、任务 6。

**目标文件：** `electron/storageProfile/storageProfileCoordinator.ts`、`electron/storageProfile/storageProfileCoordinator.test.ts`、`electron/ipc/storageMaintenanceIpc.ts`、`electron/ipc/storageMaintenanceIpc.test.ts`、`electron/preload.ts`、`electron/storage/sessionStorageMaintenance.ts`（及清理入口实际文件）、`electron/appIpc.ts`、`src/shared/api.ts`、相关 IPC/maintenance 测试与 preload 类型文件。

**执行记录：** 维护 lease 在途 reader abort/drain 后才允许维护；竞争维护返回 busy；只有 owner token 可恢复 admission；失败维护 dirty-fence generation。新 overview/audit channel 与 preload/shared API 一次性接入，移除旧 `storage:get-profile` handler（兼容 preload alias 转到 audit）；worker/维护错误只给稳定错误码。命令 `npx vitest run electron/ipc/storageMaintenanceIpc.test.ts electron/storageProfile/storageProfileCoordinator.test.ts electron/storageProfile/storageProfileWorkerClient.test.ts electron/storage/sessionStorageMaintenance.test.ts electron/database/sessionStorageProfile.test.ts electron/database/sessionStorageProfile.overview.test.ts electron/database/sessionStorageProfile.spillReferenceIndex.test.ts electron/database/sessionStorageCleanupEstimate.test.ts` 通过：8 files / 55 tests；`npm run build:electron`、`npm run typecheck:renderer`、`npm run typecheck:shared`、`git diff --check` 通过。

**工作与验收：**

- 在切换生产 IPC 前，先通过临时 DB 测试证明 worker client、coordinator 和屏障联通；真实 IPC 的 overview/audit 只能经 coordinator，禁止存在绕过屏障的同步 handler。
- 每个数据库维护操作获取带 owner token 的互斥 lease；压缩、clear-cache 等多个维护请求按 DB 串行执行或明确返回 busy。只有持有 lease 的请求可释放屏障，不能由任一 finally 恢复其他维护的准入。
- 维护开始先暂停新 overview/audit 准入，再取消/等待已运行任务；确认线程退出及读锁释放后才能进入同步 `wal_checkpoint(TRUNCATE)`。维护期间不得启动新 reader。
- 维护成功推进代际并使后续强制刷新读取维护后的快照；维护失败释放 lease/准入，若可能部分写入则标 dirty 并禁止返回旧缓存。
- 集成测试：worker 持读快照、主 DB 有 WAL 写入、压缩请求等待 drain 后成功 checkpoint；drain 超时/worker 强杀后锁释放；两个维护请求交错时第二个等待或 busy，不能提前恢复 reader admission。
- IPC/preload 同一任务接入 `storage:get-overview`、显式 `storage:run-audit` 及维护状态/错误映射；worker 错误不得 fallback 到主线程。旧 `storage:get-profile` 明确迁移到 audit 或移除。
- IPC 错误只暴露稳定错误码，不暴露路径、正文或敏感堆栈。

## 任务 8：应用关闭与存储资源生命周期

状态：**[x]**

**依赖：** 任务 7。

**目标文件：** `electron/main.ts`、`electron/appIpc.ts`、`electron/storageProfile/storageProfileCoordinator.ts`、`electron/storageProfile/storageProfileCoordinator.test.ts`、IPC/worker lifecycle 集成测试。

**执行记录：** `registerAppIpcHandlers` 返回生产 coordinator，main 将其 shutdown 与既有 session-storage host shutdown 共同纳入 12 秒 deadline；关闭时 coordinator 停止准入、拒绝 queued、abort worker 并等 Promise（worker client 在实际 exit 后 settle），并等待已持有 maintenance lease 的操作。只有两个 lifecycle 都 quiescent 时 main 才 flush/close DB；deadline exceeded 时跳过 DB close并继续退出。命令 `npx vitest run electron/storageProfile/storageProfileCoordinator.test.ts electron/ipc/storageMaintenanceIpc.test.ts electron/storageProfile/storageProfileWorkerClient.test.ts` 通过：3 files / 18 tests；`npm run build:electron`、`npm run typecheck:renderer`、`npm run typecheck:shared`、`git diff --check` 通过。

**工作与验收：**

- 将 coordinator 接入现有应用退出清理顺序：先停止新任务准入，再在 shutdown 截止时间内排空或终止 workers，确认读连接/锁释放后才关闭主数据库。
- 超过 shutdown deadline 时使用强制 worker terminate 并等待实际退出；不得无限等待，也不得在窗口销毁后继续启动任务。
- 测试 shutdown 时有 overview、audit、排队任务和维护等待的组合：新请求被拒绝、Promise 全部 settle、queued work 被拒绝/取消、worker 总量回到 0、主 DB 正常关闭或按现有 deadline 结果结束。
- 测试 shutdown 与维护交错；关闭流程不能误解除维护 lease，也不能启动新 overview/audit。

## 任务 9：设置页、审计 UI 与本地化

状态：**[x]**

**依赖：** 任务 7。

**目标文件：** `src/renderer/components/Config/StorageSettingsTab.tsx`、`src/renderer/components/Config/StorageSettingsTab.test.tsx`、`src/shared/api.ts`、`electron/preload.ts`、`electron/ipc/storageMaintenanceIpc.ts`、`electron/ipc/storageMaintenanceIpc.test.ts`、`src/renderer/i18n/resources/zh-CN/config.json`、`src/renderer/i18n/resources/en-US/config.json`、生成的 i18n 类型文件（通过脚本生成）。

**工作与验收：**

- 默认首次进入和刷新只请求 overview；unknown/incomplete 以本地化文案呈现，不显示为 0。显示采集时间、部分失败和错误状态。
- 手动刷新绕过完成缓存；清理/压缩成功后仅触发一次维护后强制刷新。失败后保留错误且可重试。
- 请求序号/mounted guard 防止旧 Promise 覆盖新结果或在卸载后更新组件；该 UI guard 不替代主进程 generation fencing。
- 提供显式完整性检查入口，独立展示 audit pending/complete/failed；audit 失败不清除概览；离开页面时按 coordinator 合同取消/保留任务。
- 新增/更新中英文等已有 locale 资源，通过 `npm run i18n:generate-types` 生成类型；组件测试及 `npm run i18n:check` 通过，无硬编码用户文案。

**执行记录：** 设置页默认加载轻量 overview；刷新与维护后强制刷新、显式 audit、unknown/incomplete 本地化、请求序号与卸载 guard 均由组件测试覆盖。命令 `npx vitest run src/renderer/components/Config/StorageSettingsTab.test.tsx electron/ipc/storageMaintenanceIpc.test.ts` 通过：9 tests；`npm run typecheck:renderer`、`npm run typecheck:shared`、`npm run i18n:check` 与 `npm run i18n:generate-types` 通过。

## 任务 10：构建产物真实 Worker Smoke 与优化后性能回归

**依赖：** 任务 8、任务 9。

状态：**[x]**

**目标文件：** worker 构建配置、Electron 打包配置、`scripts/storage-profile-worker-smoke.mjs`、`electron/storageProfile/storageProfileWorkerClient.test.ts`、fixture 基准脚本及 `docs/plan/evidence/`。

**工作与验收：**

- 从开发构建、`dist-electron` 和安装包展开目录实际启动 Electron worker；worker 打开合成 SQLite、执行 overview、返回 DTO 并正常退出。仅检查文件存在不算通过。
- 构建路径无法加载 worker 时明确失败，不触发主线程 fallback；后续请求仍可工作。
- 使用任务 1 同版本 fixture、探针、重复数、统计口径和阈值，运行最终 worker handler 基准，记录相同字段并与优化前对比。
- 验收 overview 不执行 audit JSON/hash 路径；主进程 event-loop/轻量 IPC 延迟满足任务 1 固定目标；报告不同 fixture 尺寸趋势。
- 运行相关聚焦 Vitest、`npm run typecheck:shared`、`npm run typecheck:renderer`、Electron 构建、`npm run i18n:check`、`npm test` 与 `npm run build`。无关既有失败按执行约定记录归因。
- 追踪矩阵逐项链接到测试名、构建结果或基准证据；不得以人工检查替代 worker smoke。

**执行记录：** Electron 44.1.1 直接启动 `dist-electron` worker 与 overview IPC smoke 成功：总 IPC 95.838ms（含 worker 启动/退出），主事件循环 delay 2.088ms，低于固定 50ms。`npm run probe:sqlite` 通过。`npx electron-builder --dir --mac --arm64` 和 `npx electron-builder --mac dmg --arm64` 均成功；DMG 只读挂载、`app.asar` 展开后，用介质内 Electron/Node runtime 从展开目录启动 worker 并通过合成 DB 查询，随后卸载 DMG。本机构建 ad-hoc 签名通过；环境无 Developer ID 证书，未验证发布签名。优化后性能证据 `storage-profile-after.json` 与基线用同版 fixture、2 次预热、7 次测量：small/medium/large 主事件循环 p95 为 1.550/1.601/1.619ms；大样本基线为 766.753ms。优化后 handler p95 为 86.624/147.669/862.650ms（包含 Worker 启动与退出）；响应门槛达成。最终 `npm run build`、shared/renderer 类型检查及 i18n 检查通过；存储相关聚焦套件 10 files / 57 tests 通过。`npm test` 汇总 970 passed、19 failed、1 skipped（977 files）；失败限于 `policyEngine.test.ts`、`appIpc.securityRules.test.ts`、`claudeStreamHandlers.hostedIntegration.test.ts`、deferred approval/capacity/intent 测试。失败的首要断言为：policy tiers 预期数量大于 0、实际 0（`policyEngine.test.ts:544`）；security exposure lanes 预期 desktop/feishu/wechat、实际空列表（`appIpc.securityRules.test.ts:211`，单文件复跑 12 passed/1 failed）；hosted integration 中 config drift 原因预期 `BROWSER_PREPARED_POLICY_CHANGED`、实际 `CONFIRMATION_DENIED`，另 9 项超出 15s timeout；deferred outcome 预期 `deferred`、实际 `rejected`；两个旧 schema migration 预期 80、实际 82。失败断言没有覆盖新 storage overview/audit 行为；storage 聚焦套件全通过。

## 任务 11：真实安装只读样本工具与可选本机采样

**依赖：** 任务 10。

状态：**[x]**

**目标文件：** 新增 `scripts/storage-profile-local-readonly.ts`、`electron/storageProfile/localReadonlySample.ts` 及测试、`package.json` 命令、`docs/plan/evidence/storage-profile-local-readonly.json`。

**工作与验收：**

- 实现 `npm run storage-profile:local-readonly -- --dry-run` 与真实只读模式；DB 定位仅用 Electron userData/既有规则，不扫描猜测，不输出完整 profile。
- 自动测试注入临时 userData 覆盖唯一 DB、missing、ambiguous、corrupt、symlink、permission denied；验证 skip/fail-closed、allowlist 脱敏和无写入。注入独立写连接并在采样期间提交，结果标为 `concurrent-change/inconclusive`，不归因采样器，也不宣称无写入已由真实样本证明。
- `package.json` 命令与脚本运行由合成临时库测试验证。只读确定性由临时 fixture 的 SQLite 只读模式、允许操作审计和持久数据一致性断言保证。
- 对当前安装先执行 dry-run。若唯一、安全可读则运行采样并保存脱敏摘要；若缺失/不兼容则保存 `skipped` 证据。若检测到活动并发写入，仅记录 inconclusive 并保留该结果，不阻断后续完成判定，也不尝试停止应用或重新采样直到静止。
- 汇总真实样本与合成大 fixture 的覆盖差异；本机性能结果仅作支持证据，不修改固定门槛。

**执行记录：** 5 个临时 SQLite 测试覆盖 missing/ambiguous、正常 dry-run、symlink、corrupt、permission denied、脱敏 allowlist、持久内容不变和独立 writer 并发提交。`npm run storage-profile:local-readonly -- --dry-run` 确认当前唯一目标只读可打开；随后真实 overview 样本文件元数据发生变化，摘要标为 `concurrent-change/inconclusive`，已保存脱敏字段到 `evidence/storage-profile-local-readonly.json`，不用于写入归因。采样器测试通过：1 file / 6 tests。实际样本为 90,112 bytes、messages 0、spill 分类 unknown/incomplete；相对合成大 fixture（20,000 rows、2,000 spill files），本机安装样本不覆盖大数据量和可信 spill index 完成场景。

## 最终追踪矩阵

| 任务 | 验证证据 |
| --- | --- |
| 1 | `electron/database/storageProfilePerfBaseline.test.ts`；`evidence/storage-profile-before.json` |
| 2 | `src/shared/storageTypes.test.ts`、`typeTests/storageTypes.typecheck.ts`；`npm run typecheck:shared` |
| 3 | `electron/database/sessionStorageProfile.overview.test.ts`、`sessionStorageProfile.spillReferenceIndex.test.ts` |
| 4 | `electron/database/sessionStorageProfile.test.ts`、`sessionStorageCleanupEstimate.test.ts`、`scripts/session-storage-profile.test.ts` |
| 5 | `electron/storageProfile/storageProfileWorkerClient.test.ts`：真实大库 audit 超时、checkpoint、后续读取 |
| 6–8 | `electron/storageProfile/storageProfileCoordinator.test.ts`、`electron/ipc/storageMaintenanceIpc.test.ts`；Electron build |
| 9 | `src/renderer/components/Config/StorageSettingsTab.test.tsx`；renderer/shared typecheck、i18n check |
| 10 | `scripts/storage-profile-worker-smoke.mjs`（开发/IPC 与展开包）；`evidence/storage-profile-after.json`；`npm run build` |
| 11 | `electron/storageProfile/localReadonlySample.test.ts`；`evidence/storage-profile-local-readonly.json` |

## 阻断评审修复记录（2026-10-10）

评审报告：`docs/review/2026-10-10-storage-settings-profile-latency-blocking-review.md`。

- P1 RED：新增 coordinator 同步 runner throw 回归，确认失败后 active/task 计数遗留为 1。GREEN：`start()` 将同步 throw 转为 rejected Promise，统一走 task settle 与 `finally` 清理；随后强制重试成功，维护可完成，shutdown 返回 `quiescent`。
- P2 RED：普通文件替代 `spill-degraded` 根目录、以及模拟 `EACCES` 时，audit 原先都返回 `complete`。GREEN：audit status 汇总 strict reference 与 degraded scan 完整性及 error codes；两种错误都返回 `partial`。设置页 partial Alert 展示稳定错误码。
- 聚焦验证：`npx vitest run electron/storageProfile/storageProfileWorkerClient.test.ts electron/storageProfile/storageProfileCoordinator.test.ts electron/ipc/storageMaintenanceIpc.test.ts electron/database/sessionStorageProfile.test.ts electron/database/sessionStorageProfile.overview.test.ts electron/database/sessionStorageProfile.spillReferenceIndex.test.ts src/renderer/components/Config/StorageSettingsTab.test.tsx`：7 files / 51 tests 通过；`npm run typecheck:shared`、`npm run typecheck:renderer`、`npm run i18n:check`、`npm run build`、`git diff --check` 均通过。此次 follow-up 未重跑全量 `npm test`。

## 任务依赖关系

```text
1 → 2 → 3 → 4 → 5 → 6 ─┐
                         ├→ 7 → 8 ─┐
                         └────→ 9 ─┴→ 10 → 11
```

- 优化前性能和正确性基线先于任何 collector/执行模型改变。
- collector 及其严格审计兼容先完成，worker 才有真实可调用目标。
- worker client、取消/超时与 coordinator 完成后，生产 IPC 才和维护屏障一起切换，期间不存在绕过协调器的生产入口。
- 应用关闭依赖真实 IPC/coordinator；UI 与关闭集成共享稳定 IPC 合同，两者都先于最终构建/打包 smoke。
- 本机真实样本工具最后接入，避免其路径发现实现成为核心重构的前置条件。

## 最终完成定义

- 11 项任务均 `[x]`，各自有命令、测试/构建/基准证据；真实样本任务允许有依据的 `skipped` 或 `concurrent-change/inconclusive`，不把它们误判为实现失败。
- 真实同步 collector 在 worker 超时取消时能在界定时间内完成或被终止；只有实际线程退出、SQLite 锁释放后维护才能继续。
- worker 总并发有界；应用关闭停止准入并在 shutdown 截止时间清理 worker；维护请求彼此互斥且持有者 fencing 正确。
- Overview 不解析正文，也不对不可信索引执行 strict fallback；未知分类不归零或误报 orphan。
- 维护代际隔离旧任务和缓存；维护后的强制刷新取得新快照。
- 严格 audit 和原 CLI/cleanup estimate 语义保留；UI 默认走 overview、audit 显式触发、未知状态本地化。
- 同一合成 fixture 优化前后性能证据可比较，打包产物 worker 已实际启动并完成查询。
