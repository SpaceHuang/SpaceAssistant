# agent-sdk baseline 核验记录（2026-10-30）

> 基线：`0d189776`｜执行：Agent｜窗口：`git log 17236274..0d189776 -- packages/agent-sdk/src` 共 37 条提交（9 文件 / +543 −85）
> 上一轮记录：[baseline-check-2026-10-14.md](./baseline-check-2026-10-14.md)（基线 `17236274`）。按 `docs-guide` §6.5，核验记录按日期累积、不覆盖。

## 断言核验

| 断言 | 文档出处 | 命令 | 实测 | 判定 | 处置 |
| --- | --- | --- | --- | --- | --- |
| A1 基线以来 SDK 源码有变更窗口 | `README.md` 基准行 | `git log --oneline 17236274..0d189776 -- packages/agent-sdk/src` | 37 条提交；`git diff 17236274..0d189776 --stat` 计 9 文件 / +543 −85 | **漂移**（文档停在 `17236274`） | README 基准行推进到 `0d189776`，补第三批摘要 |
| A2 复检阶段带 `replanAfterFreshApproval` / `policyChanged` / `requestMetadata` | `turn-loop.md` 工具阶段 4、5 | `rg -n 'replanAfterFreshApproval|policyChanged' packages/agent-sdk/src/turn.ts` | 命中 10+ 处（`ToolPreparationStage` 定义与两处 `prepareTool` 调用） | **漂移**（旧文档 recheck 仅带 `confirmation`） | 已改写 turn-loop.md 工具阶段 |
| A3 确认结果新增 `authorization-changed` 并触发重问循环 | `turn-loop.md` 工具阶段 4 | `rg -n "kind: 'authorization-changed'" packages/agent-sdk/src/turn.ts` | 命中（`ToolConfirmationResult` 联合 + `while (result.kind === 'authorization-changed')` 循环） | **漂移** | 已改写 |
| A4 `safetyGate.authorize` 返回 `ask` 时在派发租约内补确认 | `turn-loop.md` 工具阶段 5 | `rg -n 'dispatchAuthorization' packages/agent-sdk/src/turn.ts` | `dispatchAuthorization: while(true)` 循环存在，至多 8 轮（超限 `AUTHORIZATION_STALE`） | **漂移** | 已改写 |
| A5 `AUTHORIZATION_STALE` 在派发租约内可恢复（清策略栅栏后重检） | `turn-loop.md` 工具阶段 6；`safety-approval.md` §2/§5 | `rg -n 'clearAuthorizationInvalidation' packages/agent-sdk/src/safetyPermit.ts packages/agent-sdk/src/executionAdmission.ts packages/agent-sdk/src/toolExecutionPort.ts` | 三个文件均命中；`toolExecutionPort.ts` 在版本一致后清除 `AUTHORIZATION_STALE` 栅栏 | **漂移** | 已改写 turn-loop.md、safety-approval.md |
| A6 `matchesRecheckBinding` 放宽：新批准后允许 plan/facts 摘要更新，`authorizationVersion` 不参与比对 | `turn-loop.md` 工具阶段 5 | `rg -n 'allowFreshPlanRevision' packages/agent-sdk/src/turn.ts` | 命中；比对仅含 requestId/turnId/invocationId/toolCallId/capabilityId/inputSnapshotHash | **漂移**（旧文档要求全字段一致含 authorizationVersion） | 已改写 |
| A7 provider 恢复支持 `maxAttempts`（钳制 2–5）与 `retryAfterMs`（封顶 30s） | `turn-loop.md` 循环阶段 4、5 | `rg -n 'providerAttemptBudget|maxAttempts|retryAfterMs' packages/agent-sdk/src/turn.ts` | `providerAttemptBudget = Math.max(2, Math.min(5, …))`；`waitForRetry` 封顶 `Math.min(30_000, …)` | **漂移**（旧文档"至多再尝试一次"） | 已改写；宿主侧 `electron/runtime/agentSdkProviderRecovery.ts` 按 `Retry-After` 重试 429/5xx/网络错误（`db888ade`） |
| A8 事件流新增 `unknown-effect-*` 四类 kind 及流转校验 | `history-port.md` 事件清单与转换校验 | `rg -n 'unknown-effect-risk-accepted|unknown-effect-retry-approved|unknown-effect-retry-consumed|unknown-effect-resolved' packages/agent-sdk/src/history.ts` | 22 项闭合联合全部命中；校验含一票一消费、消费后必须紧跟同 `toolName`+`inputHash` 的 `tool-call-started` | **漂移**（旧文档 18 项） | 已改写 history-port.md |
| A9 turn 循环新增 `beforeDispatchLease` 派发租约门 | `turn-loop.md` 端口一节 | `rg -n 'beforeDispatchLease' packages/agent-sdk/src/turn.ts` | 命中（端口定义 + `RunAgentTurnInput` + `onDispatchClaimed` 内调用；`retryApprovalEventId` 触发 `unknown-effect-retry-consumed` 前置追加） | **漂移** | 已改写 |
| A10 `SessionTranscriptCommitIntent` 新增 `executionLease` 与 `messageMirror.thinking` | `history-port.md` DTO | `rg -n 'executionLease|thinking\?' packages/agent-sdk/src/history.ts` | 均命中；`SessionExecutionLease` 类型已定义；SDK 不产生 `executionLease`（宿主 `hostedTurnHandoff.ts` 填充） | **漂移** | 已改写；`f7398787`（thinking）、`hostedTurnHandoff`（lease）记入 history.md |
| A11 超时 turn 按 `interrupted` / `invocation-interrupted` 结算 | `turn-loop.md` 失败结算表；`README.md` 终态速查 | `rg -n 'AgentTurnTimedOutError' packages/agent-sdk/src/turn.ts` | 终态 status/kind 判定均含 `AgentTurnTimedOutError` → interrupted；payload `reason: 'timeout'` 保留 | **漂移**（旧文档 `failed` / `invocation-failed`） | 已改写（`e9658821`） |
| A12 新增模块 `runShellJustification.ts` 且不经包入口导出 | `README.md` 导出面；`turn-loop.md` 循环阶段 7 | `rg -n 'normalizeRunShellJustification' packages/agent-sdk/src/` 与 `rg -n 'runShellJustification' packages/agent-sdk/src/index.ts` | 前者命中（`runShellJustification.ts` + `turn.ts` 引用），后者 0 命中（确认不经入口导出） | **漂移**（模块地图缺失） | 已补 README 与 turn-loop.md |
| A13 `AgentHostPorts` 新增 `resolveExposureRules` / `resolveExposureAuthorizationVersion` | `host-ports.md` 准入字段 | `rg -n 'resolveExposureRules|resolveExposureAuthorizationVersion' packages/agent-sdk/src/invocation.ts` | 均命中（可选方法，宿主实现留在适配器） | **漂移** | 已改写 host-ports.md |
| A14 `ToolExecutionRejectReason` 新增 `VERIFY_ONLY_*` / `RECOVERY_*` 三值，turn 物化为工具结果 | `safety-approval.md` §5；`turn-loop.md` markNotDispatched 覆盖 | `rg -n 'VERIFY_ONLY_UNREVIEWED_CAPABILITY|RECOVERY_CHECKER_UNAVAILABLE|RECOVERY_HISTORY_UNAVAILABLE' packages/agent-sdk/src/` | `toolExecutionPort.ts` 与 `turn.ts` 均命中；`turn.ts` 对这些前缀回 is_error 工具结果而非抛 `ToolDeniedError` | **漂移** | 已改写 |
| A15 `MAX_MODEL_TURNS_PER_INVOCATION = 1000` 与每 20 轮循环检查 | `turn-loop.md` 取消与额度 | `rg -n 'MAX_MODEL_TURNS_PER_INVOCATION|MODEL_TURN_LOOP_CHECK_INTERVAL' packages/agent-sdk/src/turn.ts electron/runtime/invocationAssembler.ts` | 常量与循环检查消息均命中；assembler 以其兜底 `maxModelTurns` | **漂移** | 已改写（`1358bd29`） |
| A16 `switch_work_dir` 同批派发屏障与用户批准信任回执 | `turn-loop.md` 工具阶段与聚合收尾 | `rg -n 'WORKDIR_SWITCH_BARRIER|Trusted approval record' packages/agent-sdk/src/turn.ts` | 均命中（屏障并发 1、其余调用 `WORKDIR_SWITCH_BARRIER`；用户批准的工具结果后插 system 信任消息） | **漂移** | 已改写 |
| A17 `context.ts` / `scheduler.ts` / `model.ts` / `provider.ts` 基本无行为变更 | `context.md`、`lifecycle-capacity-scheduler.md`、`model-provider.md` 免更新依据 | `git diff 17236274..0d189776 -- packages/agent-sdk/src/context.ts packages/agent-sdk/src/scheduler.ts packages/agent-sdk/src/model.ts packages/agent-sdk/src/provider.ts` | context 仅去一处类型 import；scheduler 仅删一个未用变量（`void` 化）；model/provider 零差异 | 一致 | 无需改写 |
| A18 turn-budget-pause 方案仍未实施 | `in-flight/turn-budget-pause-plan.md` 状态行 | `rg -n 'paused|phasePaused' packages/agent-sdk/src/turn.ts` | 0 命中 | 一致（自述「未实施」成立） | 无需改写 |
| A19 provider-retry-backoff 方案自述「未实施 / 代码未改动」 | `in-flight/provider-retry-backoff-plan.md` 状态行 | `git show --stat db888ade -- packages/agent-sdk/src/turn.ts electron/runtime/agentSdkProviderRecovery.ts` | `db888ade`（2026-10-16）改 turn.ts 90 行 + 恢复桥 28 行：`maxAttempts: 3` + `Retry-After` 等待 | **漂移**（自述滞后） | 状态更正为「实施中（部分）」；README in-flight 段与 history.md 存疑节同步 |
| A20 compaction 质量方案阶段记录与代码相符 | `in-flight/context-compaction-summary-quality-plan.md` | `git log --oneline -1 e15f3c5c` | 提交存在且已记入 history.md（2026-10-29 更正过） | 一致 | 无需改写 |

