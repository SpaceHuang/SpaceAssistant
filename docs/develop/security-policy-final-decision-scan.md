# 安全策略 P5 隐藏改判二次扫描

日期：2026-10-16。范围：Phase 0～4 完成后对生产策略/gate/adapter/executor 源码复扫；本记录只声明源码静态复核，不代替正式包或真实服务验收。

## 搜索范围与命令

```sh
rg -n "actionClass|humanRequired|answerer|approved\\s*=\\s*false|verdict|require-confirm|outsideWorkDirRisk|contentAssessment|permit|revok|capability|dispatch" \
  electron/confirmation electron/remote electron/tools electron/shell electron/feishu electron/wechat \
  src/shared/policy src/shared/confirmation packages/agent-sdk/src

rg -n "classifyImOutbound|declared-capability|dangerous-signal|shouldSkipRemote(ScriptConfirmOnAllow|BrowserNavigateConfirm|LarkWriteConfirm)|hasDangerousSignal|hasDeclaredCapability" \
  src electron docs/develop/security-policy* docs/develop/tool-confirmation-framework-implementation-plan.md
```

另按 P0 线索检查 gate、policy engine、confirmation adapter、remote policy、各 executor 的 `allow/deny/confirm/answerer` 写入和 dispatch suppression，并结合 P2 的 `policyDecisionBoundary` 架构测试判断，而非将关键字命中直接视为策略越界。

## 归属与白名单

| 命中类别 | 归属 / 结论 | 证据 |
|---|---|---|
| `policyEngine.ts` 中 `denied-tools`、规则 deny、human-required、显式 MCP ask、confirm-every-time、cache、auto-evaluator 与默认规则顺序 | Policy Engine 唯一产品策略出口；属于显式 `ruleId` 或已说明的配置约束，不是隐藏改判 | `policyEngine.test.ts`、`policyDecisionBoundary.test.ts` |
| `toolCallGate.ts` 的 `shell-precheck-deny`、`read-v1-target-unsupported`、材料缺失及提取失败 | 命令/目标输入 validator 或 mechanism failure；不伪装成风险 facts。审批递归/重新确认的终止分别标记 invariant ID | `toolCallGate.test.ts`、`recursionGuard.test.ts`、`systemInvariantRegistry.test.ts` |
| `rules-violated` / locked floor 验证 | policy 配置契约失败，不是针对调用内容的新产品风险 verdict | `policyFloor.test.ts`、registry/floor IPC tests |
| read/write permit、identity/generation/revocation、subject digest mismatch | execution final-check / invariant veto；关联原 decision，执行器在失败时不产生副作用，不重写策略 decision | permit suites、execution veto audit tests、execution closure matrix |
| SDK capability admission 与撤权 | `SYS-CAPABILITY-001` / `SYS-REVOCATION-001` lifecycle/integrity invariant；执行资格和撤权并非可配置风险选择 | registry、agent-sdk safety/runtime component tests |
| IM `assertImOutboundAllowed` 及 shell/browser/MCP executor 对象校验 | final-check 只核对已批准对象和机制状态；不复判内容敏感性；不匹配时不 dispatch | outbound classification final-check、各 outbound adapter 和 executor tests |
| `decideSystemImOutbound` | host system reply 专属显式 policy：`im-system-reply-ordinary` 或 `im-system-reply-review-required`；不是用户工具决策旁路 | `imOutboundPolicy.test.ts`、system reply sender tests |
| 注册 invariant 的递归/审批重检 | `SYS-RECURSION-001`、`SYS-APPROVAL-001` 在 gate audit 记录 `invariantId`；registry 仅登记/校验，不产生运行时 verdict | registry tests/checker、gate audit tests |

## 已迁移或删除符号复查

- `classifyImOutbound`：已从源码删除；剩余字面量仅为 inventory 追踪和历史设计说明，无引用/生产调用。其授权用途由 IM facts + Policy Engine / system reply policy 承担；最终 dispatch 仅用对象比较。
- `ExecutionContext.declaredCapabilities` / `declared-capability`：类型与快通道均已删除；唯一残余文字为 inventory 记录。当前没有生产来源可证明声明能力身份，普通 policy rules 继续裁决。
- `hasDangerousSignal` / `dangerous-signal`：Policy Engine 硬编码分支已删除；危险脚本由 `script-dangerous-deny` 显式规则表达，并有删规则反例测试。
- 无调用的 `shouldSkipRemoteScriptConfirmOnAllow`、`shouldSkipRemoteBrowserNavigateConfirm`、`shouldSkipRemoteLarkWriteConfirm`：源码 helper 与专属测试已删除。实际在 gate 消费的 browser act snapshot 投影仍保留；统一规则消费其它 remote 配置。
- `assessImOutboundContent` / `classifyImOutboundContent`：保留为纯内容事实分类器；输出事实标签，不决定 allow/confirm/deny。

隐藏符号复扫结果：生产源码无上述旧授权出口。静态命中仍包含历史文档和 inventory 中的符号名，用于说明迁移来源；不作为活代码例外。

## 扫描限制

本次审阅定位在安全策略迁移候选目录与其生产调用链，架构门禁对 decision boundary 的受控目录另有测试。普通参数验证、执行机制错误、显示文案、审计投影不因关键词命中而自动认定为改判。模拟测试与源码静态扫描不能证明正式发行包、目标 OS 文件系统语义或真实 WeChat/Feishu/MCP 的外部副作用。
