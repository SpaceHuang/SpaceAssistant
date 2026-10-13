# MCP 超时后的 Turn 故障隔离与恢复优化计划

> 日期：2026-10-13
> 文档性质：经评审批准的方案及实施记录
> 状态：阶段 A-E 实现完成；完整全量套件仍受本机网络监听与真实进程清理的沙箱限制，详见验证记录
> 触发案例：会话 `0f57fb3d-b4ea-4763-9c30-6ceec4f84d1d` 末轮并发提出 4 次 `adhoc_get_query_status`：1 次成功、1 次约 39 秒超时、2 次未派发；Turn 以 `interrupted` 结束，后续“继续”没有恢复这批调用的进度
> 关联计划：[工具错误恢复与 Turn 连续性改进计划](tool-error-recovery-and-turn-continuity-plan.md)、[工具并发派发缺陷计划](tool-dispatch-slot-abort-and-transcript-hole-improvement-plan.md)、[本计划评审报告](../review/2026-10-13-mcp-timeout-turn-failure-isolation-plan-review.md)、[复评通过报告](../review/2026-10-13-mcp-timeout-turn-failure-isolation-plan-review-v2.md)、[复评报告 v3](../review/2026-10-13-mcp-timeout-turn-failure-isolation-plan-review-v3.md)

## 1. 执行摘要

当前 MCP 工具执行器抛出异常时，异常通常会沿以下路径升级：

```text
MCP executor 抛错
  → actionClass='outbound'，不降级为工具级错误
  → executor 已进入，ToolExecutionPort 包装为 ToolExecutionAfterDispatchError
  → 并发调度停止派发未领取工具
  → 等待已经启动的并发工具结算
  → 不把本批工具结果交给下一次模型请求
  → invocation-interrupted(reason='unknown-after-dispatch')
```

这条路径对“外部副作用可能已发出、结果未知、不能盲目重发”的写操作有保护价值。当前实现把 MCP 全部标为 `outbound`，并把执行器进入后的异常统一视为整轮致命错误，因此只读状态查询的普通超时也会让 Agent 无法继续工作。

**本计划的核心决策：SDK 按通用执行生命周期结算工具错误，不按 MCP 工具清单决定是否致命。executor entry 证据用 `not-entered | entered | unknown` 表达；executor 进入后抛错或超时记为工具结果未知。仅当宿主生命周期有效时，unknown 才回灌模型继续；取消、总时限、撤权或授权失效优先决定 Invocation 终态。SDK 不自动重试原调用。该方案不要求第三方 MCP 服务端新增能力，也不要求穷举 MCP 工具。SDK 无法通用判断两个不同 tool-call ID 是否代表同一语义操作；语义级去重和 exactly-once 不在本方案范围内。**

### 1.1 术语与能力边界

- 本文所说的执行边界是 SDK 的 executor entry，不代表 MCP 请求已经发到网络或服务端。executor 未进入可记为 `not-dispatched`；executor 已进入但无终态时统一记为结果未知，不区分读取或写入。
- executor entry 证据采用三态：`not-entered`、`entered`、`unknown`。`unknown` 表示持久化记录不足以判断 entry 是否发生；不得将其折算为 true 或 false。副作用结果未知与 entry 未知是两个独立事实。
- 宿主生命周期状态与工具 outcome 分开记录。取消、Invocation 总时限、撤权或授权失效优先决定 Invocation disposition；即使工具 outcome 为 unknown，也不得因此覆盖这些生命周期终态。
- MCP 服务端由第三方控制。本方案不调用服务端特有的去重键、操作查询或资源读取能力；实际工具的语义盘点最多作为补充验证，不参与核心逻辑或验收。
- 任意第三方调用在请求已发出、响应未收到时，客户端无法单方面保证“恰好执行一次”。本计划不承诺 exactly-once；它要求客户端不把超时伪装成失败或成功、不自动重发不确定的写操作，并让 Agent 和用户看到真实的不确定性。
- SDK 的执行记录和 History 用于禁止机械续跑同一个未结算 tool call、呈现其进度；它们不证明远端效果，也不能识别新 tool-call ID 下的语义重复调用。

## 2. 本轮代码分析发现

### 2.1 失败分级过于粗糙

| 现状 | 代码位置 | 影响 |
|---|---|---|
| MCP 注册统一使用 `actionClass: 'outbound'` | `electron/mcp/registeredMcpTool.ts` | 该分类同时承担授权/副作用保护和异常升级，错误处理无法只按 SDK 执行生命周期做通用判断 |
| 异常结算仅对 `actionClass === 'read'` 降级为工具级错误 | `electron/tools/registeredAgentTurnTools.ts` | SDK 错误恢复依赖工具分类；任意 MCP timeout 都可能进入致命路径 |
| executor 进入后任何 throw 都包装为 `ToolExecutionAfterDispatchError` | `packages/agent-sdk/src/toolExecutionPort.ts` | 表达了 dispatch 后结果不确定，但 Turn loop 把不确定等同于整轮致命 |
| `ToolExecutionAfterDispatchError` 被选为 fatal rejection 并向上抛 | `packages/agent-sdk/src/turn.ts` | 单个调用失败阻断整轮，并丢弃本批结果对模型的恢复价值 |

### 2.2 当前批次行为

- 桌面运行时工具并发数为 2。模型一次提出 4 个调用时，通常先启动 2 个，不代表 4 个都已派发。
- 一个在途调用失败后，调度器停止领取新槽位；已启动的兄弟调用不被这段调度代码取消，主流程会等待它们结算。
- 已成功的兄弟工具仍可写入 `tool-call-finished` 并投影成功结果。
- 未派发槽位写入 `tool-call-not-dispatched`，原因一般为 `TURN_STOPPED_BEFORE_DISPATCH`。
- 找到 fatal rejection 后，Turn 在把完整批次结果加入下一次模型消息之前抛错。因此成功结果虽持久化，本轮模型仍没有机会消费成功、失败和未派发结果并调整计划。
- `attemptedCount` 当前来自已结算的调度槽位数量，不严格等于实际进入 executor 的次数。

