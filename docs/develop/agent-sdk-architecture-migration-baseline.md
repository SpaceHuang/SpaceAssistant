# Agent SDK 架构迁移基线

核对基线：`b2b2f4f3`（2026-09-26）；当前实现复核：2026-09-28，位于 `codex/agent-sdk-architecture-tdd`。

> 下方“基线快照”保留 2026-09-26 的原始状态。当前接线已明显前进，迁移判断以“当前实现复核”节为准；不要把历史快照中的缺口描述当作现状。

## 基线快照：2026-09-26

| 关注点 | 当前所有者/入口 | 证据与测试种子 | 迁移说明 |
|---|---|---|---|
| 工具循环与 stream | `electron/toolChatLoop.ts::runToolChatSession` | `toolChatLoop.*.test.ts` 覆盖轮数、取消、stream 错误、lane、审批嵌套、消息重建 | 统一循环尚在 Electron；调用方为 Desktop `claudeStreamHandlers`、Feishu、WeChat、Butler/Automation |
| 调用装配 | `electron/runtime/invocationAssembler.ts::assembleInvocation` | `profileReasoning.test.ts` 等 | 适合作为唯一 Composition Root；当前 `AgentInvocation` 契约来自 shared |
| typed tool 生命周期 | `electron/tools/plannedToolRegistry.ts` + `executeRegisteredTool` | `plannedToolRegistry.test.ts`、`toolInvocationCoordinator.test.ts` | prepared snapshot/digest 已存在；legacy executor 与专门执行分支仍并存 |
| policy gate | `electron/confirmation/toolCallGate.ts::evaluateToolCallGate` | `toolCallGate.*.test.ts`、`automationLane.test.ts`、`recursionGuard.test.ts` | 宿主 policy/rules/cache/facts；可经 SafetyPolicyPort 包装 |
| builtin/MCP 执行出口 | `electron/toolChatLoop.ts` 与 `electron/tools/*` | `toolChatLoop.mcp.test.ts`、builtin executor tests | 尚未统一为安全 permit + dispatch lease |
| 取消/撤销 | `packages/agent-core/src/runtime/components.ts` 与 `electron/toolRevocationRegistry.ts` | `packages/agent-core/test/agentCore.test.ts`、runtime tests | 存在双 registry；agent-core lane 集不含 automation |
| Provider | `electron/llm/*` 与根依赖 `@earendil-works/pi-ai@0.87.1` | `electron/llm/*test.ts` | pi-ai 已用于现有模型基线；需限制为可选 adapter 和显式 Anthropic profile |
| History | Electron SQLite/session/message operations + `agent-core/src/history.ts` | `electron/claudeStreamHandlers.rebuildParity.test.ts`、chat restart probes | SDK HistoryPort 目前是最小内存事件端口，不是真源 |

## 当前实现复核：2026-09-28

### 现状到目标映射与调用出口

