# ToolFacts 共享契约（P1-01）

## 复用的通用 schema

通用工具 facts 不再复制一份 `ContentFacts`。类型真源为 `src/shared/confirmation/types.ts` 中的 `ContentFacts` 与 `FactSignal`；不可变、版本化的快照由 `src/shared/confirmation/invocationFactsSnapshot.ts` 的 `InvocationFactsSnapshot` 提供，公开别名 `ToolFacts = InvocationFactsSnapshot` 表明其作为 policy/approval 共享输入的职责。

| 字段 | 生产者 | 消费者 | 缺省/失败语义 |
|---|---|---|---|
| `factId` | snapshot builder；以 invocation、envelope/facts hash、extractor、coverage、environment、policy version、revision 的规范化摘要生成 | policy trace、approval evidence、final-check 关联 | 每个快照/修订唯一；不包含原始入参 |
| `invocationId` | SDK/host 调用上下文 | 全链路关联、permit 和审计 | 缺失/空白拒绝创建 snapshot |
| `envelopeHash` | snapshot builder 对精确工具/输入 envelope 做稳定 JSON + SHA-256 | 授权对象绑定与最终 recheck | 非 JSON/cycle 拒绝创建；原文不保存在 hash 字段 |
| `factsHash` / `factsRevision` | snapshot builder 对 `ContentFacts` 做稳定 JSON + SHA-256，并单调递增修订 | policy 决策、approval/final-check recheck | facts 或 revision 改变即产生不同 `factId`/hash |
| `extractorVersion` | facts producer | 重放/迁移判断 | 必须显式非空；变更后作为依赖变化重新核验 |
| `completeness` | facts producer | policy 规则 | 允许 `complete/partial/missing/parse-failed/authentication-missing/capability-description-stale`；未知状态不得折成风险标签 |
| `evidenceReferences` | 宿主/可信 detector | policy 与 approval clue | 只放不含秘密的引用；必须为非空字符串数组，绝不包含原文凭据 |
| `environmentVersion` / `policyVersion` | 宿主快照与生效 policy snapshot | policy decision/recheck | environment 必须显式；未传 policyVersion 暂用 `policy-unspecified` 并在接入点补全 |
| `facts` | 唯一的 `ContentFacts` schema | Policy Engine、审批材料 | 不加 verdict/answerer/rule ID；敏感正文由 producer 只输出 evidence kind/digest，不塞进 summary/signals |

`factId`、`factsHash` 是关联标识，不是授权凭据。policy 输出继续由现有 `Decision` 承载，不能把决策字段混进 ToolFacts。

## IM outbound 专属事实

`src/shared/confirmation/imOutboundFacts.ts` 定义 `ImOutboundContentFacts`，作为 IM 内容检查器的专属结构化增量事实，不复制通用 `ContentFacts`：

- `factId`：派生自 classifier version 与 `contentDigest` 的稳定短 ID。
- `contentDigest`：正文 SHA-256，用来关联内容版本；不得将 digest 解释为已批准或拒绝。
- `classifierVersion`：当前 `host-im-outbound-v1`。
- `inspectionCoverage`：`complete / partial / unavailable`；空正文是 partial，超 20,000 字符是 unavailable。
- `evidenceKinds`：`credential-like-pattern`、`local-path-reference`、`bulk-export-language`、`permission-change-language`。
- 禁止字段：正文、recipient decision、allow/deny/confirm、answerer、dispatch 状态。

模块只依赖标准 Web Crypto、TextEncoder 和自身的匹配器；不导入 policy、executor、approval channel 或 dispatch。现有同步 `ImOutboundFacts` adapter 在迁移期仍保留 exact body 绑定与兼容路由；WeChat registered outbound tool 在准备/执行复核阶段并行生成 `contentFacts` 并与其余绑定一同指纹化。它不是新的授权来源。P1-05/P1-09 再把结构化 facts 接入 policy/approval 并以 shadow 对照旧行为。

## IM attachment 专属事实

`src/shared/confirmation/imAttachmentFacts.ts` 只输出 `factId/contentDigest/extractorVersion/inspectionCoverage/evidenceKinds`，可观察 credential、personal data 与敏感文件名；path、文件名和内容均不进入结果。gate 对 WeChat 文本附件读取并行产 `wechat-media-content-assessment`，executor 的 `attachmentHasSensitiveMaterial` 作为兼容 consumer 仍把任一 evidence kind 映射为既有 boolean 阻断，真实路径身份错误仍沿 mechanism fail-closed。该 signal 当前不改变 policy verdict。

## Shell/path facts

`commandSequenceExtractor` 继续产命令序列，并补 `command-effect` 与 `shell-analysis-completeness` 观察；效果无法可靠证明为只读时记 `unknown`，解析不完整为 `partial`。`ShellConfirmationAdapter` 复用既有 `ShellFactAnalysis`、路径 zone 与 effect classifier，不调用审批、dispatch 或 policy。既有 shell precheck/path probes/gate 仍按当前顺序消费。

## Snapshot 与审批 provenance

`toolCallGate` 在现有 `ContentFacts` 和决策生成后创建 `InvocationFactsSnapshot`；审计只记录脱敏关联用 `factsSnapshotId`、extractor version、revision，不落 envelope/facts 明文。`AgentSdkSafetyPolicy` 将同一 provenance 传入 `GateConfirmationContext`，`AgentSdkConfirmationPort` 传给 `ConfirmRequest`，`AgentChannel` 放入 clue；审批 prompt 显示 ID、提取器、coverage、revision、policy version，避免写入 facts 正文。最终复检重新生成 snapshot。

## 测试与消费者

- `src/shared/confirmation/invocationFactsSnapshot.test.ts`：factId/hash 形态、修订绑定、输入验证、冻结与比较。
- `src/shared/confirmation/imOutboundFacts.test.ts`：纯输入输出、稳定性、证据标签、覆盖状态和原文不保留。
- `src/shared/confirmation/outboundClassification.test.ts`：兼容期旧分类器行为矩阵。
- 通用 consumers：`policyEngine.ts`、`recheckInvocationFacts.ts` 与 gate/approval evidence adapter；实际 policy/Agent 同 factsVersion 的接线在 P1-05。
