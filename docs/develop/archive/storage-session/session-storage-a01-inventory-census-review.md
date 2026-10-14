# A-01 M3 inventory/census 源码审阅

- 审阅输入：[`A-00 冻结清单`](./session-storage-a00-review-input-freeze.md)
- 范围：`electron/runtime/sessionProjectionMigrationInventory.ts` 及对应测试；并核对 `sqliteAgentHistory.ts` 的全局 cursor 校验。
- 方法：只读静态审阅；本轮未运行测试、未修改产品代码。已有测试运行证据见技术设计 v385（M3 六文件 55/55）。

## 判据与证据映射

| 判据 | 实现位置 | 现有断言 | 结论 |
| --- | --- | --- | --- |
| 迁移 scope 严格限于计划 cohort | `sessionProjectionMigrationInventory.ts:51-55,104-115` | `sessionProjectionMigrationInventory.test.ts:133-183` 覆盖 user/primary、remote/primary、automation/section、internal/hidden | 发现 F-A01-01：实现接受三个 ownership 与 primary/section 的笛卡尔组合，超出计划列明的三种有效组合；无效组合可能被当作产品迁移项。 |
| 未知 scope fail closed | `sessionProjectionMigrationInventory.ts:104-115` | `sessionProjectionMigrationInventory.test.ts:264-275` 对未知 ownership 断言抛错 | 未发现其它缺口；无效的已知 ownership/visibility 组合由 F-A01-01 覆盖。 |
| internal History 归属与完整性 | `sessionProjectionMigrationInventory.ts:137-168`；History 顺序检查 `sqliteAgentHistory.ts:629-638` | `sessionProjectionMigrationInventory.test.ts:189-276` 覆盖损坏 transcript、事件/stream 归属不符和仅生命周期事件变化时摘要变化 | 通过：异常即抛错；摘要绑定 stream/event 内容。 |
| internal History 摘要和 cohort 计数 | `sessionProjectionMigrationInventory.ts:212-234` | `sessionProjectionMigrationInventory.test.ts:162-183,288-294` 检查内部会话数、含 History 数、健康数、排除数及产品计数 | 通过；异常内部 History 会让 census 失败，不返回伪健康结果。 |
| canonical/legacy 分类及损坏 fail closed | `sessionProjectionMigrationInventory.ts:177-205` | `sessionProjectionMigrationInventory.test.ts:46-128` 覆盖 history absent、legacy mismatch、canonical-only、canonical-backed skeleton mismatch | 通过； canonical-backed 损坏不降级为 legacy。 |
| census 只读，不产生资格/cache/cutover 副作用 | `sessionProjectionMigrationInventory.ts:88-97,240-246` | `sessionProjectionMigrationInventory.test.ts:66-91,278-297` 对状态前后比较、只读连接写入拒绝作断言 | 通过。 |
| census 快照稳定性 | `sessionProjectionMigrationInventory.ts:96-101,238-246` | 同文件的 read-only test 验证连接只读；数据库竞争/稳定快照拒绝另见 `sessionProjectionMigration.test.ts:120-140` | 通过：开始/结束 `data_version` 与本连接 `total_changes()` 不一致时拒绝返回。 |

## Finding

### F-A01-01 — [P1] scope classifier 放行计划外 ownership/visibility 组合

- 位置：`electron/runtime/sessionProjectionMigrationInventory.ts:53`。当前判断只分别验证 ownership 属于 `user/remote/automation`、visibility 属于 `primary/section`，实际接受 `user/section`、`remote/section`、`automation/primary` 等计划未批准组合。
- 依据：技术方案待办 `M3-1` 明列 `user/primary`、IM `remote/primary`、automation `section`；测试的正向 cohort 同样按这三类建模。对不认识/不匹配的组合，当前 census 应按 fail-closed 原则拒绝，而不是列入 durable projection migration。
- 风险：非法或意外变更的 session metadata 会进入迁移 census，并可能被 worker 持久处理。
- 建议修复：使用精确 pair 判定；对三种有效组合分别保留正向断言，并对其它 ownership/visibility 笛卡尔组合做负向红测。
- 责任任务：A-10 findings 闭环；在修复与复审前，M3 scope 验收未通过。该 finding 不授权或要求触碰真实 profile。

## 结论

A-01 审阅与行为→代码→测试映射已完成；M3 inventory/census **未通过放行**，F-A01-01 进入 A-10 闭环。此处完成的是审阅切片，不代表对应实现已验收。