| 现状模块/符号 | 关键输入 → 输出 | 主要副作用/边界 | 当前测试种子 | 迁移目标/现状 |
|---|---|---|---|---|
| `electron/claudeStreamHandlers.ts::registerClaudeStreamHandlers`、`loadAuthoritativeTurnContext` | IPC payload 的 request/turn/session/start token → 持久化 turn 的 user boundary、messages、execution config 与 `runToolChatSession` 调用 | 持有 Desktop IPC、凭据解析、首响应流式事件、SessionEvent 和 turn terminal；Hosted full-turn handoff 已接入，V2-C gate 模式在注册时冻结 | `claudeStreamHandlers.callerContract.test.ts`、`context.test.ts`、`hostedIntegration.test.ts`、`modelBinding.test.ts`、`rebuildParity.test.ts` | 当前 Desktop Hosted 执行入口；迁移目标是保持薄路由/兼容责任，最终只保留 Runtime 调用与产品输出投影 |
| `electron/chatMessageBuild.ts::buildToolChatMessagesFromSource` | SQLite message/context boundary、tool-call/tool-result、compaction 与 skill 前缀 → Anthropic canonical wire messages | 读取会话事实并构建 provider transcript；不执行工具 | `chatMessageBuild.test.ts`、`claudeStreamHandlers.rebuildParity.test.ts` | mapper 归宿主 Anthropic adapter；SDK 只保留 canonical message/event，不持有 Electron message model |
| `electron/toolChatLoop.ts::runToolChatSession` | `AgentInvocation`、`AgentHostPorts`、首个已提交模型响应与可选 Hosted handoff → provider/SDK 请求、确认、工具调度和 `AgentInvocationResult` | 当前仍拥有请求准备、旧 loop 兼容、确认投递、审批等待/恢复、工具终态及若干 SessionEvent 投影；Hosted full-turn 已生产接线，但 loop 仍是宿主主入口 | `toolChatLoop.invocation.test.ts`、`lane.test.ts`、`mcp.test.ts`、`maxRounds.test.ts`、`safetyReject.test.ts`、审批/取消/stream/rebuild/persistence 专项 | V1/V2-C 共享迁移壳，目标为 SDK 唯一 loop；不能复制第二套循环，也不能把安全 gate 故障回退到 legacy |
| `electron/runtime/invocationAssembler.ts::assembleInvocation` | 已解析的 session、turn、model route、凭据身份、workspace、lane、配置、有效策略与 executor factories → 冻结 `AgentInvocation` + Runtime/Host/RegisteredTool adapter | 唯一产品组合根；持 Electron/SQLite/执行句柄，向 SDK 暴露窄 ports；装配失败 fail closed | `invocationAssembler.test.ts`、`profileReasoning.test.ts`、`invocationProviderRoute.test.ts`、`hostedTurnHost.test.ts` | 保留为唯一可同时依赖 SDK/provider 的 Composition Root；共享 Invocation 本身仅冻结数据 |
| `src/shared/agent/invocation.ts::AgentInvocation` / `AgentHostPorts` | trace/session/messages/profile/limits/safety/context + ports → 共享调用事实与宿主能力契约 | 仍由 shared 所有，引用 shared UI/domain/policy 数据类型；端口以接口形式存在，但有 `unknown` 兼容域及 deprecated `legacy.appDb` 过渡例外 | `toolChatLoop.invocation.test.ts`、`plannedToolRegistry.type.test.ts`、SDK boundary checks | V0 冻结字段归属；后续消除不必要的 UI/Electron 语义，不把执行句柄放入 canonical state |
| `electron/tools/plannedToolRegistry.ts::TypedToolRegistry` / `executeRegisteredTool` | 可见 capability、canonical args、invocation context → prepared handle、validation result、executor result | 宿主持执行闭包；现有生产 builtin/MCP 经 typed adapter 和 permit-bound dispatch；direct registration 由测试约束为禁止 | `plannedToolRegistry.test.ts`、`plannedToolRegistry.type.test.ts`、`toolInvocationCoordinator.test.ts`、adapter tests | 产品 adapter 持有计划/执行实现；SDK 只处理能力身份与生命周期协议 |
| `electron/tools/plannedToolRegistry.ts::legacyEntries/getLegacyExecutor` 与 `electron/toolChatLoop.ts` legacy 分支 | 旧 `ToolExecutor` 注册项、规范化调用输入与 `ToolExecutionContext` → 旧式 executor result | Registry 暂时并存 planned/legacy 两套视图；loop 在 Hosted handoff 缺失/兼容入口中仍可读取旧 executor；生产 composition root 对未注册裸 executor fail closed | `plannedToolRegistry.test.ts`、`toolChatLoop.*.test.ts`、`hostedTurnHost.test.ts` | 仅记录迁移遗留边界；后续移除旧视图属于 V3，不在 V0 追加替代功能 |
| `electron/effectiveTools.ts::computeEffectiveTools/authorizeToolCall` | invocation 冻结的 profile/tool config、lane、MCP 快照及宿主权限 → provider-visible tool list 与内部 identity 授权集合 | 决定模型可见能力与实际授权 identity；不执行副作用；Hosted handoff 将授权集合与 request-visible capability 取交集 | `effectiveTools.test.ts`、`toolChatLoop.mcp.test.ts`、Hosted capability intersection tests | V0 冻结输入/输出及授权语义；SDK 不重算产品工具配置 |
| `electron/confirmation/toolCallGate.ts::buildToolCallGateArgs/evaluateToolCallGate`、`src/shared/policy/policyEngine.ts` | 工具名/输入、facts、lane、rules、decision cache、确认历史 → deny/allow/ask/auto-evaluator 与审计材料 | 宿主读取当前配置、事实、缓存并记录审计；shared policy engine 为规则/记忆行为，不直接执行副作用 | `toolCallGate.test.ts`、`policyEngine.test.ts`、`defaultRules.test.ts`、`memoryEligibility.test.ts`、`agentSdkSafetyPolicy.test.ts` | Gate facts 与 rules 归产品 `SafetyPolicyPort`；SDK SafetyGate 不匹配产品配置或缓存键 |
| `electron/confirmation/readExecutionPermit.ts`、`writeExecutionPermit.ts`、`readPermitExecutor.ts` | confirmation snapshot 与文件事实/输入 → 专用 read/write permit → executor 边界事实校验 | read/write validator 在最终读取/原子写入前核目标身份、输入和路径；仅针对读写，不等同于通用 SafetyPermit | 对应 permit/validator、read/write integration、`permitBoundCoordinatorDispatch.test.ts` | 专用 permit 保留为 adapter 领域事实；与 SDK `SafetyPermitStore` 的 opaque ID 分开建模 |
| `packages/agent-sdk/src/safetyGate.ts`、`safetyPermit.ts`、`toolExecutionPort.ts`、`executionAdmission.ts` | capability + policy decision + binding → 单次 safety permit → consume/claim lease → executor port | SDK 管生命周期、签发与 claim 顺序；executor 句柄仍由 Electron adapter 持有，claim 后取消通过 lease signal 传播 | SDK safety gate/permit/tool port/admission tests；Hosted adapter 与真实 Desktop caller barrier tests | 目标唯一安全执行入口；V2-C Desktop 子阶段已完成，其他 lane 仍未验收 |
| `electron/tools/builtinExecutors.ts`、`electron/mcp/*` | 规范化工具 args、prepared plan、MCP snapshot 与 execution context → 文件/进程/browser/外部 MCP result | 产生本地文件/进程或远端副作用；完成前后审计，dispatch 后未知结果禁止重放 | builtin、browser、MCP adapter tests；Desktop/Remote/Butler production callers | executor 留在宿主 adapter；SDK 不导入具体工具、Browser/MCP clients 或 Node/Electron API |
| `electron/database/operations.ts`、`electron/database/agentHistoryStorage.ts`、`electron/runtime/sqliteAgentHistory.ts`、`electron/sessionEvents.ts` | session/message CRUD、turn state/ledger、invocation History batch 与 SessionEvent projection → SQLite 行、terminal/recovery facts、JSONL/UI 投影 | SQLite transaction 持久化 session/message/turn 与 canonical invocation History；SessionEvent/JSONL 为相关投影，目前没有 SQLite 与 JSONL 的单一跨库原子提交，HistoryPort 尚不是 app-wide 唯一真源 | database operations/migrations、turn coordinator、SessionEvent、SQLite History/recovery 与各真实 caller tests | V2-B 目标是逐 lane 唯一真源和可识别 repair；当前为 invocation-scoped canonical History + 阶段化投影，不能描述为全 app cutover |

