# 审批失效与策略并发协议（P2-10）

## 决策依赖

`PolicyDecision.dependencyFingerprint` 只包括本次 facts/context 可匹配的规则链、所有能提前改变 verdict 的匹配保护规则（deny / humanRequired / confirm-every-time）、policy domain/lane/tier/version/revision、引擎配置与迁移状态。所选规则保留声明顺序；事实 digest 单独绑定在 decision 上。未匹配的规则变化不会改变本次决策依赖指纹。

重新核验需满足：facts digest、最终 verdict、rule/reason ID、answerer、策略依赖指纹和批准对象都仍匹配。已确认的 require-confirm 可在新的 gate 决策仍给出同一 rule/verdict/answerer 时复用；从 ask 变 allow 只接受原决策为同一批准调用的 cache-hit/auto-allow 回落路径。无 PolicyDecision 的旧兼容入口仍要求全局 authorizationVersion 完全相等。

## 时间与并发

1. 初次 gate 计算并保存 `PolicyDecision` 与当时 policy dependency fingerprint；批准记录仍绑定 invocation/toolUse/参数/对象。
2. 批准返回后重新准备调用和当前策略材料。主机重新计算完整 gate decision；缺料、事实改变、deny、不同 rule/verdict/answerer 或依赖指纹变化时不签发 permit，按新决定要求新的真人确认或拒绝。
3. SDK 允许 recheck binding 的广义 authorization snapshot 变化进入主机复核；调用身份、能力、input hash、plan/facts（除明确重新批准的新计划路径）仍需一致。主机 SafetyPolicy 必须将初次与新 PolicyDecision 依赖比较。只有无 PolicyDecision 的兼容路径继续比较全局版本。
4. permit 与 recheck authorization 绑定到当前 authorizationVersion。最终执行前仍比较当前代次/版本并验证撤权、subject 和 prepared binding；在 recheck 后发生的并发策略或授权变化会使 permit 失效，executor 调用数为 0。

此协议只允许“在完整重算后确认无关规则变更不影响当前 decision”的调用继续，不允许旧 decision 在新规则下直接执行。`authorizationVersion` 在执行前仍作为并发失效/代次门控，不作为审批语义的唯一过期键。

证据：`policyDecision.test.ts`、`toolCallGate.test.ts`、`agentSdkSafetyPolicy.test.ts`、`registeredAgentTurnTools.test.ts`、`packages/agent-sdk/test/turn.test.ts`。
