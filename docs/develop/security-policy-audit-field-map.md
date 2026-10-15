# 安全决策与执行审计字段映射（Phase 0）

## 现有字段与阶段

| 阶段 / 事件 | 已有字段 | 来源 / 脱敏行为 | 缺口或边界 |
|---|---|---|---|
| Facts snapshot（进程内） | `invocationId`、`envelopeHash`、`factsHash`、`extractorVersion`、`completeness`、`evidenceReferences`、`environmentVersion`、`policyVersion`、`factsRevision`、`facts` | `createInvocationFactsSnapshot` 对 envelope/facts 做稳定序列化与 SHA-256，并冻结快照 | 当前 `ContentFacts` 仍可能携带信号明细；必须确认它们只流向必要消费者，不把原始正文/秘密写审计 |
| policy.decision | `lane`、`policyDomain`、`policyBehaviorVersion`、`policyRevision`、`factsCompleteness`、`reviewPath`、`fallbackCause`、`sessionId`、`requestId`、`toolUseId`、`invocationId`、`toolName`、`actionClass`、`factId`、`signals`、`decision`、`ruleId`、`decisionRuleId`、`answerer`、`ruleOrigin`、`denyClass`、`cause` | `SecurityAuditEvent`；`securityAuditLog.sanitizeAuditEvent` 对 factsSummary 做短摘要 hash，对原 factId hash化，对敏感凭据/路径做脱敏 | 无稳定独立 `decisionId`；`factId` 字段被多处复用，需要确认能稳定关联 snapshot `factsHash`；rule collection/顺序依赖指纹未见统一字段 |
| confirm.request / confirm.outcome | `requestId`、`toolUseId`（按 producer）、`outcome`、`answerer`、`cause`、`reasonSummary`、`evidenceCount`、`actorRef`、`latencyMs` | channel / approval Agent producer；摘要可记、证据正文不得进审计 | 需要核实所有路径都携带原 `decisionId` 或 `decisionRuleId`、facts revision/hash、精确 subject digest；本表字段定义未见 decision dependency fingerprint |
| execution veto | `policy.execution-veto`、`requestId`、`toolUseId`、`toolName`、`decisionRuleId`、`factId`、`pathZone`、`failureClass`、`caseId` | `recordPolicyExecutionVeto` 对 factId hash化；failureClass 为 input/mechanism/environment/integration-violation | 已区分 veto 与 policy.decision；当前未见 invariantId 通用字段，且部分 veto 可能没有原 decision ID |
| Dispatch / deferred approval | `dispatchKey`、`todoId`、`invocationId`、`executionState`、`notificationState`；部分 remote 任务带 channel、identity/owner、`authorizationEpoch`、rule/facts hash | deferred event 定义与 DB schema；业务 payload 按对应 store 规则脱敏/引用 | 需要逐通道核验 dispatch outcome 是否与原 decision/approval/subject digest 同链；不要将 idempotency key 当作授权身份 |
| 许可对象 | read permit 的 `requestId`、`toolUseId`、`toolName`、`inputDigest`、targets 中 `factId`/`decisionRuleId`/path zone/kind/identity；memory permit 的 invocation/request/tool/session、plan/facts digest、revision、过期时间 | 许可在内存 registry 绑定 subject digest；执行时比较对象、过期、身份/代次 | 一次普通 `PolicyDecision` 到 receipt、permit、policy dependency fingerprint 尚未由统一契约连接 |

## 脱敏样例（字段结构，不含真实凭据）

```json
{"event":"policy.decision","requestId":"req-…","toolUseId":"tool-…","invocationId":"inv-…","toolName":"wechat_reply","factsCompleteness":"complete","factId":"fact-<sha256-24>","decision":"require-confirm","ruleId":"outbound-standard-agent","answerer":"agent","policyDomain":"im","policyBehaviorVersion":"im-standard-v2","policyRevision":12,"actor":"system"}
{"event":"confirm.outcome","requestId":"req-…","toolUseId":"tool-…","decisionRuleId":"outbound-standard-agent","outcome":"approved","answerer":"agent","cause":"agent-approved","actor":"agent"}
{"event":"policy.execution-veto","requestId":"req-…","toolUseId":"tool-…","decisionRuleId":"outbound-standard-agent","factId":"fact-<sha256-24>","failureClass":"mechanism","caseId":"outbound-subject-mismatch","actor":"system"}
```

上例展示目标关联形态，不表示当前事件 producer 已全部输出这些字段。尤其第一行 ruleId 是目标字段，不得误认为当前 agent port 已有该规则。

## 不进入审计的内容

- 原始消息正文、工具参数全文、附件正文、secret/API key、认证 token。
- 原始本机路径、私人收件人信息；以路径 zone、脱敏 factId、必要的对象摘要代替。
- 审批 Agent 的 clue/evidence 原文；只留安全摘要、证据计数和引用。

Phase 1/2/3/4 需要补齐：稳定 decision ID、facts snapshot hash/revision、规则依赖指纹、receipt/approval 关联键、执行 envelope digest、invariant ID 与 failure class 的统一链路；在不破坏历史事件读取的前提下增加。
