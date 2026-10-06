# A-07 M4-6 cleanup worker/release gate 审阅

- 审阅输入：[`A-00 冻结清单`](./session-storage-a00-review-input-freeze.md)
- 范围：packaged release metadata、C/R compatibility gate、唯一 production boundary、周期维护 worker 及破坏性调用静态门禁。
- 方法：只读静态审阅；未运行测试、未启用清理、未改产品代码。此前 M4-6…M4-9 测试与 cleanup boundary 验证见技术方案 v387。

## 判据与证据映射

| 判据 | 实现位置 | 现有断言 | 结论 |
| --- | --- | --- | --- |
| 默认关闭，missing/dirty/mismatch 配置 fail closed | `sessionStorageCleanupReleaseConfig.ts:35-84`；gate `sessionStorageCleanupReleaseGate.ts:81-137` | `sessionStorageCleanupReleaseConfig.test.ts` 覆盖缺失/错误 metadata；`sessionStorageCleanupReleaseGate.test.ts:43-131` 覆盖默认关闭、记录缺失/digest/build/schema/格式/目标产物/接受状态 | 通过静态映射。 |
| compatibility record 精确绑定 C commit/schema/History/spill，rollback floor 支持 canonical-only、三种清理态及平台/架构产物 | `sessionStorageCleanupReleaseGate.ts:96-137` | `sessionStorageCleanupReleaseGate.test.ts:61-131` 覆盖候选不匹配、rollback 不兼容、schema floor、artifact 缺失；摘要键序稳定和畸形记录拒绝 | 通过；此为代码内配置 gate，不替代 §8.8.5 的实际发布安装包审计。 |
| 每个破坏性阶段通过唯一 gate boundary 且重读资源配置 | `sessionStorageCleanupProduction.ts:39-75`；`check-session-storage-cleanup-boundary.mjs` 只允许 guarded primitives 留在 cutover/production boundary | `sessionStorageCleanupProduction.test.ts:27-35` 对 certify/write-stop/begin/batch/verify-complete 逐阶段断言 gate 关闭不访问 DB；静态检查曾通过（v387） | 通过静态映射。 |
| 逐 session canonical 读取认证、write-stop→pending→batch→verify/reopen 与有界 worker | `sessionMessageContentCleanupMaintenance.ts:45-140`；核心协议 `sessionStorageCutover.ts:156-460` | `sessionMessageContentCleanupMaintenance.test.ts:79-176` 覆盖 gate closed、逐批清理、reopen 续跑、终验、历史失效后重新认证；其它 M4 清理用例见 v387 | 技术认证与持久协议有覆盖。 |
| 仅处理 owner 明确授权的 session 集合、期限和 profile identity | worker 当前枚举所有 canonical cutover retained/write-stopped/pending rows：`sessionMessageContentCleanupMaintenance.ts:66-72`；boundary 接受 caller 的任意 `sessionId`：`sessionStorageCleanupProduction.ts:64-75` | 当前测试覆盖 DB gate 和 canonical eligibility，但无授权 scope、到期/撤销、精确 session 集合与 profile identity 断言 | 未完成，关联已列计划项 SC-SCOPE/SC-SCOPE-PKG。 |

## Finding

### F-A07-01 — [P1] C-on 当前无逐 profile/session owner 授权范围

- 位置：维护 worker 直接从 profile 枚举全部 cleanup state 候选（`sessionMessageContentCleanupMaintenance.ts:66-72`）；production boundary 的参数只有 `db/sessionId/step`，每一步只验证 release-level compatibility gate（`sessionStorageCleanupProduction.ts:39-75`）。
- 风险：一旦 packaged `allowContentCleanup` 和 Accepted compatibility record 都有效，自动 worker 可处理该 profile 所有符合技术条件的 session；代码没有要求 owner 批准的精确 session 集合、scope 认证快照、有效期/撤销或稳定 profile identity。release compatibility review 不能替代数据 owner 的具体清理授权。
- 修复边界：按计划实现 SC-SCOPE/SC-SCOPE-PKG；worker 仅枚举被授权集合，每个 certify/write-stop/begin/batch/verify 都重验授权与 profile/session/hash。当前必须保持生产清理关闭。
- 状态：这是计划内、明确未实现的阻断项，不是本轮启用清理的授权；真实 C-on 部署/清理仍禁止。

## 结论

A-07 审阅切片完成。release compatibility gate 与受控调用边界有 fail-closed 覆盖；逐数据集授权 scope 未实现，F-A07-01 阻断 C-on 真实部署/执行，SC-SCOPE 系列仍待开发。