### `AgentInvocation` 顶层字段冻结与单向投影

| 顶层字段 | 字段/语义 | owner 与允许投影 |
|---|---|---|
| `trace` | `requestId`、可选 `turnId`、宿主窗口簿记 `windowId` | request/turn identity 在 SDK/History 保持 canonical；windowId 只用于宿主 UI 投影，不进入 provider 或 permit expected |
| `session` | `sessionId` anchor | 由 host 从 persisted turn 冻结；投影至 History owner，不从对话尾部重新推断本轮 user |
| `messages` | 消息 list、current user/assistant message IDs、image attachment 标记 | host→canonical model request 单向转换；SQLite/JSONL 的 message shape 不反向污染 SDK message 类型 |
| `profile` | model、providerRouteId、service identity、context trust、system/options/locale、memory/skills、工具配置、lane、reasoning | provider route/service 与模型参数冻结成 request identity；工具配置、事实与风险材料只能由 SafetyPolicy/RegisteredTool host adapters 消费；不得包含 executor/context factory 函数句柄 |
| `events` | assistant fact、SessionEvent、file-tree/title/notification 的 observer ports | SDK canonical events 单向投影到 UI/JSONL；observer 失败不得改写执行 outcome |
| `limits` | `maxToolRounds`、deadline | SDK 调度约束，不投影为 model-controlled args |
| `signal` / `clientId` | cancellation fact / idempotency identity | host 提供；signal 不序列化，不投影到 provider payload；clientId 只用于准入/去重 |
| `additionalContext` / `driverContext` | approval digest、History facts 与远端调用上下文 | host 私有 facts；需按工具/策略构造 hash/binding，不原样流入模型或 canonical user transcript |
| `safety` | 仅允许受控 `recursionGuard: 'approval-agent'` | host 设置，SDK 只执行递归边界；不可由用户输入或工具 args 控制 |
| `ports` (`AgentHostPorts`) | workspace/credentials/policy/storage/exposure/MCP/usage/diagnostics/answerer/runtime/history 等能力 | 全部为宿主接口；数据可进入 canonical event 的只有明确定义的白名单事实，执行对象、DB、manager 与 API key 不可投影 |