## 矛盾与时间线检查

- `1358bd29`（2026-10-13「extend model turn budget and loop checks」）与既有条目 `4ce5dc9f`（同日「放宽模型 turn 预算与循环检查」）描述相近但为不同提交：前者是 `MAX_MODEL_TURNS_PER_INVOCATION` 导出与循环检查消息本体（`git show 1358bd29 -- packages/agent-sdk/src/turn.ts` 可证），已在 history.md 单列。
- 复检族提交时间跨度 2026-10-14（`0525a1e4`）至 2026-10-24（`a984bfa6`），`dec8954d`（10-15）为集中化起点，`68950785`（10-23）为贯穿工具执行的起点——history.md 按两行记录，不合并为一条。

## 无法核验项（需真机或外部系统）

- `retryAfterMs` 的真实等待行为依赖 provider 返回 `Retry-After` 头，本地仅有单测断言（`packages/agent-sdk/test/turn.test.ts`），未做真机限流复测。
- `AUTHORIZATION_STALE` 恢复路径在派发租约内重检的实际触发，需要策略热变更与在途工具并发的真机组合场景。

## 抽样复核建议（用户抽查）

1. `rg -n 'replanAfterFreshApproval' packages/agent-sdk/src/turn.ts` —— 对照 turn-loop.md 工具阶段 4、5。
2. `rg -c 'unknown-effect' packages/agent-sdk/src/history.ts` —— 对照 history-port.md 事件清单（22 项）。
3. `git log --oneline -1 e9658821` —— 对照 history.md 2026-10-15 行。
