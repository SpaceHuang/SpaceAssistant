# 安全策略三阶段候选清单（Phase 0）

源码基线：`8c0d2a89f78816d4a7d1b1a1890ad59f608cee4f`。本清单记录可复查入口；触发范围以列出的调用链为准，tier 配置需要通过实际 `effectiveRules` / `policySnapshot` 求值。`ruleId` 尚未在 decision 中持久化的点标为缺口。外部 lane 的真实 dispatch 不在本静态清点证据范围。

分类：`facts` 事实生产；`policy` 授权策略；`final-check` 已批准对象/授权校验；`invariant` 不可配置系统约束候选；`mechanism` 失败保护；`functional` 普通输入或业务功能；`duplicate` 重复裁决链；`false-positive` 与授权无关。

| ID | 文件 / 函数与触发 | lane / tool / tier | 当前授权影响、调用者与归位 | 决策依据 / 目标规则 | 测试 / 审计证据 / 状态 |
|---|---|---|---|---|---|
| C-01 | `agentSdkConfirmationPort.ts`，channel outcome 为 agent approved 且 facts.actionClass=outbound | 触发该 adapter 的 lane；outbound | SDK port 只映射 channel outcome；answerer/verdict 由统一 policy 决定 | B-01；tier 映射到 outbound 规则 | **migrated**：`outbound-mode-loose-allow` / `outbound-mode-standard-review` / `outbound-mode-strict-human`；`agentSdkConfirmationPort.test.ts`、`policyEngine.test.ts` |
| C-02 | `toolCallGate.ts`，path fact zone 非 `workdir-normal` 且 `decide()` 返回 auto-allow | 写/编辑工具；desktop/remote/automation | path scope 是 facts；outside 写策略在共享规则中选择 answerer | B-02；宽松/标准 Agent，严格真人 | **migrated**：`write-outside-{loose,standard,strict}-review` 与远程 scope deny；`toolCallGate.test.ts`、`policyEngine.test.ts`、write permit tests |
| C-03 | `toolCallGate.ts`，automation lane 工作目录外写入、原 decision auto-allow | automation 写工具 | 自动化限制由 policy rule 表达，不由 gate 后置 if 改判 | B-02/B-05 | **migrated**：`automation-write-deny`；`automationLane.test.ts`、`toolCallGate.test.ts` |
| C-04 | `outboundClassification.ts:assessImOutboundContent` | IM outbound body；全 tier | host classifier 只生产内容标签/摘要；coverage/evidence 进入 facts，policy 按 tier 决策 | B-03/04 | **migrated**：`outbound-content` fact → outbound policy rules；`imOutboundFacts.test.ts`、`imOutboundPolicy.test.ts`、`policyEngine.test.ts` |
| C-05 | `outboundClassification.ts:classifyImOutbound` | wechat/feishu reply/send | recipient/session/owner/chatType 与内容观察作 facts；产品 verdict 由 policy 作出 | 受控回复与主动发送由 gate 或 system reply policy 决定 | **removed**：legacy `classifyImOutbound` 已删除；系统回复使用 `decideSystemImOutbound`，注册工具 facts 经 gate；分类矩阵改由 policy rules 与 `imOutboundPolicy` 覆盖 |
| C-06 | `outboundClassification.ts:assertImOutboundAllowed` | wechat/feishu dispatch | final-check 仅比较批准对象字段；不判内容、purpose 或确认要求 | B-07；subject digest/receipt 由 gate/permit 绑定 | **migrated**：exact channel/body/session/recipient/destination comparison；`outboundClassification.test.ts`、Feishu/WeChat outbound tests；真实平台外部待验 |
| C-07 | 原 `policyEngine.ts:hasDangerousSignal` | `run_script` invocation | 危险脚本信号作为规则条件，而非隐藏的全局拒绝 | 可追踪、可按策略配置的 deny | **migrated**：`script-dangerous-deny`；已移除硬编码分支；`policyEngine.test.ts` 验证规则移除后转入普通策略 |
| C-08 | `policyEngine.ts:decide`，deniedTools / locked / ordinary deny | invocation lane/tool/tier | deny precedence 先于 cache；ruleId 解释规则来源，config deniedTools 独立记录 | B-09；保留真实优先层次 | **preserved in policy**：`policyEngine.ts` deny stages；`policyEngine.test.ts` deny-before-cache 与 policy floor tests |
| C-09 | `policyEngine.ts:decide` 多层 precedence | desktop/IM/MCP/automation | humanRequired、显式 MCP ask、confirm-every-time、cache、auto evaluator、默认规则维持分层 | B-05/B-09；不以数值 priority 替代先后语义 | **preserved in policy**：`policyEngine.test.ts`、`policyDecisionBoundary.test.ts`；C-18 的无来源能力直通已移除 |
| C-10 | `toolCallGate.ts` 缺 policy/cache/precheck/snapshot 材料 | 所有调用；IM 要求支持的 snapshot | 缺料终止执行并记录材料失败，不伪造风险 facts/普通 rule | mechanism failure 与 policy verdict 分开 | **preserved as mechanism**：`gate-materials-missing` / `im-policy-snapshot-missing`；`toolCallGate.test.ts`、`policyRulesRuntime.test.ts` |
| C-11 | `validatePolicyRulesFloor` 发现 locked floor 被放宽 | effective rule set | 配置违反策略契约时拒绝并携带 violations，不另造产品风险判断 | P0-05/06；源规则与 floor provenance 可追踪 | **preserved as policy configuration contract**：`rules-violated`；`policyFloor.test.ts`、`policyIpc.test.ts`、audit mapping |
| C-12 | `toolCallGate.ts` shell precheck / read target validators | run_shell / read tools | validator 失败有稳定 ID；通过结果只供策略规则/评估器消费 | facts 与语法/机制失败分离 | **preserved as validator/mechanism**：`shell-precheck-deny`、`read-v1-target-unsupported` 等；`toolCallGate.test.ts`、`policyDecisionBoundary.test.ts` |
| C-13 | approval-agent internal confirmation recursion | approval-agent lane | 递归确认属于不可配置系统不变量，保留稳定 cause，不充当产品策略 rule | 不允许审批器递归审批自身 | **preserved as invariant**：`SYS-RECURSION-001` / `recursion-guard`；gate audit 记录 `invariantId`；`recursionGuard.test.ts`、registry gate |
| C-14 | read/write permit 与 executor identity/revocation check | file read/write/list/grep | permit/freshness/identity 归 final-check/invariant，不重写原 risk decision | B-07；执行副作用前失败 | **preserved as invariant/final-check**：`SYS-PERMIT-001`，decisionId/fingerprint 与 veto audit；read integration / permit tests |
| C-15 | `remoteToolPolicy.ts` legacy overlay 与 skip helpers | remote IM script/browser/file/lark | snapshot 仅提供 versioned policy config；共享 engine 决定，不保留第二条最终裁决 | B-05；lane 差异留在 rule conditions | **migrated**：`security-policy-remote-rule-mapping.md`；生产 gate 只投影有效配置；未调用的 script/navigate/lark skip helpers 已删除；保留实际使用的 browser act 配置投影 |
| C-16 | SDK safety gate 与 revocation components | SDK capability tool | 未授权 capability 与执行中撤销分别保持 admission 与 lifecycle 检查 | 不作为普通产品风险规则 | **preserved as invariant**：`SYS-CAPABILITY-001` / `SYS-REVOCATION-001`；SDK safety/runtime component tests |
| C-17 | IM/MCP/browser/shell executor dispatch checks | 外部执行工具 | 输入合法性、策略批准与批准对象 final-check 分层 | B-07；任一对象漂移不执行 | **migrated in source/mock scope**：closure matrix 和对应 adapter tests；正式 IM/MCP 真实服务为外部待验 |
| C-18 | `policyEngine.ts:decide` declared capability autoAllow | invocation context capability | 无可信生产者/来源证明的 capability 声明不得成为授权 verdict | 不扩大授权面 | **removed**：`ExecutionContext.declaredCapabilities` 与 `declared-capability` autoAllow 已删除；`policyEngine.test.ts` 有无可信来源反例 |
| C-19 | recheck 阶段的新 require-confirm | approval recheck path | 未被原 approval 覆盖的新决策不能沿用旧授权；作为确认生命周期不变量记录 | stale approval 与新确认需求分开 | **preserved as invariant**：`SYS-APPROVAL-001` / `recheck-requires-confirm`；gate audit 记录 `invariantId`；`agentSdkSafetyPolicy.test.ts`、gate tests |

