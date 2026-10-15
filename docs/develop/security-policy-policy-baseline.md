# 安全策略规则基线与验收矩阵（Phase 0）

本表将开发计划 §6 的已确认行为映射到基线源码，不重新解释其产品取值。证据基线为 `8c0d2a89`。每个候选最终规则需落入同一策略契约，lane/tool/destination 为 match 条件。

## 已确认验收矩阵

| 动作 | loose | standard | strict | facts 输入 | 策略阶段目标 | 预期审计链 | 执行检查 |
|---|---|---|---|---|---|---|
| outbound 普通内容 | allow（无 answerer） | require-confirm / Agent | require-confirm / user | channel、recipient、session、purpose、内容 assessment、attachment presence/completeness | `outbound.mode.{tier}` 稳定 ruleId；B-01 | `policy.decision` →（需要时）`confirm.request`/`confirm.outcome` → dispatch record | receipt 与 channel/body/session/recipient/destination/attachment exact binding；任何变化不 dispatch |
| outside-workdir write | require-confirm / Agent | require-confirm / Agent | require-confirm / user | path zone、target kind、probe completeness、identity | 独立于 inside-write 的 `write.outside.{tier}`；B-02 | `policy.decision`（outside ruleId/answerer）→ `confirm.*` →（若 veto）`policy.execution-veto` | 保留 permit、symlink/hardlink、对象 identity 与 atomic write 机制复核 |
| sensitive outbound evidence | require-confirm / Agent | require-confirm / user | require-confirm / user | `sensitive` evidence kind，不保存正文 | 高于普通 outbound 的规则；在当前策略约束语义下明确表达命中关系，B-03 | `policy.decision` sensitive ruleId → `confirm.*`；执行 mismatch 用 `policy.execution-veto` | 检查 approval subject 相同；不在 dispatch executor 重做内容风险分类 |
| facts incomplete/unavailable | 按当前版本配置读取并固定 | 按当前版本配置读取并固定 | 按当前版本配置读取并固定 | 独立 completeness/error class，不能把 unknown 改标为 sensitive | `facts.incomplete.{tier}`；B-04；迁移时保持逐 lane/tool 当前有效值 | `policy.decision`（factsCompleteness/fallbackCause/ruleId/answerer）→ `confirm.*` | 事实新鲜度和相关 decision dependency 复核；不因缺失字段本身伪称敏感 |
| approval mismatch / revoked / subject changed | action 与 tier 无关：拒绝本次执行 | 同左 | 同左 | decision/receipt/permit、request/toolUse、subject digest、当前 identity、授权 generation | 不生成新的 risk verdict；B-07/08 | 保留原 `policy.decision`/`confirm.outcome`；追加 `policy.execution-veto`（failureClass/caseId/invariantId） | typed final-check failure，executor/dispatch 调用数为 0，并关联原 decision |

“高于”敏感内容规则仅描述 B-03 指定的敏感内容与一般 outbound 匹配顺序；不推导通用数值优先级，也不覆盖 policy engine 的 deny/humanRequired/floor/cache/auto-evaluator 等独立语义。

## 当前实现映射与差异

Phase 2 实施状态（源码）：桌面 `send_email`/`send_message`/微信发送和飞书 CLI 出站按显式 stable rule ID 选择档位；IM 旧标准行为和现有 locked remote deny 保持优先。facts 投影只携带检查覆盖度和 evidenceKinds，策略规则基于证据 token 选择 sensitive/incomplete verdict。Decision audit 已携带 `decisionId` 和包括 lane、tier、规则顺序/条件/动作、启停、配置与 migration state 的依赖指纹。策略映射和规则分层回归见 `policyEngine.test.ts`、`toolCallGate.test.ts`、`policyDecisionBoundary.test.ts`。

