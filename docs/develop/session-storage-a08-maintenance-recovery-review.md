# A-08 M4-7/9 archive, VACUUM 与故障恢复审阅

- 审阅输入：[`A-00 冻结清单`](./session-storage-a00-review-input-freeze.md)
- 范围：maintenance archive、空间预算、WAL checkpoint、VACUUM/reclaim、取消/异常/硬中断恢复及测试。
- 方法：只读静态审阅；未运行测试、未执行任何 profile 维护或清理。相关隔离故障矩阵既有运行证据见技术方案 v387。

## 判据与证据映射

| 判据 | 实现位置 | 现有断言 | 结论 |
| --- | --- | --- | --- |
| 活动 session execution/turn 阻止维护 | `sessionStorageMaintenance.ts:56-79` | `sessionStorageMaintenance.test.ts:103-121` 覆盖执行 claim 与无 claim 的执行中 turn | 发现 F-A08-02：漏查 claim/queue 的 `queued` 状态。 |
| checkpoint、空间预算、取消与归档后再校验空间 | `sessionStorageMaintenance.ts:81-116` | `sessionStorageMaintenance.test.ts:151-205` 覆盖零空间、archive 后空间下降及取消 | 通过静态映射。 |
| DB/spill 归档后才执行 VACUUM，异常保留归档 | `sessionStorageMaintenance.ts:117-177` | `sessionStorageMaintenance.test.ts:35-76,124-147,207-224` 覆盖 archive 目录、payload 和 spill、失败 manifest 与重试 | 发现 F-A08-01：实现仅用 DB 文件字节数及 spill 汇总字节数确认 archiveVerified，未校验 DB 内容/hash/integrity 或 spill 内容。 |
| 硬中断后 DB 与 archive 可重开、integrity/FK 正常并可重试 | `sessionStorageMaintenance.ts:134-178` | `sessionStorageMaintenance.test.ts:228-269` 对 VACUUM 中 SIGKILL 后的当前 DB/归档 DB 均检查 integrity，检查 FK 并重试 | 覆盖硬中断后的 SQLite 恢复，但并未补足执行 VACUUM 前归档验真不足（F-A08-01）。 |
| canonical、API context、source-truth spill 经 cache clear/VACUUM 保真 | `sessionStorageMaintenance.ts:46-53,117-160` | `sessionStorageMaintenance.test.ts:271-309` 重开后对拍 canonical、API context、spill、integrity/FK | 通过。 |

## Findings

### F-A08-01 — [P1] VACUUM 前的 recovery archive 只按长度验收

- 位置：DB 只比较 `stat.size`（`sessionStorageMaintenance.ts:124-125`）；spill 只比较递归文件字节数（`:126-128`）；随后 `archiveVerified` 据此置真并允许进入 VACUUM（`:129-133`）。
- 风险：同尺寸内容损坏、截取后补齐或 spill 内容错误都可能通过当前判定；此后源 DB 文件才会被 VACUUM 改写。归档就可能被标成 verified 但不能可靠恢复。硬中断测试是在归档成功后才杀进程，并在事后检查 SQLite integrity；它没有验证代码在启动 VACUUM 前会拒绝坏归档。
- 建议修复：对 DB archive 执行独立 reopen、`integrity_check`/`foreign_key_check` 和可信的内容/摘要校验；spill archive 按源文件 manifest/hash/length 逐项校验；验真失败时不运行 VACUUM。为同尺寸归档损坏添加红测。
- 责任任务：A-10 闭环；复审前 archive 不能作为经验证的恢复副本。

### F-A08-02 — [P2] maintenance busy guard 漏查持久队列的 queued 状态

- 位置：`activeSessionTurnCount` 只计 execution claims/queue 的 `claimed/executing/transcript_committed/commit_uncertain`（`sessionStorageMaintenance.ts:58-62`），但 schema 明确允许两表状态 `queued`（`schema.ts:247-270,649-672`）。
- 风险：已有排队 intent 而没有 queued message/active turn 时，忙碌检查仍可能允许 compact；这违反计划要求的 queued-work fence，可能让长时间同步 VACUUM 与等待执行的 session 工作冲突。
- 建议修复：将 claims/queue 的 `queued` 纳入 busy 判定，并增加仅有 queue/claim queued、无其它活动表征时拒绝维护的红测。
- 责任任务：A-10 闭环。

## 结论

A-08 审阅切片完成，M4-7/9 维护安全**未通过放行**；F-A08-01 为 P1，F-A08-02 为 P2。硬中断/低空间/取消恢复已有隔离覆盖，但不能替代归档预验真缺口的修复复审。
