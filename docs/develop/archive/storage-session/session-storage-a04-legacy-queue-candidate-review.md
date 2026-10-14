# A-04 legacy-required 队列与 M3-5 audit/candidate 审阅

- 审阅输入：[`A-00 冻结清单`](./session-storage-a00-review-input-freeze.md)
- 范围：legacy queue 生成/报告、consistency audit、M4-1 retirement candidate builder 及其测试。
- 方法：只读静态审阅；未运行测试、未改产品代码。已有 M3 定向测试证据见技术方案 v385。

## 判据与证据映射

| 判据 | 实现位置 | 现有断言 | 结论 |
| --- | --- | --- | --- |
| legacy queue 仅含产品 cohort 项，包含原 census 与迁移中新发现项 | `sessionProjectionMigration.ts:118-167`；`sessionProjectionConsistencyAudit.ts:346-369` | `sessionProjectionLegacyQueue.test.ts:17-67,69-125` 覆盖 internal 项排除/篡改拒绝及迁移中新转 legacy 项 | 通过；报告分别给出原 census 子集和 discovered 项。 |
| 队列 disposition 有明确原因、owner/read behavior，缺字段拒绝 | `sessionProjectionMigration.ts:58-72,145-167` | `sessionProjectionLegacyQueue.test.ts:17-64` 断言 retain-legacy 决议、双语行为及字段缺失/对账行为 | 通过。 |
| census 数量与队列/已 baseline 迁移子集对账 | `sessionProjectionMigration.ts:133-167`；audit `:354-369,402-404` | `sessionProjectionLegacyQueue.test.ts:28-41,107-121`；`sessionProjectionConsistencyAudit.test.ts:115-139` | 通过；legacy 原 census 必须精确拆为 queued 与 baseline-migrated。 |
| 未分类、scope anomaly、History 不健康、session 新增/消失和缓存孤儿阻止完整审计 | `sessionProjectionConsistencyAudit.ts:310-390` | `sessionProjectionConsistencyAudit.test.ts:145-213` 覆盖 generation 漂移、新 session、孤儿 cache、损坏 internal History 和未知 scope | 通过，异常使报告 `complete=false`。 |
| M4-1 candidate 覆盖所有 live 支持项；未知 owner/差异阻止 review-ready | `sessionProjectionRetirementCandidates.ts:16-71` | `sessionProjectionRetirementCandidates.test.ts:30-101` 覆盖 migrated、approved legacy exception、unknown owner、unclassified/difference 和不完整 audit | 通过；计数不平或任何 blocked 项不放行 owner review。 |
| internal/hidden 不混入产品 candidate，IM/automation 保留 | audit scope 分类及候选生成 `sessionProjectionConsistencyAudit.ts:315-338`、candidate `:47-71` | `sessionProjectionConsistencyAudit.test.ts:215-245` 核对 user/remote/automation 与 internal 分离 | 正向覆盖通过；classifier 对计划外组合的风险归入 F-A01-01。 |

## Findings

本审阅切片未发现 A-04 范围内的新 finding。F-A01-01 与 F-A03-01 仍待 A-10 汇总闭环；本结论不改变 M3 当前未放行状态。

## 结论

A-04 审阅通过；这是 legacy queue、M3-5 audit 和 retirement candidate 逻辑的静态映射结论，不表示执行了本轮测试，也不代表 reader 删除或真实清理获批。