### 2.3 终态、恢复与诊断

- History 将该轮写为 `invocation-interrupted`，原因 `unknown-after-dispatch`；会话 transcript 以 interrupted 提交，assistant 镜像为 failed。
- 结构化 continuation 检查到 `tool-call-started` 没有结算事件时会以 `UNKNOWN_SIDE_EFFECT` 拒绝，正确阻止对旧调用自动重放。
- 用户另发“继续”属于新请求，不等价于恢复旧工具槽位；模型可能在新请求中再次提出同一操作，目前缺少跨 Invocation 的操作级防重复策略。
- `tools.dispatch_failure_context` 提供工具名与异常类型，底层错误链可进入日志/Turn 结束事件；诊断结构本身没有可靠的 MCP 操作标识。continuation 摘要当前只提取 `path/filePath`，不会生成 `queue_id` 等 MCP 目标信息。
- 执行准入 lease 对未伴随本地 abort 的 executor rejection 记录 `failed`，而 Invocation 终态记录 `unknown-after-dispatch`。这两个值描述不同层次，但命名容易令观测和指标使用者误读。

### 2.4 手动“继续”的失败上下文在 Hosted handoff 中丢失

本案输入精确的“继续”时，会走专用 continuation routing，而不是简单把这两个字当普通新问题：

1. 出站入口识别精确继续意图，并从 canonical History 找到唯一失败 Turn。
2. 系统尝试从失败 Turn checkpoint 原位续跑。若 History 中存在已 `tool-call-started`、但没有结算事件的调用，`validateContinuationCheckpoint` 以 `UNKNOWN_SIDE_EFFECT` 拒绝恢复；这是防止重放未知副作用的正确保护。
3. 出站入口把这个拒绝降级为 context-only 新 Turn，并将 `summarizeFailedInvocation` 生成的摘要写入 `continuationContext`。摘要包含原任务、已确认成功/失败的工具结果、终态错误及“副作用状态未知”的工具操作。
4. `claudeStreamHandlers` 将摘要追加为带 `continuation-context:` ID 的 user 消息。
5. 进入 `createHostedTurnHandoff` 后，只要 session 已有版本大于 0 的 committed transcript，handoff 会把请求消息重建为“系统消息 + committed session transcript + required user message”。这一步没有保留刚追加的 continuation-context 消息，因此最终发给 Hosted Agent 的请求没有失败摘要。

结果是模型看得到持久化的用户对话（包括原始任务和确认），但看不到失败 Turn 的工具进度、错误和未知副作用事实；它会像收到一条新的“继续”用户输入一样重新规划。会话 transcript 的失败提交又有意只保留到当前 required user，因此丢失的信息也不会在下一轮从普通对话历史中补回来。

| 现状 | 代码位置 | 影响 |
|---|---|---|
| checkpoint 对已派发未结算调用拒绝原位续跑 | `electron/runtime/agentContinuation.ts` | 保住未知副作用不被自动重放，行为合理 |
| 拒绝后无提示地切为 context-only 新 Turn | `electron/outbound/outboundAcceptor.ts` | “继续”表面上被接受，但实际从安全 checkpoint 恢复降级为新 Turn，缺少可观测性 |
| 摘要先追加到 `builtMessages` | `electron/claudeStreamHandlers.ts` | 摘要存在于 handoff 前的模型消息候选中 |
| canonical session cutover 重建消息时只保留 transcript 和当前用户消息 | `electron/runtime/hostedTurnHandoff.ts` | 覆盖摘要，导致最终模型请求没有失败进度上下文 |

这个组装缺口和 MCP timeout 是两个不同层次的问题：即使先把工具 timeout 正确降级为可结算的 unknown tool result，只要 continuation 的 canonical cutover 仍丢弃 supplemental context，后续 Turn 依然会看不到失败进度。修复应作为独立 P0，与工具错误分级一起进入恢复方案。

## 3. 问题定义与优先级

| ID | 优先级 | 问题 | 产品后果 |
|---|---|---|---|
| P0 | P0 | 局部 MCP 异常默认升级为 Invocation fatal | 一个工具网络问题使整个 Agent 失去继续处理的能力 |
| P1 | P0 | SDK 没有通用的 dispatch 后错误结算路径 | 普通工具 timeout 依赖 actionClass 分流，并可能升级为 Invocation fatal |
| P2 | P1 | “远端结果未知”与“Turn 无法继续”被合并 | 防重复副作用依赖整轮失败，不能局部隔离 |
| P3 | P1 | fatal rejection 会丢失本批模型恢复机会 | 成功结果虽然落库，模型不能消费它们继续规划 |
| P4 | P1 | continuation 未把未决调用事实交给模型 | 用户点继续后，模型可能在不知道上次派发状态时重新规划；SDK 无法通用识别语义重复的新调用 |
| P5 | P2 | 批次计数和错误诊断不准确、不够可操作 | 事故排查难以区分未派发、已派发失败、结果未知 |
| P6 | P2 | lease 与 Invocation 结果命名口径不同 | 指标可能把未知副作用误计为确定失败 |
| P7 | P0 | context-only continuation 摘要在 Hosted canonical cutover 时被覆盖 | 用户输入“继续”后模型收不到失败进度和 unknown side effect 事实，像重新规划 |

## 4. 目标与边界

### 4.1 目标