### 冻结的逐符号 import 闭包图

使用 TypeScript AST 沿相对 `import`/`export` 解析到本地文件，记录当前实现的符号依赖。此图是 2026-09-28 快照；任何新增边都必须重新评估 owner 与方向。

| root | 闭包 | 符号边（压缩表示） | V0 结论 |
|---|---:|---|---|
| `src/shared/policy/policyEngine.ts` | 4 modules | `policyEngine → confirmation/types (CacheKey, ContentFacts, Decision, DecisionCacheView, ExecutionContext, ExecutionLane, IngressFacts, MemoryTier, PolicyEngineDeps, PolicyRule)`；`policyEngine → memoryEligibility.deriveMemoryEligibility`；`policyEngine → confirmation/labels.memoryTierLabel`；两子节点均指向 `confirmation/types` | 无 Electron/SDK 边；保持 shared 产品策略实现，SDK 只消费 SafetyPolicyPort 决策 |
| `src/shared/policy/defaultRules.ts` | 16 modules | root → `confirmation/types.PolicyRule`、`browserRemotePolicy.BROWSER_REMOTE_DISABLED_CODE`、`shellToolDisplay.SHELL_REMOTE_DISABLED_ERROR`；后两者闭包到 `errorCodes`、`shellTuiContract`、`domainTypes`、`browserTypes`、`feishuTypes`、`wechatTypes`、`builtinToolMetadata`、`locale`、IM confirm/progress/outbound helpers | 默认规则是产品事实数据；传给 SDK 前由宿主解析，不把其配置闭包变成 SDK 依赖 |
| `src/shared/policy/memoryEligibility.ts` | 2 modules | root → `confirmation/types.(ConfirmAnswererKind, ContentFacts, ExecutionLane)` | 记忆资格由宿主/shared 管理；SDK 不获取持久化记忆能力 |
| `src/shared/agent/invocation.ts` | 16 modules | root → `assistantFactAggregator.AssistantFactEvent`、`domainTypes.(BrowserConfig, FeishuConfig, ShellConfig, ToolsConfig, WeChatConfig, WikiConfig, Session)`、`browserTypes.BrowserDetectContext`、`confirmation/types.(DecisionCacheView, ExecutionLane, PolicyRule)`、`fileTreeSync.FileTreeChangeEvent`、`localization.LocalizedMessage`；transitive closure 含 domain/browser/Feishu/WeChat/IM/progress/terminal-scrollback/metadata types | shared→Agent SDK 直接依赖门禁通过；该契约仍带较宽的宿主/UI/shared 引用，需在 V0 冻结必要字段后按所有权逐步收窄，不能误称闭包为中立 SDK types |

