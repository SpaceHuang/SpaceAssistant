# 执行通道 final-check 闭合矩阵（P4-08）

| 通道 | 审批/permit 绑定 | 执行前检查 | 负例 / 正例证据 | 执行器策略裁决边界 | 状态 |
|---|---|---|---|---|---|
| read / list / grep | input digest、fact target、path zone/kind、identity、scope、grant、decision ID 与 dependency fingerprint | prepared permit binding → permit digest/target → 当前 realpath/identity → read | `readReadIntegration.test.ts`、`readFileRange.test.ts`、`permitBoundCoordinatorDispatch.test.ts` | 只拒绝对象漂移、撤权/机制变化；不重新做 risk verdict | 已验证 |
| write / edit | canonical input digest、target/parent identity、rule/approval、subject digest、decision ID/dependency fingerprint | prepared permit snapshot → current permit match → subject/input digest → current target identity 与原子写 | `writeExecutionPermit.test.ts`、`builtinExecutors.fileState.test.ts`、`runShellRegisteredTool.test.ts` | 只验证已批准对象与写入原子机制；policy verdict 由 gate 决定 | 已验证 |
| shell | prepared command/cwd/platform/effect facts、capability 与 recheck authorization version | safety gate recheck → prepared plan/capability validation → process dispatch | `runShellRegisteredTool.test.ts`、`permitBoundCoordinatorDispatch.test.ts` | precheck/facts 与 rule decision 在 gate；执行器只核对 prepared command、权限和进程状态 | 源码/模拟验证 |
| browser | action、URL/tab/session/config snapshot、调用身份 | recheck policy → prepared browser plan/config comparison → browser port | `runShellRegisteredTool.test.ts`、`browserExecutor` boundary tests、WeChat/Feishu remote tests | adapter 对变化的授权配置/对象拒绝，不独立评估页面风险 | 源码/模拟验证 |
| MCP | server/tool/schema/args/capability snapshot、调用身份 | safety gate → registered planned tool/capability check → MCP dispatch | `registeredAgentTurnTools.test.ts`、`mcpToolExecutor.test.ts`、remote loop tests | registry/capability 与参数完整性检查，不重算产品风险 | 源码/模拟验证 |
| Feishu / WeChat outbound | channel、owner/recipient、session、destination、payload/attachment facts | tool invocation 经 policy gate；host system reply 经 `decideSystemImOutbound`；随后 `assertImOutboundAllowed` 只比较 channel/body/session/recipient/destination → platform dispatch | `imOutboundPolicy.test.ts`、`outboundClassification.test.ts`、`wechatOutboundRegisteredTools.test.ts`、Feishu/WeChat outbound integration tests、`policyEngine.test.ts` | user tool 的内容证据由 facts→policy rule；host system reply 决策有 `im-system-reply-ordinary` / `im-system-reply-review-required`；final-check 不调用内容 classifier | 模拟验证；真实 IM 外部待验 |
| remote/deferred dispatch | durable invocation/identity/authorization epoch、rule/facts hash、dispatch idempotency claim | approval/fresh policy → epoch/identity/rule binding → atomic dispatch claim → platform call | `imAsyncApproval.integration.test.ts`、`deferredTodoStore.test.ts`、`deferredDispatchCoordinator.test.ts` | claim 与身份/epoch 仅保证生命周期/原子性，不改写 policy decision | 源码/模拟验证；真实 IM 外部待验 |

所有失败继续经 `policy.execution-veto`（`failureClass`/`caseId`；若存在则 decisionId，否则 priorDecision=unavailable）或 SDK 稳定拒绝码表达，不记为 policy deny。read/write 生产 adapter 的测试明确失败时 executor 计数为 0。

策略/目标/审批配置在确认等待期间变化时，第一次 receipt 会失效并触发新的真人确认；只有第二次确认后才允许执行。回归同时验证审批期间目标被替换时拒绝执行。

源码关闭结论：所有列出的执行域都有执行前对象/机制复核及负/正例证据；各执行阻断不重写 policy verdict。read/write permit 具备 decision/fingerprint 关联和 veto audit；SDK/remote lifecycle 使用调用 identity、authorization version 与原子 dispatch claim。Hosted 整合依赖当前环境不可用的 provider 路由，详见 Phase 4 测试记录；真实 IM/MCP 平台仍为外部待验。