1. 把工具错误作为规范工具结果持久化，并在 Turn 仍满足安全不变量时交给模型继续处理。
2. 把“工具调用已结算”和“外部副作用结果已确定”表示为两个独立事实。
3. 对任何进入 executor 后结果未知的调用都不由 SDK 自动重试；把结果交回模型继续处理。
4. 中断范围最小化：需要停止时停止受影响的操作或调用链；仅安全、授权、History 完整性失效才中断整个 Invocation。
5. 延续现有工具审批、permit、授权版本、取消和历史一致性约束。
6. 用户与日志能够看到失败工具、错误类别、是否已派发、结果是否未知、可执行的恢复动作。

### 4.2 非目标

- 不把 dispatch 后 timeout 自动当成可安全重试。请求可能已到达远端，状态按 unknown 回灌。
- SDK 不对任何 dispatch 后 unknown 自动重试原始调用。
- 不要求 SDK 为实现错误隔离而逐一了解 MCP 工具语义；工具语义盘点只可作为补充验证，不能成为设计依赖或阶段门槛。
- 不把用户明确取消、授权失效、历史写入不确定、安全策略拒绝改成普通工具失败。
- 不依赖工具名称、描述文本或 JSON Schema 推测副作用语义。
- 不声称 SDK 能判断不同 tool-call ID 是否语义重复；不自动重放原始调用，续跑上下文如实提供 unknown 事实。

## 5. 目标失败模型

### 5.1 SDK 通用结算依据

SDK 用自身可观察的执行边界分类，不要求知道工具业务语义，也不要求 MCP 逐一注册恢复策略：

- **executor 尚未进入**：可确定为 `not-dispatched`（只表示 SDK 没有调用 executor）。
- **executor 已进入并返回结构化结果**：按该结果结算为 `succeeded` 或 `failed`。
- **executor 已进入后抛异常、超时或连接中断，且没有结构化终态**：结算为 `unknown-after-dispatch`。executor entry 不证明网络请求已发送；这对所有工具使用同一保守规则，不推断远端效果。

### 5.2 Turn 处置决策表

| SDK 观察到的事件 | 工具调用结算 | 同一 Invocation 是否继续 | SDK 自动重试 |
|---|---|---|---|
| permit / admission 在 executor 进入前拒绝 | `not-dispatched` 或现有拒绝结果 | 是，遵循既有拒绝回灌策略 | 否 |
| executor 正常返回成功结果 | `succeeded` | 是 | 否 |
| executor 正常返回结构化失败结果 | `failed` | 是 | 否 |
| executor 进入后抛异常、timeout 或连接中断，未返回终态，且 Invocation 生命周期有效 | `unknown-after-dispatch` | 是；停止领取同批未派发调用，等待在途 sibling 结算，再把全批结果交给模型 | 否 |
| History / canonical transcript / continuation 关键提交不确定 | 无法安全提供可信工具结果 | 否，Invocation interrupted | 否 |
| permit、授权版本或执行准入不变量被破坏 | 依安全故障路径处理 | 否或按既有安全策略拒绝 | 否 |
| 用户取消、Invocation 超时、撤权或授权失效（包括与工具异常并发） | 工具 outcome 可为 unknown；Invocation disposition 按宿主生命周期终态处理 | 否；完成必要的事实持久化后，不得发起下一次模型请求或新 dispatch | 否 |

该表对内置工具和任意 MCP 工具统一适用。工具适配器可以额外返回更精细的类型，但 SDK 基线不要求逐个工具盘点或依赖这些类型。

### 5.3 Fatal 定义

**Invocation disposition 是与单个工具 outcome 分开的状态。**工具 outcome 描述该调用可确认的执行结果；Invocation disposition 决定当前 Agent 回合是否还能继续。工具异常结算为 unknown，不会自动压过宿主生命周期终态。

宿主生命周期终态优先于“unknown 后继续”：用户取消、Invocation 总时限、撤权或授权失效一旦在结算、下一次模型请求或新 dispatch 边界被确认，Invocation 必须进入对应终态。工具副作用仍可记录为 unknown；在可用的持久化操作完成后立即停止，不得发起下一次模型请求或新 dispatch。只有宿主生命周期仍有效、且没有更高优先级终态时，普通 executor transport 异常才作为 unknown tool result 回灌并继续。

生命周期失效依据必须来自宿主拥有的状态：原始 request signal、执行 lease signal/state，以及可区分取消、总时限、撤权和授权变更的宿主原因。不能只检查原 request signal，也不能仅凭异常名称或错误消息判断。结算 unknown 前、发起下一次模型请求前、领取/进入新的 dispatch 前都要重新检查有效性；撤权可能只中止 lease，工具也可能忽略 abort 后正常返回。

**Invocation fatal 应表示 Agent 无法证明下一步请求仍遵守授权与持久化不变量。**至少包括：

- canonical History 或 transcript 结果提交不确定；
- 准入/授权绑定损坏，或无法确认执行是否越过安全门；
- provider / turn 结构损坏，导致不能构造一致的下一次模型输入；
- 关键宿主投影失败且该投影是继续执行所需的事实来源；
- 明确取消、用户设置的总时限已到，或撤权/授权失效。

普通工具异常、MCP transport timeout、工具返回非成功状态、只读请求失败属于工具级错误或未知结果；默认不应直接结束整个 Invocation。

## 6. 目标架构方案

### 6.1 统一 SDK 生命周期合同

基础错误处理只依赖 SDK 自身可观察的执行生命周期，不依赖工具名、actionClass 的业务含义、MCP 元数据或完整工具清单：