AST 复核统计：policyEngine 4、defaultRules 16、memoryEligibility 2、invocation 16 个模块（跨 root 去重 24）；外部 package imports 单列为终端节点，不展开。`AgentInvocationProfile.tools` 中的配置快照是 serializable host input，不是可调用能力；port methods 是唯一能力出口。实际 SDK 入口闭包另由 `scripts/check-agent-sdk-boundary.mjs` 做递归门禁，当前 19 modules，零 Electron/shared/Renderer/SQLite。

### 特征化调用顺序与旧出口

以下顺序分别记录旧宿主 loop 的兼容路径和当前 typed Hosted adapter；不能把两者揉成一条“理想顺序”。V0 用来锁定旧行为并识别迁移差异，V2-C 安全路径以 SafetyGate/permit/admission 约束为准。

| 顺序 | 旧 loop / 宿主责任 | Typed Hosted adapter / canonical 责任 | 主要证据 |
|---:|---|---|---|
| 1 | Desktop handler 校验 IPC request/turn/start token，从 persisted turn 的 user boundary 装载消息和冻结 execution config；其它 caller 由 TurnRuntime/Butler/IM 构造 invocation | Host 冻结 request/turn/route/lane identity；已接受的首个 assistant response 在交接前提交 canonical History | `claudeStreamHandlers.context.test.ts`、caller contracts、`hostedTurnHandoff.test.ts`、各 lane input-owner tests |
| 2 | `chatMessageBuild` 根据 session transcript、tool-call/result、compaction、skills 等宿主事实重建 Anthropic request；循环先算 effective tools/MCP snapshot | provider route 显式解析并注册；SDK 接收 canonical request/首响应，不推断协议，不重复首请求 | `chatMessageBuild.test.ts`、`claudeStreamHandlers.rebuildParity.test.ts`、provider mock-wire 和 route tests |
| 3 | 收到工具提案后规范化兼容名、查当前授权集合/撤权、校验输入；browser act 风险与 run_shell 专用 precheck/plan 在普通 gate 前有局部步骤 | CapabilityRegistry 先给三态 capability；SafetyGate 以 host policy 做 initial evaluation，unknown/missing capability 不执行 | `toolChatLoop.mcp.test.ts`、`toolCallGate.test.ts`、SDK capability/safety tests |
| 4 | `evaluateToolCallGate` 汇集 policy rules、facts、decision cache、lane/config 与风险输入；deny/shell precheck/budget pause 写未执行结果，并按规则决定是否继续模型轮 | allow 与 confirmed 都须 fresh recheck；拒绝原因以 `tool-call-not-dispatched` 入 canonical History，不能进入 executor | policy/gate tests、四 lane recheck callers、拒绝回传与计数 tests |
| 5 | ask 路径先写 approval-waiting，再获取审批容量/park 父任务、创建 waiter 或 Approval Agent；结论先记录 approval-resolved，再继续拒绝结果或许可构造；取消/不可用分支逐一结算所有 sibling | approved 后保留 initial snapshot；recheck 绑定 rule/facts/config/target/input 与授权版本，只有 allow 才签发 `phase=recheck` opaque permit | `toolChatLoop.approvalAgent.test.ts`、`confirmation/approvalAgent.test.ts`、manual/agent waiter 与 cancellation tests |
| 6 | 注册工具在旧 loop gate/确认后建立 Prepared handle；计划校验与 typed adapter 生命周期在执行段发生，旧 loop 与 coordinator 的职责仍有重叠 | ToolExecutionPort 从 private PreparedInvocationStore/调用上下文独立构造 expected；permit 原子消费后由 ExecutionAdmission 与 cancel/revoke/version-change 竞争 dispatch claim | `toolInvocationCoordinator.test.ts`、read/write permit tests、`permitBoundCoordinatorDispatch.test.ts`、SDK tool port/admission tests |
| 7 | 旧兼容分支在 executor 阶段写 started、结果及 SessionEvent/fact/progress/error；失败桶、拒绝桶分别计数 | claim 前失效写 not-dispatched 且副作用为零；claim 后同一 lease signal 传 executor，未确认的晚到结果以 interrupted/unknown-after-dispatch 收敛，不重试 | tool lifecycle tests、Hosted late-result callers、SQLite/SessionEvent terminal tests |
| 8 | `tool_result` 拼入下一轮模型上下文；执行错误/安全拒绝使用不同阈值，max rounds、输出截断、overflow 与取消分别终止或恢复 | SDK canonical History 先提交 tool facts/result/terminal；宿主再投影 SQLite/JSONL/UI，rebuild 按 canonical owner 恢复 | `toolChatLoop.maxRounds.test.ts`、`safetyReject.test.ts`、`fallbackGuard.test.ts`、History recovery tests |

