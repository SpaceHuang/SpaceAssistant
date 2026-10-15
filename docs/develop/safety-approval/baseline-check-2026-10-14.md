# safety-approval baseline 核验记录（2026-10-14）

> 基线：`17236274`｜执行：Agent｜窗口：`git log 17236274..HEAD -- electron/confirmation electron/capabilities electron/writeSafety src/shared/policy src/shared/confirmation` = **0 条**（开工点即基线，窗口内无变更）
> 被核验对象：[`确认与审批-现状.md`](./确认与审批-现状.md)（2026-10-14 新写）｜流程见 [`../_consolidation/docs-consolidation-rules.md`](../_consolidation/docs-consolidation-rules.md) §3.0

| 断言 | 出处 | 命令 | 实测 | 判定 |
| --- | --- | --- | --- | --- |
| A1 决策入口是纯函数 `decide` / `decideIngress` | 现状 §1 | `rg -n 'export function (decide\|decideIngress)' src/shared/policy/policyEngine.ts` | 命中（`decide` 另被 4 个文件引用） | 一致 |
| A2 存在策略地板，用户规则不得放宽到默认之下 | 现状 §1 | `rg -n 'validatePolicyRulesFloor\|intersectPolicyRulesWithFloor' src/shared/policy/policyFloor.ts` | 命中 | 一致 |
| A3 「谁回答询问」由 lane 决定 | 现状 §1 | `rg -n 'askAnswererFor' src/shared/policy/policyEngine.ts src/shared/policy/defaultRules.ts` | 命中 2 处 | 一致 |
| A4 自动授权维度上限为 `low` | 现状 §3 | `rg -n 'APPROVAL_MAX_AUTHORIZATION' electron/confirmation/approvalAgent.ts` | 命中 | 一致 |
| A5 仅 3 类原因回落人工 | 现状 §3 | `rg -n 'FALLBACK_ELIGIBLE_CAUSES' electron/confirmation/fallbackToUser.ts` | 命中（`unavailable\|timeout\|agent-undetermined`） | 一致 |
| A6 安全审计默认保留 180 天 | 现状 §6 | `rg -n 'getSecurityAuditRetentionDays' electron/confirmation/audit.ts` | 命中（`fallback = 180`） | 一致 |
| A7 目录句柄读绑定身份（防替换） | 现状 §5 | `rg -n 'readDirectoryBoundToIdentity' electron/confirmation/directoryHandleReader.ts` | 命中（3 文件） | 一致 |
| A8 调用级准入独立成件 | 现状 §2 | `ls electron/runtime/callAdmissionGate.ts` | 存在 | 一致 |
| A9 策略执行否决单独审计 | 现状 §6 | `rg -n 'recordPolicyExecutionVeto' electron/confirmation/audit.ts` | 命中 | 一致 |
| A10 11 个事实提取器 | 现状 §2 | `ls electron/confirmation/extractors` | 命中（含 write/read/script path facts、shell effect、MCP payload、browser domain、command sequence、path classifier 等） | 一致 |

## 矛盾与时间线检查

- **双入口检查**：现状文档在 develop 侧；顶层设计（`tool-confirmation-top-level-design-v2.md`）与口径（`security-policy-single-entry-requirement.md`）在 requirement 侧 —— 职责不同（现状 vs 设计与口径），**不构成双入口**。
- **history 抽样**（3 条，均可 `git log -1 <hash>` 命中）：`c96acc2e`（ask 档位统一合入）、`594cc94c`（桌面 fail-open 恢复）、`b9b68d74`（skill v2.1 合入）。

## 无法核验项

- 审批 Agent 的**实际判定质量**（误批/误拒率）需真实模型调用与真机链路，标 `待真机核验`。
- IM 侧审批归属的端到端行为需真实飞书/微信环境，标 `待真机核验`。

## 抽样复核建议（用户抽 3 条）

A1、A4、A6 —— 命令可直接复制执行。