- `executor` 尚未进入：记为 `not-dispatched`。
- executor 正常返回：保存它返回的成功或失败结果。
- executor 已进入后抛异常、timeout 或连接中断，且没有终态结果：工具 outcome 记为 `unknown-after-dispatch`；仅当宿主生命周期仍有效时，才作为工具结果交回模型。
- 取消、Invocation 总时限、撤权或授权失效优先于 unknown 恢复。工具 outcome 仍可为 unknown，但 Invocation 按生命周期终态结束，禁止下一次模型请求和新 dispatch。
- 生命周期检查读取宿主拥有的 request signal、执行 lease signal/state 和结构化失效原因；在异常结算、下一次模型请求及新 dispatch 边界检查，不只依赖异常名或原始 request signal。
- 普通工具错误不终止 Invocation，SDK 不自动重试原始调用。
- Invocation fatal 仅用于 History/请求结构、授权/准入、安全边界、取消、撤权/授权失效或总时限等核心不变量失效。
- MCP 工具语义盘点最多用于补充验证 SDK 的通用实现；任何通用错误处理、继续执行或验收路径都不得依赖盘点结果。

SDK 无法通用识别不同 tool-call ID、不同参数或 alias 是否代表同一业务操作。方案只保证 SDK 不自动重放已结算的原始调用，并确保续跑能看到上一调用状态；语义级去重和 exactly-once 不在本通用方案的承诺范围内。

### 6.2 统一 executor 结果信封

将“正常返回结构化失败”与“抛出 JavaScript 异常”收口到统一结果类型。建议的逻辑字段：

```ts
type ToolExecutionOutcome =
  | { kind: 'succeeded'; result: ToolResult; executorEntry: ExecutorEntryState }
  | { kind: 'failed'; result: ToolErrorResult; executorEntry: ExecutorEntryState }
  | {
      kind: 'unknown'
      result: ToolErrorResult
      executorEntry: 'entered' | 'unknown'
      automaticRetry: false
    }

type ExecutorEntryState = 'not-entered' | 'entered' | 'unknown'

type InvocationDisposition =
  | { kind: 'active' }
  | { kind: 'cancelled'; source: 'request' | 'lease' }
  | { kind: 'timed-out'; source: 'invocation' }
  | { kind: 'authorization-invalidated'; reason: 'revoked' | 'changed' }
  | { kind: 'interrupted'; reason: string }
```

要求：

- SDK 记录原始 error code（若可取得）和三态 `executorEntry`；网络发送阶段不是 SDK 基线要求，也不从 executor entry 推断。
- 只有执行路径明确记录 executor 尚未进入，才能标记 `not-entered` / `not-dispatched`。entry 证据缺失表示 `unknown`，不得补成 false。
- executor 进入并被当前进程观察到后可记 `entered`；崩溃恢复遇到 started-only 记录时记 `unknown`，不能根据 started 事件推断 entry。
- outcome 与 Invocation disposition 分开持久化。工具 outcome 可以是 unknown，同时 Invocation disposition 为 cancelled、timed-out 或 authorization-invalidated。
- dispatch 后收到普通 transport error 时，不能单凭 “timeout” 宣称远端未执行。
- SDK 根据 executor 进入边界将未结构化的 throw 统一结算为 unknown tool result；适配器不需要提供工具特定分类。
- 兼容既有工具返回值：先将结果信封作为内部契约适配，再分阶段迁移内置工具和 MCP。

### 6.3 按调用结算并继续 Turn

Turn loop 调整为：

1. executor 返回已知失败结果时，提交完整的失败 tool result，包含错误类别和模型可读信息。
2. executor 进入后抛异常且没有终态结果时，提交 `executionOutcome: 'unknown-after-dispatch'`、`executorEntry: 'entered'`（仅限当前进程确实观察到 entry）和模型可读错误；不把它改写成 success 或 known failure。
3. `returnDeniedToolsToModel` 继续控制安全拒绝回灌，不控制普通执行错误是否能作为工具结果回灌。
4. SDK 不自动重试原调用。结果持久化后，模型可以在看到完整事实的基础上继续规划；已有授权、审批和 resource lock 规则仍然生效。
5. 任意工具出现 dispatch 后 unknown 时，停止领取同批尚未派发的调用，逐条落 `tool-call-not-dispatched`；在途 sibling 继续结算并保存真实结果。收齐本批结果后将全批事实交给模型。
6. 每次结算及任何后续模型请求/新 dispatch 前，先检查宿主生命周期 disposition。若取消、总时限、撤权或授权失效已生效，保留工具 outcome（可为 unknown），按对应生命周期终态结束，禁止后续模型请求和新 dispatch。
7. 只有第 5.3 节列出的 Invocation fatal 事件才从 turn loop 向上抛；普通 transport 异常只有在生命周期仍有效时才回灌并继续。

### 6.4 History、checkpoint 与自动重放边界

History 对每个 tool call 记录统一的执行事实：

```ts
{
  executionOutcome: 'succeeded' | 'known-failure' | 'unknown' | 'not-dispatched',
  executorEntry: 'not-entered' | 'entered' | 'unknown',
  invocationDisposition?: 'active' | 'cancelled' | 'timed-out' | 'authorization-invalidated' | 'interrupted',
  errorCode?: string
}
```

要求：