旧出口及终止事实：

- provider route/config/profile 缺料、无 Hosted handoff 或 Hosted Runtime 组合失败：provider/tool 执行前 fail closed，不调用 legacy provider fallback。
- malformed/未知/未授权工具、gate deny、recheck drift、permit/binding/admission 拒绝：记未派发事实，不进入 executor；符合继续条件时才让模型解释/改案。
- confirmation cancel/unavailable、request cancellation、pending approval/tool 的 provider/History 失败：先结算可确定的 pending facts；无法确定时用 interrupted，不误报 completed/denied。
- executor 在 claim 前拒绝：executor 次数为零；claim 后取消/撤权/授权版本变化：等待 executor settle，副作用可能已发生时保留 unknown-after-dispatch，禁止 provider 自动重试。
- canonical History/terminal 失败会阻止后续副作用或显式返回 History 错误；派生 SessionEvent/observer repair 不得改写 canonical terminal。
- 达到工具轮数上界时，本轮 provider 已返回的 tool proposal 全部以 `tool-call-not-dispatched(tool_loop_max_rounds_exceeded)` 结清，再以 failed terminal 结束；不得留下 pending proposal。

### 当前复核：2026-09-29

- shared invocation 的 SDK 单向依赖由 `scripts/check-agent-sdk-dependencies.mjs` 和 `invocation.contractShape.test.ts` 双重检查。复核发现 Hosted `HistoryPort` 类型误放在 `src/shared/agent/invocation.ts`；现已移除该 SDK 类型引用，仍使用的 `hostHistory` 仅由 Electron `RunToolChatSessionPorts` 承载。History 事件结构、shadow adapter 与 SQLite 实现继续按原 owner 分层。
- 当前门禁复核：SDK 入口闭包 19 modules 且零 Electron/shared/Renderer/SQLite；SDK dependencies/package closure、Agent SDK typecheck、shared typecheck、Electron typecheck、pi-ai provider typecheck 均通过。`invocation.contractShape.test.ts` 3 tests、Agent SDK + invocation contract 19 files / 229 tests、`chatMessageBuild` + `effectiveTools` 2 files / 4 tests通过。
- V0 历史旧 loop 特征化文件现有用例部分被 V3 Hosted-only cutover 取代。2026-09-29 复跑该宽泛文件组时，2 个仍直调 legacy loop 的文件共出现 25 failures / 75 passes，其中包含 `HOSTED_HANDOFF_REQUIRED` 与超时；这些属于计划 V3 的 stale-caller migration，不作为当前 Hosted 行为通过证据，也未恢复 legacy provider/tool fallback。Desktop、Feishu、WeChat、Automation + nested Approval Runtime fail-stop 的五个精确 Hosted caller 用例通过（5 files / 5 passed），避免宽泛名称过滤引入旧 loop 用例。

