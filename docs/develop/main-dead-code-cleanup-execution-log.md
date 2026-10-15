# main 死代码清理执行记录

## 工作区与基线

- 独立 worktree：`.worktrees/main-dead-code-cleanup`
- 分支：`codex/main-dead-code-cleanup`
- 实施基线：`ebdff6fa593fada24983d77e75700465368c7f55`（方案审计基线）
- 范围依据：[main 死代码盘点与安全清理方案](./main-dead-code-cleanup-audit-and-plan-2026-10-14.md)
- 产品行为 owner：仓库文档没有提供个人或团队映射；在各候选的行为合同核对完成前，不把任何候选列为已批准删除。
- 执行 owner：本清理工作流；仓库外消费者和功能退役窗口需要产品 owner 证据，当前未确认。

## 阶段 0：边界与依赖清单

### 可在当前环境验证

- 当前 worktree 与方案声明的 `main@ebdff6fa` 一致。
- 逐项检索了 28 个候选在产品源码、测试、脚本中的静态名称引用；相关测试引用不能替代生产接线证据。
- 复跑方案中的 `noUnusedLocals` / `noUnusedParameters` 扫描：Electron 237 条、Renderer 56 条；共享文件重复后需按文件/行/列去重，扫描器本身不能证明绑定及副作用可安全删除。
- 逐项基线已落在[未使用诊断清单](./main-dead-code-unused-diagnostic-baseline-2026-10-15.md)：去重后 277 条、97 个文件；其中 TS6133 为 234 条，TS6196 为 28 条，TS6192 为 15 条。核心大文件分开审查，`src/shared/api.ts` 等公开合同不按诊断机械删除。
- 后续每个批次可在本仓库用定向 Vitest、typecheck、边界检查和干净构建验证，并检查删除文件对应的 `dist-electron` 输出。

### 需外部环境或产品 owner 确认

- 从干净构建启动 Electron、验证平台相关 preload、Worker 和原生浮窗交互。
- 使用真实飞书/微信账号验证入站、异步审批与通知回执。
- 使用旧用户数据库/profile 验证迁移兼容。
- 仓库外包消费者、功能 owner 与兼容窗口。

### 候选批次初始处置

`保留`表示在行为合同有生产路径和仓库外消费者证据前不删除；`待映射`表示现有搜索结果或审计结论不足以判定退役。所有候选的删除门槛均未通过。

| 批次 | 候选 | 初始处置 | 删除前必须补齐的证据 |
|---|---|---|---|
| 旧 stream / 输入拼接 | `electron/anthropicStreamDelta.ts`、`electron/modelEventSource.ts`、`electron/toolUseInputMerge.ts` | 待映射；暂保留 | 当前 Hosted/pi-ai adapter 对原始事件解析和 tool-call 输入拼接的生产接线，以及应迁移的边界断言 |
| SDK permit dispatch | `electron/tools/agentSdkTurnDispatch.ts`、`permitBoundCoordinatorDispatch.ts`、`permitRevocationBridge.ts`、`preparedInvocationStore.ts` | 保留；内部相互依赖且含授权/撤权时序合同 | Hosted caller 的冻结输入、授权漂移、撤权、取消、claim 前后 executor 调用数与在途结果结算回归 |
| 确认 / 安全旧辅助 | `electron/confirmation/confirmCardPayload.ts`、`decisionCache.ts`、`deferredApprovalCachePolicy.ts`、`remoteAsyncApprovalAcceptanceMatrix.ts`、`securityActionIntentRecovery.ts`、`shellConfirmationAdapter.ts` | 待映射；暂保留 | `ToolConfirmRegistry`、SDK confirmation port、decision cache writer、持久化审批及 shell gate 的调用链与 payload/失败关闭断言 |
| Remote / IM | `electron/remote/deferredApprovalNotificationSender.ts`、`imWorkflowSkillHarness.ts`、`electron/wechat/weChatQuoteBinding.ts` | 待映射；暂保留 | 判定 harness 的测试夹具角色；飞书/微信真实 sender、消息字段、quote binding 与外部运行验证 |
| Renderer pending confirm | `src/renderer/hooks/useActionablePendingConfirms.ts`、`src/renderer/services/confirmationSnapshotGate.ts`、`pendingConfirmationService.ts` | 待映射；暂保留 | 当前 store、turn display、ToolCallCard 与 IPC 审批提交流程中 stale-turn fail-closed 的 smoke |
| Shared 纯逻辑 | `src/shared/llm/outputMaxTokens.ts`、`src/shared/outbound/chatOutboundClassifier.ts`、`src/shared/promptSerialization.ts`、`src/shared/spillSemantics.ts`、`src/shared/surfaceProjection.ts` | 待映射；逐项核对消费者 | 全仓/动态消费者证据；仍有效合同迁移到生产调用方并保留边界断言 |
| Session projection 诊断 | `electron/runtime/sessionProjectionConsistencyAudit.ts`、`sessionProjectionRetirementCandidates.ts` | 保留 | 清理 owner gate、迁移/清理脚本及 `check-session-storage-boundary.mjs` 的退休证据；现有扫描明确把 consistency audit 作为 privileged reader |
| 包装层 / attribution | `electron/browser/browserDependencyRecovery.ts`、`electron/database/remoteTrackAttributionMetrics.ts` | 待映射；暂保留 | Browser 包装层的外部消费者；remote-track schema 版本、指标 reader 和离线报表消费者的检查 |

### 已观察到的引用事实

- Browser recovery 的共享实现被 Renderer 产品代码直接调用；Electron 包装层目前检索到的引用在测试中，需单独判断包装层是否为外部合同。
- `imWorkflowSkillHarness` 有多个恢复/端到端测试消费者，按测试 harness 处理，不能只因无产品入口就删除。
- `sessionProjectionConsistencyAudit.ts` 被边界检查脚本显式列为 privileged reader。
- SDK permit dispatch 辅助文件间存在静态依赖；其安全测试必须映射到真实执行路径后，才可考虑退役。
- 上述事实仅作初始清单，尚未替代逐候选的测试断言和生产调用链审计。

## 阶段状态

| 阶段 | 状态 | 交付 / 验证 |
|---|---|---|
| 0. 边界与依赖清单 | 完成 | 本文件；本阶段批准删除数为 0，候选先保留/待映射；外部验收交付形态待用户选择 |
| 1. 未使用绑定分批清理 | 未开始 | 基线已精确映射至 97 个文件；按小批次、先保行为的调用方回归，再清理 |
| 2. SDK permit / browser recovery | 未开始 | 需先完成合同矩阵及定向测试 |
| 3. 其余候选 | 未开始 | 按行为域逐批映射和验收 |
| 4. 防回流检查与最终验收 | 未开始 | 强制 `npm run build` 干净构建；本地与外部运行结果分开记录 |

阶段 1 暂不开始：已向用户确认外部验收的交付形态，答复尚未收到。当前先保持产品源码不变。