- `tool-call-started` 与终态事件按 `toolCallId` 配对。executor 进入后异常的调用写为 `unknown-after-dispatch`，不能伪装成成功或确定失败。
- `executionOutcome: 'unknown'` 表示工具效果无法确认；`executorEntry: 'unknown'` 表示没有可靠 entry 证据（例如 started-only 崩溃记录）。二者是不同字段，可分别独立取值。只有实际观察到 entry 才写 `entered`，只有可靠观察到 entry 前拒绝才写 `not-entered`。
- started 提交后、entry 标记前崩溃，以及 entry 标记后、终态写入前崩溃，恢复时均不得把旧记录补成确定的 `entered` 或 `not-entered`；保守禁止该原始调用 checkpoint replay。明确持久化的 pre-entry rejection 仍可记为 `not-entered`。
- UI、计数器和摘要不得把 `executorEntry: 'unknown'` 计作已确认 executor entry。
- Invocation disposition 记录宿主生命周期终态及来源，不能被工具的 unknown outcome 覆盖。检测到生命周期失效时，保存可确认事实后不再请求模型或派发新工具。
- tool result 已持久化后，模型下一轮能看到该结果。若 History / transcript 终态写入失败或不确定，仍走 Invocation fatal，不能把未持久化结果交给模型。
- checkpoint resume 不重放已有 `tool-call-started`、但没有终态事件的原始调用；改走 context fallback 时必须把源调用、已成功 sibling、unknown 错误和未派发调用带入最终模型请求。
- 同一 Invocation 内，出现 dispatch 后 unknown 时停止领取同批尚未派发的工具调用，等待已启动 sibling 结算，再把整批事实交给模型。SDK 不自动重试任何原调用。
- 普通“继续”以新用户请求进入时，续跑上下文要明确提示上一调用可能已执行。已有工具审批/确认规则继续生效。
- 对不同 tool-call ID、参数略有变化或 alias 后的调用，SDK 不宣称已识别语义重复。需要语义级阻断、服务端幂等或按工具核验时，另行实现工具专用能力并单独评审；不能把它列为通用 SDK timeout 隔离的验收前提。

### 6.5 调度与诊断字段

- 将 `attemptedCount` 改名或补充更精确的计数：`claimedCount`、`executorEnteredCount`（只计确认 entered）、`entryUnknownCount`、`succeededCount`、`knownFailedCount`、`unknownCount`、`notDispatchedCount`。
- 保留“fatal 时停止启动新工作”的能力，但输入应为明确的 Invocation fatal / 当前操作风险规则，不使用泛化 rejection 布尔值。
- `dispatch_failure_context` 追加结构化 `errorCode`、`executionOutcome`、三态 `executorEntry`、`invocationDisposition` 与 continuation mode；原始消息限制长度并脱敏。
- 更新 turn_end 与 agent logger 指标，使工具级 timeout 和 Invocation fatal 分开统计。

### 6.6 用户可见恢复提示

通过本地化 message key 渲染恢复说明，不把实现细节暴露到产品文案：

- 工具执行结果未知：明确“调用可能已经执行，系统没有自动重试”，展示调用名、executor entry 状态和错误信息。
- 整轮因 History/授权完整性问题中断：说明当前执行无法安全续接，并提供已持久化检查点信息。
- 用户不应只看到通用“回复未能完成”，诊断详情仍可折叠展示。

敏感参数按工具级白名单、统一脱敏规则处理。桌面 UI 与 IM lane 使用同一错误分类语义；不支持交互恢复的 lane 至少返回明确错误类型和恢复建议。

### 6.7 continuation 补充上下文必须穿过最终请求组装

失败 Turn 的工具进度不属于普通已提交对话 transcript；它是与某个 source Invocation/History checkpoint 绑定的 supplemental context。必须在 Hosted handoff 完成 canonical transcript 选择之后，再将该上下文并入最终模型请求，不能只在 `claudeStreamHandlers` 的 `builtMessages` 上追加后假设它会保留。

建议把摘要作为显式 handoff 字段传递，至少包含 `sourceInvocationId`、`sourceTurnId`、`historySequence`、状态（known/unknown）、结构化事实和内容上限。handoff 先组装“系统提示 + canonical session transcript + 当前 required user”，再将 supplemental context 放入单独、明确标识的请求上下文位置。不要伪装成持久化用户原话，也不要把它写入普通 session transcript；失败 transcript commit 只应提交到当前用户输入边界。

需要同时保证：

- 每一种 canonical cutover 分支（已有 transcript、History 回退、重启输入恢复、track-scoped request）都明确规定 supplemental continuation context 是否适用，不能静默丢弃。
- supplemental context 不改变 required-user 的 ID/正文匹配，也不重复当前用户消息。
- 传给模型的恢复事实包含原始调用可能已执行、SDK 没有自动重试、成功 sibling 和未派发调用等信息；不声称能够阻止模型提出语义相同的新调用。
- 记录 continuation mode：`checkpoint-resume` 或 `context-fallback`；fallback 带结构化 reason code（本案为 `UNKNOWN_SIDE_EFFECT`）。日志/状态可供诊断，但不泄露原始 MCP 参数。
- UI 或对应的回合状态能区分“从 checkpoint 续跑”和“带失败摘要启动新 Turn”，让用户知道为什么后续模型重新规划。

## 7. 分阶段实施计划

### 阶段 A：定稿 SDK 通用合同

**交付**

- 定义只依赖 SDK 执行生命周期的统一结果：`not-dispatched`、成功、已知失败、`unknown-after-dispatch`。
- 划定 Invocation fatal 的闭合范围：History/请求结构、授权/准入、安全、取消和总时限等核心不变量。
- 明确任何 executor 进入后未返回终态的异常都作为单个 tool result 结算；不由工具名称或 MCP 语义决定是否结束 Turn。
- 明确 outcome 与 Invocation disposition 分离：取消、总时限、撤权和授权失效优先于普通 unknown 恢复；用 request/lease/宿主生命周期状态识别，并在结算、模型请求及 dispatch 边界检查。
- 将 executor entry 定义为 `not-entered | entered | unknown`；started-only 崩溃历史不得虚构 entry 事实，且仍禁止原始调用 checkpoint replay。
- 明确 SDK 不自动重试原始 tool call；SDK 不承诺语义相同但 ID 不同的调用可被通用识别。
- 更新相关接口文档中将所有 executor throw 描述为统一 Invocation fatal 的内容。

**完成门槛**