| 基线项 | 当前源码 | 当前语义/顺序 | 缺口（本次计划范围） |
|---|---|---|---|
| outbound | `agentSdkConfirmationPort.ts` 的 `actionClass === 'outbound'` agent-approved 后拒绝；`policyEngine.ts` 对没有更早 rule match 的 read/outbound 默认 allow；`defaultRules.ts` 另有 exposure `im-no-wechat-send` 和受 `remoteDenyOutbound` 控制的 invocation deny | 规则决策、工具暴露控制、channel approval adapter 分散，按调用路径作用；port veto 在审批结果后 | 逐 lane/tool 移入显式档位规则，保留现有远程暴露/强制禁用能力的既有含义；移除 adapter 的产品 veto |
| outside write | `remote-outside-write-deny`、`remote-write-scope-unknown-deny`；desktop `writePathFact` 后 gate 对 auto-allow 转 `write-outside-confirm`；automation 进一步 deny | remote deny 在 policy engine deny 层；desktop gate 覆盖只命中 auto-allow；automation deny 是该覆盖分支 | loose/standard Agent、strict user 的独立规则；不影响 already matched deny/ask，也不能移除 permit 和 identity 核验 |
| sensitive outbound | `assessImOutboundContent` 产生标签；`classifyImOutbound` 把非 ordinary 归 active outbound；`assertImOutboundAllowed` 有多种 purpose/receipt 分支；尚无统一 tier rule 表 | facts、授权路径分类、dispatch final check 混在共享模块 | 标签仅进入 facts；explicit rule 确定审批人；final check 只比较批准对象 |
| incomplete facts | `toolCallGate` 记录 `extraction-failed` 等 signal；`policyEngine.applyDefault` 对 `extraction-failed` 合成 `default-extraction-failed`，固定 user answerer（仅落入该 fallback 时）；shell/script/path 另有工具/lane 特定 unknown 规则 | 现有单测：desktop 普通 `read_file`/`write_file` 走 fallback 时 user；IM `write_file` 的 `im-write-ask` 在 IM standard 版本可先匹配并变换为 Agent，strict/loose 按 IM scenario matrix 为 ask→user；敏感 path/script 由 locked human rule 抢先；automation 由 lane default/locked 规则先裁决。当前缺少完整 actionClass×lane×tier 特征矩阵 | P0-10 要求补全矩阵测试；实施只保留测得的逐格有效动作，不能将所有 unknown 归为敏感或新设统一 deny |
| policy rule precedence | `decide()` 顺序：dangerous signal；`deniedTools`；locked deny；普通 deny；humanRequired；IM MCP user ask；locked confirm-every-time；cache；declared capability；auto-evaluator 子域级串行求值；软约束；default rule 子域按数组首命中；`applyDefault` fallback | 多层分阶段语义；deny/human/confirm 与 default list 的优先关系不同 | P2 实施时对每层保持单测与 trace；禁止改造成全局首条命中或增加 priority number |
| final check | read/write permit、`recordPolicyExecutionVeto`、IM `assertImOutboundAllowed`、remote authorization epoch 等 | 部分已关联 `requestId/toolUseId/decisionRuleId/factId/failureClass` | 统一 decision/receipt/dependency/envelope/generation；failure 不覆盖 decision |

## 执行器验收清单

- 对缺失 receipt、错 requestId/toolUseId、不同 recipient/session/body/attachment identity、过期 facts、旧 policy dependency、撤权 epoch、目标 identity/symlink/hardlink 变化，分别断言稳定 failure class 且 executor/dispatch 调用数为 0。
- 对无关规则变化，审批继续有效；对新增前置 deny、相关规则重排/条件变化、tier 变化、策略启停和相关 facts 变化，重新计算并比较 verdict、answerer、subject 后才可复用。
- 对成功路径，实际 executor 收到的对象必须与批准 envelope 一致并只 dispatch 一次。
- mock 结果仅证明源码控制流；正式包、production DB/log、跨平台文件系统和真实 IM/MCP 的缺失均单列外部待验。

## 对应测试清单与现有证据

| 测试集 | 覆盖矩阵 / 当前证据 |
|---|---|
| `src/shared/policy/policyEngine.test.ts`、`imPolicyBehavior.test.ts`、`defaultRules.contract.test.ts` | deny/humanRequired/MCP ask/cache/auto-evaluator/default order、IM tier resolver、locked rule；需增加 facts incomplete 的 lane×tool×tier 表驱动用例 |
| `electron/confirmation/agentSdkConfirmationPort.test.ts`、`agentSdkSafetyPolicy.test.ts`、gate→port integration | outbound loose/standard/strict answerer 与“agent approved 后不发生 adapter 改判”；当前 C-01 回归缺口 |
| `electron/confirmation/toolCallGate.test.ts`、write permit tests | inside/outside × loose/standard/strict × desktop/IM/automation；outside policy 与 approved path identity veto 分别断言 |
| `src/shared/confirmation/outboundClassification.test.ts`、`electron/tools/wechatOutboundRegisteredTools.test.ts`、`weChatToolExecutor.test.ts`、Feishu outbound tests | ordinary/sensitive/unknown/bulk/permission-change × tier；facts producer 无 verdict，final check subject mismatch 时 dispatch=0 |
| `electron/confirmation/readReadIntegration.test.ts`、`readPermitExecutor.test.ts`、`writePermitExecutor.test.ts`、`executionVetoAudit.test.ts` | missing permit、digest、identity/symlink、revoked/generation mismatch；原 decision 关联，执行调用为 0 |
| `electron/remote/remoteToolPolicy.test.ts` 与 remote tool loop tests | remote switch/legacy overlay 与共享规则映射等价；迁移后不保留第二套 policy verdict |

P0-10 明确的待实现 TDD 列：facts incomplete matrix、approval adapter outbound 三档、outside write 三档、sensitive outbound 三档/规则交叠、policy dependency invalidation 的规则新增/重排/tier/启停/无关变更及并发 race。每组均先加失败断言，再实现对应垂直切片。
