# Phase 1 兼容期行为等价矩阵

本矩阵核对 Phase 1 引入事实采集后仍由现有 gate/兼容消费者作出动作。事实 producer 只给出观察结果；本阶段不移除授权检查，不改变审批者。

| 场景 | 事实来源 | 旧动作/兼容消费者 | Phase 1 回归证据 | 对照结论 |
|---|---|---|---|---|
| IM outbound 普通内容 | `classifyImOutboundContent` + `createImOutboundFacts` | `assessImOutboundContent` 保留旧分类标签及路由 | `imOutboundFacts.test.ts`、`outboundClassification.test.ts`、`wechatOutboundRegisteredTools.test.ts` | 普通内容原判定保留；事实只附 digest、版本、覆盖和 evidence kinds |
| IM outbound 凭据/本地路径 | outbound facts evidence kinds | 原 `assessImOutboundContent` 和工具 gate | 同上及 `toolCallGate.test.ts` | 原敏感分类仍有效；事实不含正文 |
| IM 附件凭据/个人信息/敏感路径名 | `createImAttachmentFacts`；gate 并行产 `wechat-media-content-assessment` | 既有附件内容摘要、目标路径分类和 gate 决策 | `imAttachmentFacts.test.ts`、`toolCallGate.test.ts`、`weChatToolExecutor.test.ts` | 当前策略仍由兼容路径决定；新 assessment 是观察信号，不自动 deny/confirm |
| IM 附件内容不可解析/不可用 | inspection coverage `partial/unavailable` | 目标身份与既有路径/内容检查失败闭锁 | `imAttachmentFacts.test.ts`、`toolCallGate.test.ts` | 保留不确定状态，不凭空生成敏感标签 |
| Shell 只读/写入/未知效果 | command-sequence、command-effect、shell-analysis-completeness | `shellEffectFacts`、shell precheck、路径检查、既有策略 | `extractors.test.ts`、`shellEffectFacts.test.ts`、`shellConfirmationAdapter.test.ts`、`toolCallGate.test.ts` | extractor 不裁决；unknown 与 partial 明示，原 gate 顺序保留 |
| Shell 路径在 workdir 内/外/敏感目录 | `path-target` 与 shell analysis paths/redirects | shell path probes、precheck、path policy | `shellConfirmationAdapter.test.ts`、`toolCallGate.test.ts` | 旧路径分类与拒绝/确认仍由 gate 消费 |
| 同一调用的策略决策与审批 Agent | gate `InvocationFactsSnapshot` | `AgentSdkSafetyPolicy` → confirmation port → `AgentChannel` → approval clue prompt | `toolCallGate.test.ts`、`agentSdkSafetyPolicy.test.ts`、`agentSdkConfirmationPort.test.ts`、`agentChannel.test.ts`、`approvalAgent.test.ts` | snapshot provenance 沿链传递，审批 prompt 显示同一 fact ID、extractor、coverage、revision、policy version |

## 未完成/外部证据

- 真实 IM/MCP provider 与生产数据检查不在本地源码测试可验范围，列为源码闭环后的外部验收项。
- `approvalAgent.test.ts` 全文件在当前基线上有 Hosted provider/SQLite/撤权用例失败（Phase 0 测试记录已列同类失败）；新增 clue provenance 用例单测通过。Phase 收尾全量测试需复核是否有新增失败。
