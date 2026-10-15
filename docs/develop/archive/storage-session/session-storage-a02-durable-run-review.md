# A-02 durable run / inventory hash / resume / reconciliation 审阅

- 审阅输入：[`A-00 冻结清单`](./session-storage-a00-review-input-freeze.md)
- 范围：`electron/runtime/sessionProjectionMigration.ts` 的 durable run 创建、inventory 身份、恢复和 census 对账；对应 SQLite schema 与测试。
- 方法：只读静态审阅；本轮未运行测试、未修改产品代码。已有阶段测试证据见技术设计 v385（M3 六文件 55/55）。

## 判据与证据映射

| 判据 | 实现位置 | 现有断言 | 结论 |
| --- | --- | --- | --- |
| Inventory 内容固定为可复现 identity | `sessionProjectionMigration.ts:169-177,188-194`；run 表存 hash 与 data_version：`schema.ts:1556-1572` | `sessionProjectionMigration.test.ts:251-297` 检查内部 History 摘要持久化、reopen 后读取及同 runId 的 hash 冲突拒绝；第 230-249 行检查同 identity 重复创建幂等 | 通过。Hash 纳入 session entries（ID、generation、disposition/reason）、产品/内部计数及完整 internal History digest。 |
| Census 过期时不创建 run | `sessionProjectionMigration.ts:196-208` | `sessionProjectionMigration.test.ts:115-140` 覆盖同连接写入以及另一连接先删后增后的拒绝 | 通过；`data_version`、`total_changes` 和数据库总数均受校验。 |
| Run 与 item 在同一事务建立，计数一致 | `sessionProjectionMigration.ts:189-229`；表/唯一活动 run 约束 `schema.ts:1556-1588` | `sessionProjectionMigration.test.ts:230-249,265-287` 检查批次 item 数、内外 scope 计数和 run 汇总字段 | 通过；唯一索引限制并发 active run。 |
| Resume 使用持久 run/item 状态 | `sessionProjectionMigration.ts:232-242,391-429` | `sessionProjectionMigration.test.ts:366-382` 关闭并重开 SQLite 后 pause/resume/执行完成；第 86-113 行覆盖部分提交后失败重试 | 通过。 |
| 旧 inventory census 对账 | `sessionProjectionMigration.ts:118-167` | `sessionProjectionLegacyQueue.test.ts` 与 `sessionProjectionConsistencyAudit.test.ts` 覆盖 census/queue 子集、baseline 已迁移项及 discovered 项对账 | 通过；异常 scope 和缺失策略元数据会拒绝报告。 |
| DB 会话数、迁移 cohort 与排除项总量对账 | `sessionProjectionMigration.ts:201-215` | `sessionProjectionMigration.test.ts:265-287` 与 `sessionProjectionMigrationInventory.test.ts:18-42` 核对产品、internal、deleted 分类数量 | 通过；并发新增/删除需重新建 inventory。 |

## Findings

本审阅切片未发现 A-02 范围内的新 finding。A-01 的 F-A01-01（scope classifier 过宽）仍待 A-10 汇总闭环；该 finding 不属于本切片的 run 持久化缺陷，但在修复复审前，M3 整体仍不放行。

## 结论

A-02 审阅通过；这里只表示 durable run/inventory hash/resume/reconciliation 的代码与测试映射通过静态审阅，不表示运行测试，也不代表 M3 全局放行。