## 搜索范围与排除依据

- 扫描目录：`electron/confirmation/`、`electron/remote/`、`electron/tools/`、`electron/shell/`、`electron/feishu/`、`electron/wechat/`、`src/shared/policy/`、`src/shared/confirmation/`、`packages/agent-sdk/src/`。
- 搜索线索：`actionClass`、`answerer`、`approved`、`deny`、`require-confirm`、`humanRequired`、`outsideWorkDirRisk`、`contentAssessment`、`permit`、`digest`、`revok`、`capability`、`dispatch`。
- 本轮排除：只影响展示或错误消息的分支、无工具授权/dispatch 影响的记忆 eligibility；若后续命中调用链影响授权，重新纳入。关键词命中不是分类依据，表内依据具体函数与调用顺序。
- 复查命令示例：`rg -n "actionClass|humanRequired|answerer|approved\\s*=\\s*false|verdict|require-confirm|outsideWorkDirRisk|contentAssessment|permit|revok|capability" electron src/shared packages/agent-sdk/src`。

## Facts producer 输入/输出与失败行为

| Producer | 输入 → 输出 | unknown/error 行为与消费者 | 副作用/混合边界 |
|---|---|---|---|
| `assessImOutboundContent` / `createHostImOutboundFacts` | IM body → `ordinary/sensitive/bulk-local-export/permission-change/unknown`、classifierVersion、contentCompleteness | 空或超过 20,000 字符返回 `unknown`；消费点为 Policy Engine facts/rules 与各 outbound executor | assessment 是纯 facts；`assertImOutboundAllowed` 只做对象 final-check，见 C-05/06 |
| `probeWritePathFact` / `classifyWriteTargetScope` | raw target、workDir/userData/home/sensitive prefix → normalized path、zone、targetKind、identity | `WritePathProbeError` 区分 caseId/environment；gate 转 `extraction-failed` 或 `write-target-scope:unknown`；消费者 policy 与 permit | extractor 不调用 policy/executor；gate 后置 outside-write if 是 C-02/03 |
| `probeReadPathFact` | raw target、workDir/userData/home → path zone/kind/identity | `ReadPathProbeError` 记录环境错误；gate 输出 `extraction-failed`；policy matcher 与 read permit 消费 | probe 只观察；permit executor 的重探测是 final-check，不是 facts extractor |
| `probeFeishuMediaTarget` / WeChat media target probe | inbound attachment path、受信 media root → boundary、kind、identity、解析状态 | unknown/outside 通过 `feishu-media-target:*` / `wechat-media-target:*` signal；规则和发送/读取对象绑定消费 | path/identity 为 facts；规则 deny 与平台最终对象核对需分开 |
| `analyzeShellCommand` + `classifyShellCommandEffect` | command、workDir/platform/config → shell path/effect/completeness/security hints | parse/probe failure 标记 `extraction-failed`；shell precheck 可能先于 policy 返回 deny（C-12） | analyzer 产事实；precheck 同时含命令规则判决，须逐 validator 拆 |
| `extractScriptPathFacts` / `analyzeScriptContent` | 脚本文本、语言、解析结果、认证配置 → call/path/network/completeness/digests | dynamic/unmodeled/unverified 经不同 signal 传给默认/locked 规则；提取异常另产 `extraction-failed` | facts producer 不应直接执行；script allow/ask/deny 为 policy 规则 |
| MCP/tool metadata extraction in `toolCallGate` | server/tool annotations、args、registered metadata → mcp signals、actionClass、target facts | missing metadata 会产 extraction-failed / unknown；MCP ask 与 readonly allow 由规则匹配 | profile `toolConfirmPolicy` 曾是 extractor 侧免问分支；当前要追清是否仍作为 facts filter |

facts 行为有现成 unit tests，但“异常仅改变 completeness/技术错误，不伪造风险 signal”及“不问询/不 dispatch”的边界断言需在 Phase 1 增补。
