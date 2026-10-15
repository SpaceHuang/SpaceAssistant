# storage-session baseline 核验记录（2026-10-14）

> 基线：`17236274`｜执行：Agent｜窗口：`git log 17236274..HEAD -- electron/sessionStorage electron/storage electron/database` = **0 条**
> 被核验对象：[`会话与数据-现状.md`](./会话与数据-现状.md)（2026-10-14 新写）

| 断言 | 出处 | 命令 | 实测 | 判定 |
| --- | --- | --- | --- | --- |
| A1 存储内核分层齐备（contracts → coordinator → execution → lifecycle → queries → maintenance → recovery） | 现状 §1 | `ls electron/sessionStorage` | 命中 12+ 文件，含 `contracts.ts` `coordinator.ts` `execution.ts` `lifecycle.ts` `queries.ts` `maintenance.ts` `recovery.ts` | 一致 |
| A2 上下文端口与续跑来源存在 | 现状 §1 | `ls electron/sessionStorage/context*.ts electron/sessionStorage/continuationSources.ts` | 命中（`contextAdapter.ts`、`contextPortRegistry.ts`、`continuationSources.ts`） | 一致 |
| A3 事件流是生产权威适配器（`request_*` + `compaction_*`） | 现状 §2 | `rg -n 'request_header\|request_context\|request_usage\|compaction_' electron/sessionEvents.ts` | 命中（13 处 `compaction_*`） | 一致 |
| A4 空间回收协议存在且被多引用 | 现状 §3 | `rg -l 'spillProtocol' -- '*.ts'` | 命中 10 个文件 | 一致 |
| A5 维护调度/水位/保留策略三件套 | 现状 §3 | `ls electron/storage/*aintenance*.ts electron/storage/*ention*.ts` | 命中 | 一致 |
| A6 已接受 turn 与 agent 历史落库 | 现状 §4 | `rg -l 'acceptedTurnStorage' -- '*.ts'` | 命中 14 个文件 | 一致 |
| A7 事务一律走统一封装 | 现状 §4 | `rg -l 'runInTransaction' -- '*.ts'` | 命中 **63** 个文件（约定被广泛遵守） | 一致 |
| A8 远程 Track 归因/观测/诊断/运维指标 4 件 | 现状 §4 | `ls electron/database/remoteTrack*.ts` | 命中 | 一致 |

## 矛盾与时间线检查

- **双入口检查**：`session-storage-refactor-technical-design.md`（技术方案）与 `session-storage-public-interface-design.md`（接口设计）职责不同（实现方案 vs 对外接口），**不构成双入口**；本主题无第二份"现状"描述。
- **history 抽样**（3 条，均可命中）：`1f6e7940`（消息事实落库归 Core）、`c69b5873`（内容切换与清理）、`413674a1`（公共端口迁移）。

## 无法核验项

- 存储重构的**真机迁移行为**（真实用户库升级、回滚）需真机与真实数据，标 `待真机核验`；本批只核验"代码事实"。

## 抽样复核建议（用户抽 3 条）

A3、A6、A7。

## 完备性复算（`ls` 全量，2026-10-14）

> 与上表同属一份记录的两个维度：上表核验「断言的点是否存在」，本节核验「现状文档是否**列全**」。

| 维度 | 上表断言 | 全量实测 | 补充判定 |
| --- | --- | --- | --- |
| A8 远程 Track 件簇 | 「4 件」 | `ls electron/database/remoteTrack*.ts` = **6 件**（`remoteTrackStore`、`AttributionMetrics`、`AttributionObservationStore`、`DiagnosticStore`、`RuntimeDiagnosticStore`、`OperationalMetrics`） | **计数偏差**；现状文档已更正为 6 件 |
| §3 空间回收 | 只提 `spillProtocol` | **实际 9 件**：`spillStore`、`spillReferenceIndex`(+`Safety`)、`spillReferenceBackfill`(+`Scheduler`)、`spillReferenceCollectorWorker`、`spillReferenceWorker`(+`Ack`)、`spillReferenceReconciliation` | **漂移（不完备）** → 现状文档已补齐 |
| §4 数据库层 | 列了 7 类 | 另漏 `sessionTranscript`、`taskControl`、`wakeEvents`、`workflowState`、`schema`、`scopeVersion`、`sessionStorageProfile`、`sqliteStore` | **漂移（缺项）** → 现状文档已补齐 |
| §1 存储内核 | 12+ 文件 | 17 件（含 `routingQueries`、`sqliteSessionStorage`、`recoveryHelpers`） | 一致（仅计数表述） |