当前定向特征化结果：核心消息构建/重建、policy/memory/default rules、审批与取消、lane、MCP、轮数与拒绝 11 files / 113 tests passed；另有后续 stream error 和 canonical History commit failure 两个关键用例分别 1 passed。`toolChatLoop.maxRounds.test.ts` 曾暴露 pending tool proposal 遗漏，修复后每个上界外提案都有 not-dispatched History。四 ExecutionLane + nested Approval 的 Hosted caller smoke 5 cases passed。完整 `npm test` 不属于本次阶段验收门禁，按用户要求功能接线/基线工作期间不运行全量套件。

### 基线快照：依赖闭包与初始门禁结果

- `packages/agent-core/src/index.ts` 有 36 个模块的入口闭包；`npm run check:agent-core` 基线通过。
- 入口最后一项 `export * from '../../../src/shared/agent/invocation'`，故闭包越界进入 shared；调用契约自身继续引用 `src/shared` 的配置、Session、facts、localization 和 `ExecutionLane`。
- `src/shared/domainTypes.ts`、`src/shared/assistantFactAggregator.ts`、`src/shared/approvalPresentation.ts` 曾反向引用 agent-core 的 approval 类型；V0 将展示事实形状移到 shared-owned `approvalTypes.ts`，消除 shared → SDK 反向边。
- V1 后仍须分别移除 SDK → shared 和 renderer/shared → SDK 的直接 import；禁止通过 facade 形成新反向边。

## 已有门禁与初始结果

- `npm run check:agent-core`：SDK 闭包零 Electron、零 `node:sqlite`。
- `npm run typecheck:agent-core`：通过。
- `npx vitest run packages/agent-core`：8 files / 62 tests 通过。
- `npm run typecheck:shared`：通过。
- 当前迁移后门禁：`npm run check:agent-sdk` 通过（2026-09-28 当前 SDK entry closure 19 modules；零 Electron/shared/Renderer/SQLite），`npm run typecheck:agent-sdk` 通过。下方其余段落为 2026-09-26 历史初始结果，不代表当前许可接线状态。
- Provider 适配：`npm run typecheck:agent-provider-pi-ai` 通过；Anthropic HTTP mock SSE 覆盖 request/auth/version/usage/tool/thinking/finish/error/cancel；testing fake 覆盖 canonical route 快照。
- 许可原型：未知/错绑/过期/撤销/重放 fail-closed；beginDispatch claim 先后序列及取消 signal 有参考实现测试。尚未连到宿主 prepared store/executors。
- Desktop/Remote/WeChat/Automation lane 的 loop 与 policy gate 特征化用例见 `electron/toolChatLoop.lane.test.ts`、`electron/confirmation/automationLane.test.ts`、各 remote agent 测试。

## 工具门控顺序观察

调用循环在 `electron/toolChatLoop.ts` 中先调用 `evaluateToolCallGate`（约 2136 行），之后 registered 工具才调用 `executeRegisteredTool`（约 3315 行）。typed registry coordinator 内含 plan/confirm/validation/execute 生命周期，但现有全局顺序还未由 coordinator 或统一 SafetyGate 主导；builtin/MCP/legacy 专项分支尚未封闭到同一执行端口。