- 状态转换仅依赖 SDK 能观察到的 executor entry、返回值、异常和持久化结果。
- synthetic executor 覆盖 dispatch 前失败、进入后抛错、结构化失败、成功返回四种路径；并覆盖 request 与 lease 的生命周期竞态。
- 生命周期矩阵覆盖 executor throw 与撤权并发、executor 忽略 abort 后正常返回、lease-only 授权变更、Invocation timeout 与工具 timeout 同时发生；这些情况均不得进入下一次模型请求。
- 不需要 MCP 工具清单、工具语义 metadata 或服务端能力即可通过合同测试。

### 阶段 B：SDK 执行结果结算

**可能触及**

- `packages/agent-sdk/src/toolExecutionPort.ts`
- `packages/agent-sdk/src/executionAdmission.ts`
- `packages/agent-sdk/src/turn.ts`
- `electron/tools/registeredAgentTurnTools.ts`
- `electron/mcp/registeredMcpTool.ts`

**工作**

- 在统一的 executor entry 边界区分未派发与 dispatch 后未知结果。
- 让宿主生命周期 disposition 可被 SDK 结构化读取，至少合并 request signal、lease signal/state 及取消/总时限/撤权/授权变更原因；在异常结算和后续模型请求/dispatch 前统一检查优先级。
- 当宿主生命周期失效与 executor 异常或正常返回并发时，保存工具 outcome（可为 unknown）及生命周期终态，后者优先并禁止继续。
- 将 dispatch 后未结构化异常转换为规范 tool error result；移除 `actionClass` 对错误是否升级为 Invocation fatal 的决定权。
- 保留 `actionClass` 和现有安全、授权、审批用途，不让该分类决定普通执行错误的严重程度。
- 只有明确的宿主安全/持久化错误继续走 Invocation fatal；executor throw 本身作为工具结果。

**完成门槛**

- 未进入 executor 的错误记录为 `not-dispatched`；进入后 throw 记录为 `unknown-after-dispatch`。
- 生命周期矩阵全部通过：throw 与撤权并发、忽略 abort 后正常返回、lease-only 授权变更、Invocation timeout 与工具 timeout 并发。生命周期已失效时不发生下一次模型请求或新 dispatch；生命周期有效时相同 transport 异常仍可作为工具结果继续。
- 任意未注册特殊语义的 MCP 工具也走相同路径。
- 工具结果持久化失败时不向模型报告未持久化的结果，并保留既有 fatal 行为。

### 阶段 C：批次结算与 Turn 连续性

**可能触及**

- `packages/agent-sdk/src/turn.ts`
- `packages/agent-sdk/src/history.ts`
- `electron/runtime/hostedAgentTurnHost.ts`

**工作**

- dispatch 后 unknown 不终止 Invocation；停止领取同批尚未派发调用，等待在途 sibling 完成，并持久化成功、失败、unknown 和 not-dispatched 结果。
- 按模型要求的原始 tool-call 顺序将完整批次结果交回模型，让模型在看到失败事实后继续规划。
- 禁止 SDK 对原始调用做自动重试；不依赖只读/写入或幂等分类。
- 保持已有并发上限、取消、permit 和 resource lock 行为。

**完成门槛**

- 在“并发上限 2、提出 4 个调用、1 个成功、1 个 dispatch 后异常、2 个尚未派发”的合成场景中，Invocation 继续，4 个槽位都有正确结算。
- 已启动 sibling 的真实结果保留；未派发槽位不进入 executor。
- 下一次模型请求包含本批工具结果，SDK 没有自动重发失败调用。

### 阶段 D：History 与 continuation 上下文

**可能触及**

- `packages/agent-sdk/src/history.ts`
- `electron/runtime/sqliteAgentHistory.ts`
- `electron/runtime/agentContinuation.ts`
- `electron/runtime/continuationSummary.ts`
- `electron/sessionStorage/continuationSources.ts`
- `electron/runtime/hostedTurnHandoff.ts`

**工作**

- 让 History 明确表达 tool call 的执行结果、三态 executor entry 和 Invocation disposition；不从 `started` 推断 executor entry 或远端已执行/未执行。
- 定义旧记录和崩溃窗口映射：started-only 为 `executorEntry: 'unknown'`；可靠持久化的 pre-entry rejection 才是 `not-entered`；entry 后异常记录 `entered` 仅限当前进程确实观察到 entry。
- 对 started-without-finished 的原始 tool call 禁止 checkpoint 原位重放，转为携带事实的 context fallback。
- 修复 Hosted canonical transcript cutover 丢失 supplemental context 的问题，确保“继续”请求包含源 Invocation、工具错误、已完成进度和未派发调用。
- 将续跑模式和 fallback reason 结构化记录；上下文不伪装成普通用户原话，不泄露敏感参数。

**完成门槛**

- History 崩溃/append 故障下不生成虚假成功，不把未持久化结果回灌模型。
- 注入 started 提交后、entry 标记前崩溃，以及 entry 标记后、终态写入前崩溃；均不虚构确定 entry。验证旧 History 缺少 entry metadata 的兼容映射及 pre-entry rejection 的准确性；UI、计数、摘要不把 unknown 算作 entered。
- 精确输入“继续”时，最终 Hosted 请求含有失败 Turn 摘要和此前工具进度；所有 canonical cutover 分支均不丢弃 supplemental context。
- 旧 started-only History 不会触发原始 tool call 的自动 checkpoint replay。

### 阶段 E：诊断、回归与补充验证

**可能触及**

- `electron/runtime/agentSdkDesktopObserver.ts`
- `electron/runtime/invocationAssembler.ts`
- `electron/claudeStreamHandlers.ts`
- agentLogger 类型与字段白名单
- `src/renderer` 中工具错误和 failed assistant 展示
- 对应 i18n 资源

