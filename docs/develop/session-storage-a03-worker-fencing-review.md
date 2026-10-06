# A-03 M3 worker/cohort fencing 源码审阅

- 审阅输入：[`A-00 冻结清单`](./session-storage-a00-review-input-freeze.md)
- 范围：`sessionProjectionMigration.ts` worker claim/process、baseline 写入围栏及对应 worker tests。
- 方法：只读静态审阅；未运行测试、未改产品代码。此前 M3 定向测试运行证据见技术方案 v385。

## 判据与证据映射

| 判据 | 实现位置 | 现有断言 | 结论 |
| --- | --- | --- | --- |
| 领取前 scope 重验 | `sessionProjectionMigration.ts:351-373` | `sessionProjectionMigration.test.ts:139-160` 在 worker 调用前将产品会话改为 internal/hidden，断言不读、不写 eligibility/cache 且 run 转 attention | 发现 F-A03-01：领取事务结束后至 `processItem` 之间未再验证 scope，且 eligible 项的 History/cache/eligibility 路径没有原子 scope fence。另，classifier 接受计划外组合的问题已在 F-A01-01 登记。 |
| 活跃 turn/claim/queue 延后 | `sessionProjectionMigration.ts:244-249,268-277` | `sessionProjectionMigration.test.ts` 的 active-work 场景断言 deferred/retry 行为 | 通过静态映射；会话 execution claim、活动队列、非终态 turn 与 queued/streaming 消息均纳入检查。 |
| 失败可重试，部分提交可续跑 | `sessionProjectionMigration.ts:268-332,354-378` | `sessionProjectionMigration.test.ts:86-113` 在 baseline 提交后注入认证失败，再次批次成功且不重复追加；366-382 覆盖 reopen 后 pause/resume | 通过。 |
| 固定 run 不吸纳 census 后新项 | inventory item 只在创建 run 时插入：`sessionProjectionMigration.ts:209-229`；worker 仅查既有 run item：354-358 | `sessionProjectionMigration.test.ts:162-194` 在建 run 后新建 internal History/空 session，断言 reader 不触碰、不产生 projection；`sessionProjectionMigration.test.ts:124-135` 覆盖 census 后并发删/增导致 run 创建失败 | 通过。 |
| remote/automation cohorts 保持可迁移 | `sessionProjectionMigrationInventory.ts:51-55` 和 worker 处理路径 | `sessionProjectionMigration.test.ts:196-220` 覆盖 remote IM 与 automation 消息，并断言原 metadata 不变、eligibility 正确 | 正向行为覆盖；scope 精确组合缺口见 F-A01-01。 |

## Finding

### F-A03-01 — [P1] claim 后的 scope 变化存在 TOCTOU 窗口

- 位置：claim 中 scope 校验和 item 标记 `processing` 位于 `sessionProjectionMigration.ts:359-370`；提交后才在 `:377` 调用 `processItem`；后者只验证 session generation 和活动工作 `:270-277`，不再验证 scope。
- 风险：另一连接可在 claim 事务提交后、处理前将 session 改为 internal/hidden 或 unknown。此后 worker 仍可能调用 `readSessionTranscriptProjection`，并写入 projection cache/eligibility。现有测试只覆盖调用 worker 前已经变更 scope（`sessionProjectionMigration.test.ts:139-160`），未覆盖 claim 与处理之间的竞争窗口。History-absent baseline 路径有独立 scope fence，但已有 canonical transcript 的常规认证路径没有该 fence。
- 建议修复：把 scope/ownership/visibility 绑定到 claim 凭据，并在会读写 History/cache/eligibility 的同一 DB 事务/条件更新中再次校验；若 scope 已漂移，确保不读写并将 run 置为 attention。增加可确定复现 claim 后 scope 变化的红测。
- 责任任务：A-10 findings 闭环；复审前 M3 worker scope-fencing 未通过。

## 结论

A-03 审阅切片及映射完成，M3 worker/cohort fencing **未通过放行**；F-A03-01 与 A-01 finding 一并留给 A-10 修复、复审。