**工作**

- 展示统一的错误类别、工具名、executor 是否进入、结果是否 unknown，以及 Invocation 是否继续。
- 统一桌面 UI 与 IM lane 的错误结算语义；不支持交互的 lane 返回明确错误类别和恢复事实。
- 以 SDK 合成测试和 History/continuation 故障注入作为验收。
- 增加生命周期竞态故障注入：request cancel、lease-only revocation/authorization change、Invocation timeout 与工具异常/正常返回并发；失效时不发生后续模型请求或新 dispatch。
- 可选地用少量实际 MCP 工具做兼容性抽查，例如本案的状态查询；这只是补充验证，不形成逐工具策略、实现前置条件或阶段门槛。

**完成门槛**

- 通用 SDK 测试、History 持久化故障测试、批次结算测试和 continuation 最终请求测试全部通过。
- 生命周期优先级与 entry 三态的竞态、崩溃窗口验收全部通过；生命周期已失效时禁止继续，而普通 transport unknown 且生命周期有效时仍可继续。
- 日志和 UI 的 dispatch/outcome/fatal 字段一致并完成脱敏。
- MCP 语义盘点和代表性工具抽查不作为门槛；发现的问题只有在暴露 SDK 通用路径缺陷时才进入本方案修复。

## 8. 安全与可靠性不变量

1. 未取得工具结果时，不生成成功的 `tool-call-finished`。
2. 只有可靠观察到 executor 未进入时才记 `not-entered`；可靠观察到进入才记 `entered`；证据缺失（包括 started-only 崩溃记录）记 `unknown`。
3. executor 进入后异常且无终态可记为 `unknown-after-dispatch`；这与 executor entry 三态是分开的事实。
4. dispatch 后 unknown 本身不终止 Invocation，也不被写成远端确定失败或成功；仅当宿主生命周期仍有效时才继续。
5. 取消、Invocation 总时限、撤权或授权失效优先于工具 outcome。即使工具 outcome 为 unknown，Invocation 也必须按对应终态结束，并禁止下一次模型请求和新 dispatch。
6. 生命周期优先级依据宿主 request/lease 状态及结构化原因；在异常结算、下一次模型请求和新 dispatch 边界检查，不以异常名称代替。
7. SDK 不自动重试已派发的原始 tool call。
8. SDK 不声称能够通用识别不同 tool-call ID 下的语义重复操作；不为此要求完整工具清单或工具元数据。
9. History / transcript 未能持久化工具结果时，不向模型报告该结果，仍按 Invocation fatal 处理。
10. dispatch 后 unknown 出现时，停止领取同批未派发调用；已启动 sibling 按真实结果结算。
11. 工具错误回灌不得跳过既有 permit、authorization version、resource lock、工具确认和安全拒绝流程。
12. continuation 必须携带上一轮已知进度和 unknown 事实；上下文提示提供证据，不被描述成语义级防重放保证。
13. 模型轮次和工具轮次仍有硬上限；SDK 不因自动 retry 形成循环。
14. MCP 服务端是否支持操作查询、去重或幂等与通用 SDK 错误隔离无关，不作为实现和验收依赖。

## 9. 回归测试矩阵

### 9.1 SDK 通用执行边界

- synthetic tool 在 executor entry 前失败：记录 `not-dispatched`，不伪造调用结果。
- 无任何特殊 metadata 的任意命名 tool 在 entry 后 throw/timeout：记录 `unknown-after-dispatch`，回灌模型，Invocation 保持可继续。
- executor 正常返回成功或结构化失败：分别按返回值结算，不依赖 `actionClass` 决定 fatal。
- executor entry 后 throw 时，SDK 不自动重新调用该 executor。
- started 提交后、entry 标记前崩溃，以及 entry 标记后、终态写入前崩溃，恢复后的 `executorEntry` 均为 `unknown`；不得把 started-only 记录计作 entered 或 not-entered。
- 旧 History 缺少 entry metadata 时映射为 `unknown`；可靠记录的 pre-entry rejection 仍映射为 `not-entered`。
- executor throw 与撤权并发、executor 忽略 abort 后正常返回、lease-only 授权变更、Invocation timeout 与工具 timeout 同时发生：都不得发起下一次模型请求或新 dispatch。
- 同一种 executor transport 异常在 request 和 lease 均有效时仍作为 unknown tool result 继续回灌。
- 模型提出 4 个调用、并发上限 2：1 个成功、1 个 entry 后异常、2 个未派发；4 个槽位均正确结算并进入下一次模型输入。
- dispatch 后 unknown 后停止领取同批余下调用；在途 sibling 不取消、不伪造结果。
- History/tool result append 失败：不回灌未持久化结果，Invocation 走 fatal 路径。
- cancel、turn timeout、authorization revoke、pre-dispatch permit rejection 保持各自既有终态。
- 多个并行异常的记录与归因确定，不虚构先后顺序。

### 9.2 History 与 continuation

- unknown outcome 与 assistant tool-call 按原 ID 配对，重建顺序稳定。
- started-without-finished 的原始调用不通过 checkpoint resume 自动重放。
- context fallback 将源 Invocation、成功 sibling、工具异常、unknown 状态和 not-dispatched 槽位送达最终 Hosted 请求。
- canonical transcript cutover 的各分支均保留 supplemental context，普通 transcript commit 不把摘要写成用户原话。
- History 投影修复不会把 unknown 改写为成功或确定失败。
- fallback reason `UNKNOWN_SIDE_EFFECT` 和 continuation mode 被正确记录。

### 9.3 产品诊断

- UI 区分“工具执行失败/结果未知”与“Invocation 因 History、授权或安全不变量中断”。
- 诊断包含工具名、error code、executor entry 状态、outcome 和 Invocation 处置，不暴露原始敏感参数。
- 计数区分 model proposals、executor entries、known failures、unknown outcomes、not-dispatched calls。
- i18n、日志字段类型和敏感字段脱敏检查通过。

## 10. 验收标准

- SDK 不需要工具逐项语义配置，就能对任意 executor 使用一致的 pre-entry / post-entry 错误分类。
- executor entry 后的普通 throw/timeout 成为 unknown tool result，不会单独导致整个 Invocation interrupted。
- SDK 不自动 retry 原调用；成功、失败、unknown、未派发槽位按批次完整结算并回灌。
- 取消、Invocation 总时限、撤权或授权失效优先于工具 outcome；生命周期失效后不得发起下一次模型请求或新 dispatch。
- History/请求结构或授权/安全等核心不变量失效时走 Invocation fatal。
- “继续”请求的最终模型输入包含上轮工具结果、进度、错误、unknown 与未派发事实。
- started-without-finished 的原始调用不会被 checkpoint 机械重放；context fallback 不丢失其状态。
- started-only 和两种崩溃窗口都将 entry 保持为 unknown；旧记录与 UI/计数/摘要均不虚构 entered/not-entered。
- 通用 SDK、批次、History、continuation、取消及故障注入用例全部通过。
- 不将语义级去重、服务端 operation key、状态查询、逐 MCP 清点或代表性 MCP 通过率设为本方案的验收条件。

## 11. 监控与上线

统一输出每个 completed/failed Turn 的 `tools.execution_summary` 结构化诊断，字段包含模型提案数、确认进入 executor 数、已知失败数、unknown 结果数及未派发数。日志不包含工具输入或原始参数；现有 dispatch-stop/error 诊断继续保留。日志平台可在采集层聚合为跨会话指标。

先在内部/灰度环境开启 SDK 通用错误隔离，观察同一 Invocation 继续率、unknown 结果比例、批次结果完整率、重复失败循环和 History fatal 率。按工具名切分仅用于诊断，不配置不同的通用错误路径。

在合成执行器、真实 MCP transport 的通用适配层、批次结算、History 故障注入和最终 continuation 请求验收通过后，统一开放 SDK 通用逻辑。个别 MCP 工具的语义抽查可以补充信心，但不能阻塞或改变通用路径。

## 12. 建议实施顺序

按 A → B → C → D → E 推进：先定 SDK 生命周期与 fatal 合同，再实现通用结果结算；随后让批次在工具错误后完整结算并继续 Invocation；然后修复 History 和 Hosted continuation 上下文；最后完善诊断并做通用故障注入验收。

验收以 SDK 合成执行器和通用生命周期路径为主。具体 MCP 的语义盘点只能作为补充验证，不能成为实现前置条件、阶段门槛或不同错误处理分支的依据。该方案不要求第三方 MCP 服务端配合，也不承诺任意第三方操作的 exactly-once 或语义级去重。

## 13. 实施进度（2026-10-14）

- [x] 已在独立 worktree `codex/mcp-timeout-turn-isolation` 建立隔离开发分支；本计划文档随分支纳入。
- [x] 阶段 A：接口文档和 SDK lifecycle boundary 已实现。合成回归覆盖 executor throw 与撤权、忽略 abort 后正常返回、lease-only 授权变更、Invocation timeout 与工具错误并发；四类失效均验证没有下一次模型请求。
- [x] 阶段 B：executor entry 后未结构化异常统一结算为 `unknown-after-dispatch`；生命周期 disposition 独立记录并优先终止 Invocation；History 写入失败仍不回灌未持久化结果。
- [x] 阶段 C：dispatch 后 unknown 停止领取同批新槽位、等待在途 sibling，按提案顺序结算全部槽位并回灌；并发上限 2、4 个提案的精确场景通过，SDK 不自动重试原调用。
- [x] 阶段 D：started 事件显式记 `executorEntry: unknown`；旧 started-only History 映射为 unknown 并被拒绝 checkpoint replay；History append 失败不回灌未持久化结果；started-only 两种 crash-window 记录均作为 unknown 恢复。checkpoint、重启恢复、Track-scoped、既有 canonical History 与无前序 History 分支都验证了 supplemental context 进入最终 Hosted 请求且不进入普通 transcript。
- [x] 阶段 E：桌面诊断包含 errorCode、outcome、executor entry 和 invocation disposition；每回合汇总提案数、executor entry、已知失败、unknown 与未派发数，汇总不包含工具参数；桌面与 IM 调用方统一 unknown 语义，UI/i18n 提示已更新。
- 定向验证（2026-10-14）：SDK Turn 与执行租约用例 154/154 通过；History/continuation 当前 95 项通过；observer 21/21、日志脱敏投影 30/30、Invocation assembler 68/68 通过；Hosted 集成核心文件 120/120、butler 调用方 51/51 通过；跨 SDK、Hosted、MCP、IM 调用方集合此前 409/409 通过。renderer、shared、agent-sdk、Electron 类型检查全部通过；`node --import tsx scripts/i18n-check.ts` 通过（1297 个硬编码中文仅在测试中）；`git diff --check` 通过。
- 全量验证（2026-10-14，计数诊断实现前）：`npm test -- --reporter=json` 执行 2676 个测试文件、9756 项测试：9604 通过、41 失败、111 跳过，0 个 unhandled error。失败限于本地网络监听受限的 MCP HTTP/OAuth/IPC 测试（`STACK_TRACE_ERROR`）及真实 detached 进程清理测试（观察结果为 `unverified`）；未见本次功能相关回归。之后新增计数诊断已由 Hosted 120 项和 observer 21 项定向测试验证；全量应在允许本机回环网络和进程组信号的环境重跑。
