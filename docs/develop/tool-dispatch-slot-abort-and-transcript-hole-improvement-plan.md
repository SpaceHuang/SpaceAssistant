# 工具并发派发缺陷：单点拒绝作废队列 + 稀疏空洞污染会话历史——诊断与改进方案

> 文档日期：2026-10-02
> 文档性质：问题分析与改进方案，本次不含代码实现
> 状态：**按 v3 阻断评审修订，待复审**——最新评审报告：[`2026-10-02-tool-dispatch-slot-abort-and-transcript-hole-plan-review-v3.md`](../review/2026-10-02-tool-dispatch-slot-abort-and-transcript-hole-plan-review-v3.md)；v3 修订前的 v2 评审依据见 [`2026-10-02-tool-dispatch-slot-abort-and-transcript-hole-plan-review.md`](../review/2026-10-02-tool-dispatch-slot-abort-and-transcript-hole-plan-review.md)。
> 触发案例：会话 `f659b1db-51f7-4f75-82b2-5fb90afef9a3`（「会话 39」）Turn `d61501aa-830c-4fe7-be78-a9d2397450c5`，2026-10-02 12:03–12:04（本地，UTC+8）
> 用户可见表现：「回复未能完成。你可以重试生成，或基于已有上下文继续对话。失败原因 Cannot read properties of undefined (reading 'role')」
> 证据来源：
> - 运行日志 `.agent/logs/Agent-20261002.log`（544 / 547 / 550–552 行）
> - 会话事件流 `sessions/f659b1db-51f7-4f75-82b2-5fb90afef9a3-20261002/events.jsonl`（103740 条事件，末段为该 Turn）
> - 代码：`packages/agent-sdk/src/turn.ts`、`electron/runtime/agentSdkDesktopObserver.ts`、`electron/runtime/hostedAgentTurnHost.ts`、`electron/confirmation/agentSdkSafetyPolicy.ts`、`electron/runtime/desktopAgentRuntime.ts`
> 关联文档：[`tool-error-recovery-and-turn-continuity-plan.md`](tool-error-recovery-and-turn-continuity-plan.md)（设计原则同源——「工具错误首先是模型输入」；该方案处理宿主侧错误计数与 Turn 恢复，本方案处理 agent-sdk 同批并行派发层的两个缺陷，可视为该原则在并发维度上的落实）；最新评审报告见 `docs/review/2026-10-02-tool-dispatch-slot-abort-and-transcript-hole-plan-review-v3.md`
>
> 修订记录：
> - **v2（2026-10-02）**：按评审报告落实 P2-1（§5.1 物化复用 `turn.ts:1442` 既有理由码判定，删除 `NOT_ATTEMPTED_AFTER_SIBLING_STOP`，修正「关键次序」论证）、P2-2（§7.1 不变量 3 改写为「至少一种 + 至多一条」）、P2-3（§5.2 补全 8 处抛出点清单 + 新增 §5.4 用户显式拒绝权衡与批次去重缓解）、P2-4（§4.1/§5.2 补充回注关闭路径执行面说明，§8 增加既有用例排查项）、P3-2/3/4（回归命令精简、P1-C 落点标注 SDK 投影来源、不变量测试改用内存 History）。P3-1（`turn.ts:599` 实为 600）经 `sed -n '598,601p'` 复核**不成立**——598 行为 `requestObservation` 赋值、599 行即 `prepareModelRequest` 调用——维持原文。
> - v1（2026-10-02 初稿）
> - **v3（2026-10-02）**：按阻断评审修订 P0-B 的并发语义。拒绝 worker 不再立即补领队列：批内仍有已领取调用未结算时进入 drain 状态，禁止启动新的工具；待所有在途结果确定后，若没有非拒绝类致命 rejection，再恢复派发未领取项。这样混合批中在途致命故障可先被观察到，后续排队工具保持未派发。更新 §4.1、§5.2、§6、§7、§8 的时序、边界及验收；修正错误地声称 `:2103-2138` 保持原行为的内容。

---

## 1. 结论摘要

一次用户可感知的 Turn 失败，背后是 agent-sdk 工具派发层两个相互独立的缺陷叠加：

| # | 缺陷 | 位置 | 后果 |
|---|---|---|---|
| 一 | **队列作废**：同批工具中任意一个调用被拒/失败，`mapWithConcurrency` 置 `stopped = true`，队列中尚未开始的兄弟调用全部作废，不做任何尝试，也不留任何记录 | `packages/agent-sdk/src/turn.ts:1539-1557` | 模型发起的兄弟调用被静默丢弃（本次 6 个 `edit_file` 损失 4 个）；且不区分「每调用级结果」与「Turn 级致命故障」 |
| 二 | **历史空洞**：作废的调用在结果数组中留下稀疏空洞，空洞穿透下游三层防御，最终在写回消息历史时被展开迭代器物化为 `undefined` 混入 transcript | `turn.ts:1448-1450`（push 处） | 下一轮组装模型请求时在 `agentSdkDesktopObserver.ts:94` 读 `undefined.role` 崩溃，整个 Turn 以 `HostedTurnFinalizedError` 终止 |

两个缺陷同源于一个布尔标志 `stopped`：它既承担了「致命故障后停止派发」的合理职责，又把「审批拒绝」这类每调用级正常结果一票否决；而停止后的数组空洞没有任何一处兜底物化。

## 2. 故障还原（实证）

### 2.1 时间线

会话 39，模型 `deepseek-flash`（`https://api.deepseek.com/anthropic`），桌面 lane。日志时间均为 UTC（本地 = UTC+8）：

| 时间（UTC） | 事件 | 证据 |
|---|---|---|
| 04:03:21.844 | Turn 启动，历史经 `tool.result.pairing.repaired` 修复（24→17 条，`roleAlternationFixed: 7`） | 日志 544 行 |
| 04:03:21.919 | `llm.request`，requestId `f371b5df`，loopRound 1 | 日志 547 行 |
| 04:03:40 / 04:04:20 | 第 1、2 轮模型请求正常完成（`mcp.deferred_savings` modelTurn 1/2） | 日志 550–551 行 |
| 04:03:49 | 第 1 轮响应：2 个 `read_file`，全部成功 | 事件流 tool_call/tool_result |
| 04:04:32.992–33.025 | 第 2 轮响应：**一次性 6 个并发 `edit_file`**（call_00…call_05），目标同一文件 `docs/develop/session-storage-refactor-technical-design.md` | 事件流 tool_call ×6 |
| 04:04:33.695 | call_01（槽位 1）自动批准执行成功（`autoApprovedWrite`，bytesWritten 46119） | 事件流 + `file.auto_approve` 日志 |
| 04:04:33.923 | call_00（槽位 0）被网关拒绝：`Tool call was not dispatched (POLICY_DENY).`（`agentSdkSafetyPolicy.ts:124`） | 事件流 tool_result |
| 04:04:33.923 之后 | **call_02…call_05 从未被尝试，无任何结果事件** | 事件流无对应 tool_result |
| 04:04:35.469 | `llm.error`：`Cannot read properties of undefined (reading 'role')`，包成 `HostedTurnFinalizedError` | 日志 552 行 |

### 2.2 崩溃时 transcript 的实际状态

按 `turn.ts` 的组装顺序，第 3 轮请求的 `messages` 末段为：

```
[..., assistant(toolCalls=[call_00, call_01, call_02, call_03, call_04, call_05]),
  tool(call_00, "Tool call was not dispatched (POLICY_DENY).", isError=true),   ← 被拒回注
  tool(call_01, <edit 成功结果>),                                                ← 正常结果
  undefined, undefined, undefined, undefined]                                   ← call_02…05 的空洞物化
```

### 2.3 堆栈与编译产物对齐

安装版（app.asar）堆栈顶帧为 `runAgentTurnLoop (turn.js:470:103)` → `prepareModelRequest (agentSdkDesktopObserver.js:316)` → `Array.filter` 内读 `role`。与本仓库编译产物逐行核对：

- `dist-electron/packages/agent-sdk/src/turn.js:470` 恰为 `await input.observer?.prepareModelRequest?.(requestObservation)`（源码 `turn.ts:599`；v2 经 `sed -n '598,601p'` 复核确认，评审 P3-1 的「实为 600」不成立）；
- `electron/runtime/agentSdkDesktopObserver.ts:94` 的 `request.request.messages.filter((message) => message.role === 'system')` 是唯一在此路径上读 `role` 的 filter。

结论：崩溃点、崩溃时机（第 3 轮请求组装）、崩溃原因（messages 含 4 个 `undefined`）三者互相印证。

## 3. 根因分析

### 3.1 缺陷一：`stopped` 一票否决，队列作废

`turn.ts:1539-1557`：

```ts
const worker = async () => {
  while (!stopped) {
    const index = nextIndex++
    if (index >= items.length) return
    try {
      results[index] = { status: 'fulfilled', value: await run(items[index]!, index) }
    } catch (reason) {
      results[index] = { status: 'rejected', reason }
      stopped = true                    // ← 任意失败 → 剩余队列全部作废
    }
  }
}
```

问题不在并发上限本身（排队等补位是正常语义；上限 2 来自 `desktopAgentRuntime.ts:70` 硬编码，经 `invocationAssembler.ts:1078` 注入，是 Turn 内信号量，跨会话/跨 Turn 互不共享）。问题在于 `stopped` 对所有 rejection 一视同仁，同时缺少拒绝与在途调用之间的协调：

- **审批拒绝（`ToolDeniedError`）**：`turn.ts` 内共 **8 处** `throw new ToolDeniedError`，覆盖安全网关 deny、确认必需/确认拒绝（含用户显式拒绝）、`PREPARED_CALL_MISMATCH`、`STALE_AUTHORIZATION`、recheck 失败、执行器拒收等（完整清单见 §5.2）。这些是**每调用级结果**——网关明确拒绝的是「这一个调用」，不是这一批；且桌面 lane 开启了 `returnDeniedToolsToModel: true`（`hostedAgentTurnHost.ts:171`），设计意图就是「拒绝是正常结果，回注给模型，Turn 继续」。用拒绝去作废兄弟队列，与该设计意图直接矛盾。
- **Turn 级致命故障**（取消/超时、`AgentTurnHistoryAppendError`、`ToolExecutionAfterDispatchError` 等）：停止派发是合理的——Turn 已无法继续。

触发本次事故的正是第一类：并发 2，槽位 0（call_00）被拒置 `stopped`，槽位 1（call_01）在途跑完，槽位 2–5 **从未被领取**，成为 `new Array(6)` 中的稀疏空洞。

### 3.2 缺陷二：稀疏空洞穿透防御，物化为 `undefined`

settledTools 结算段的下游代码（`turn.ts:1417-1450`）有三处对空洞的「防御」，但全部失效：

| 行号 | 代码 | 为什么拦不住 |
|---|---|---|
| 1417–1431 | 被拒工具回注循环，`if (!settled) continue`（1420） | 显式跳过空洞——空洞里的调用因此**既没有 `markNotDispatched` 记录、也没有回注消息** |
| 1433–1437 | `settledTools.filter(...)` 找 rejectedTool | `Array.prototype.filter` 对稀疏数组**不调用**空洞下标的回调，空洞对 filter 不可见 |
| 1448–1450 | `messages.push(...settledTools.map(...))` | `map` 同样跳过空洞、返回同构稀疏数组；但 **展开运算符（迭代器）会把空洞产出为 `undefined`**——4 个 `undefined` 由此进入 `messages` |

这是 JS 稀疏数组的语义组合坑：`filter`/`map`/`forEach` 跳洞（回调不可见），迭代/展开物化洞（`undefined` 可见）。三层「看不见洞」的代码走过之后，洞在最后一刻变成了值——而且是坏值。

随后第 3 轮请求组装时，观察器 `prepareRequestProjection`（`agentSdkDesktopObserver.ts:93-94`）对 `request.request.messages` 逐条读 `.role`，`undefined.role` 抛出 TypeError。由于 `prepareModelRequest` 在 turn 循环中是直接 `await`（`turn.ts:599`）且被宿主按关键投影对待，异常沿 `onHostedTurnHandoff` → `runToolChatSession` → `executeClaudeRequest` 传播，最终以 `HostedTurnFinalizedError` 终止整个 Turn。

### 3.3 两条下游路径的分野（为什么以前没炸）

settledTools 结算后其实有两条出路（`turn.ts:1433-1450`）：

1. **存在非「拒绝回注」类 rejection** → 找出 `rejectedTool`，把所有 pending 工具 `markNotDispatched`（`TURN_STOPPED_BEFORE_DISPATCH` / `REQUEST_CANCELLED`，1440–1443），然后 **throw**——空洞来不及走到 push，Turn 以原始错误结束。**普通工具失败走这条路的痕迹是正确的**（未尝试调用有 not-dispatched 落账），只是有「以偏概全」的行为问题（见 §4.2）。
2. **所有 rejection 都是 `ToolDeniedError` 且开启回注** → 被排除出 `rejectedTools`，**不 throw，直接走到 push**——空洞在此物化为 `undefined`。**只有这条路会炸**，而桌面 lane 恰好常态开启回注。

也就是说：审批拒绝 + 同批有排队调用 + 排队调用未被尝试，三个条件同时满足即崩。第一条不满足（无拒绝）或第三条不满足（拒绝发生在最后一个槽位）时不会崩，这让缺陷长期潜伏。

### 3.4 放大因素

- **并发上限 2**：拒绝发生时最多只有 1 个在途调用能跑完，其余全是待派发——同样 6 个调用，上限越高、作废越少，但任何 ≥1 的上限都会留洞，调大并发不是修复。
- **模型单轮大批量工具调用**：deepseek-flash 本轮一次给出 6 个同文件 `edit_file`。批量编辑是该模型的常见行为，意味着此触发面不是长尾。
- **同轮多个审批类工具**：`edit_file` 属审批候选（`turn.ts:1198-1199`），审批类调用越多，单个被拒的概率与影响面越大。

## 4. 影响评估

### 4.1 触发条件与波及面

- **必要条件**：同一模型轮返回 ≥2 个工具调用，且首个 rejection 落在队列非尾部（并发上限越高越难满足「非尾部」，上限 2 下第 3 个及以后的调用几乎必然是洞）；且该 rejection 为 `ToolDeniedError`（审批拒绝/确认缺失/授权失配），且 lane 开启 `returnDeniedToolsToModel`。
- **波及 lane**：桌面 lane（`hostedAgentTurnHost.ts:171`），含经由该宿主的链路。`returnDeniedToolsToModel` 未开启的路径走 throw 分支，不触发空洞崩溃，但保留 §4.2 的行为问题。
- **P0-B 对回注关闭路径的行为变化（评审 P2-4）**：该路径（SDK 直连/测试用例，已核实所有生产 lane 均经 `invocationAssembler` → `hostedAgentTurnHost` 开启回注）下，拒绝后的补位延迟到当前在途调用全部结算；若无致命故障，未领取工具仍会继续派发，Turn 最终仍按既有规则以拒绝终止。若出现致命故障，则排队工具保持未派发。详见 §5.2。

### 4.2 后果分级

| 路径 | 后果 | 严重度 |
|---|---|---|
| 拒绝回注路径（本次） | Turn 整体失败，用户看到无上下文的 `undefined (reading 'role')`；被迫重试，重试后前序工具结果不在新 Turn 上下文中（与关联方案的恢复缺口相同源） | **P0——崩溃 + 数据污染** |
| 拒绝回注路径（若不崩的假想情况） | 模型看到 N 个没有对应结果的 `tool_use`，transcript 结构损坏，依赖 `tool.result.pairing.repaired` 兜底修复 | P0 的另一面 |
| 致命故障路径 | Turn 以第一个 rejection 的原因结束；被作废的兄弟调用有 not-dispatched 落账，但**失败归因以偏概全**——用户看到的错误来自第一个失败的工具，其余调用未必会失败 | P1——行为/归因 |
| 通用 | 模型发起的兄弟调用被静默丢弃，只能下一轮重新发起，多花轮次与 token（本会话 04:05 起的后续 Turn 确实在继续处理同一文档） | P1——效率 |

### 4.3 相邻异常（登记，不在本方案处置）

该会话**每个** Turn 启动都触发 `tool.result.pairing.repaired`，且 `roleAlternationFixed` 持续为 1–7，说明存储历史系统性违反 role 交替、长期依赖修复兜底。与本次缺陷是否同源（例如历史 turn 的空洞经序列化留下的残迹）**尚未验证**，建议另开排查待办；本方案的 P0 修复落地后该指标应显著下降，可作为旁证观测点。

## 5. 改进方案

设计原则沿用关联方案 §3.1：**每调用级结果（拒绝、业务失败）回注模型，Turn 继续；只有真正破坏继续执行前提的故障（取消/超时/历史写入失败/派发后结果未知）才终止 Turn，且终止时必须落账**。

### 5.1 P0-A：空洞物化——settledTools 永不为稀疏（防崩兜底）

**位置**：`turn.ts` settledTools 结算段，在 deniedToolResults 循环（1417）**之前**插入物化步骤。

**做法**：`mapWithConcurrency` 返回后，扫描未尝试槽位（`settled === undefined` 的下标），对每个对应工具：

1. `markNotDispatched(tool, <理由码>)`——**理由码复用 `turn.ts:1442` 的既有判定表达式**：`input.request.signal?.aborted ? 'REQUEST_CANCELLED' : 'TURN_STOPPED_BEFORE_DISPATCH'`，**不引入新理由码**。物化的语义是「把 1440–1443 的落账提前到物化点执行」：同一表达式、同一理由码，取消场景的理由码语义不漂移，既有回归用例 `turn.test.ts:2103-2138`（2136 行断言排队工具落 `TURN_STOPPED_BEFORE_DISPATCH`）保持绿；
2. 以**fulfilled 的 isError 工具消息**占位该槽位：`{ role: 'tool', toolCallId, content: 'Tool call was not dispatched (…).', isError: true }`——与既有拒绝回注消息同构。

**关键次序**：物化必须在 `rejectedTools`/throw 处理之前完成。`markNotDispatched` 会把工具从 `pending` 置为 `not-dispatched`（`turn.ts:963` 的 pending 守卫），因此 1440–1443 的既有落账循环对已物化工具成为空操作——落账**发生且只发生一次**，落账点是前移而非两段并存，不存在「物化落一次、throw 分支再覆盖一次」的关系（v1 此处表述有误，评审 P2-1 已修正）。若未来需要在事件面区分「物化路径」与「原 throw 路径」，在事件 payload 加来源字段，而不是改理由码。物化后即使走 throw 分支（致命故障），占位消息也已就位，push 永远不可能产出 `undefined`。

**效果**：对外可观测行为（理由码、历史事件、既有测试断言）与现状完全一致，仅消灭「空洞」这一数据形态。单独落地即可消除崩溃。

### 5.2 P0-B：失败分类与批内排空——拒绝不作废队列，也不越过未决在途调用补位

**位置**：`turn.ts:1192` 的 `mapWithConcurrency` 调用与 `1539` 的实现（均为模块内私有，签名变更无外部影响）。

**做法**：为 `mapWithConcurrency` 增加 rejection 分类及批内 drain 协调。遇到 `ToolDeniedError` 时不将它视为致命停止，但也**不立即补领下一项**：置 `drainingAfterDenial`，暂缓领取尚未启动的工作，并等待所有已领取 worker 完成。排空期间若任一在途 worker 抛出非 `ToolDeniedError`，转为致命停止，所有仍未领取项保持未派发并按 P0-A 落账；若在途调用均成功、返回业务错误或拒绝，则清除 drain 状态并继续领取队列。其他 rejection 仍立即 `stopped = true`，后续不再派发。

该协调需要让 worker 在每个任务 settle 时同步更新批状态，并在共享游标前以同一临界状态判断是否允许领取。实现可使用 promise barrier / 批次调度器；不得以固定延迟或依赖工具执行耗时排序。状态至少区分 `running`、`draining-after-denial`、`stopped`，且多个拒绝、多个在途 worker 同时完成时不能丢失致命 rejection。

- `ToolDeniedError` → **不作废队列，但进入 drain**；当前已领取调用可完成，drain 窗口中不启动新调用。无致命结果时恢复派发，确保一次拒绝不会永久作废整批；致命结果先于恢复派发时，未领取项保持未派发。每个被拒调用已有完整的 `markNotDispatched` + 回注链路（抛出前已落账）。
- 其余 rejection（取消/超时、历史追加失败、派发后结果未知等）→ 维持 `stopped = true` 的 fail-fast，走既有 throw 分支。

**影响的抛出点——`turn.ts` 全量 8 处 `throw new ToolDeniedError`（评审 P2-3；`shouldStop` 以 `instanceof` 判定，天然全覆盖，无实现风险）**：

| 行号 | 场景 | 性质 |
|---|---|---|
| `turn.ts:1225` | `PREPARED_CALL_MISMATCH` | 每调用级 |
| `turn.ts:1234` | 安全网关 deny（含策略性 POLICY_DENY / FACTS_CHANGED） | 每调用级 |
| `turn.ts:1239` | `CONFIRMATION_REQUIRED`（宿主无确认通道） | 每调用级 |
| `turn.ts:1310` | 确认结果拒绝——**含用户在确认卡上显式点拒绝**（CONFIRMATION_DENIED 等） | 每调用级，权衡见下 |
| `turn.ts:1333` | `PREPARED_RECHECK_FAILED`（recheck 阶段失败） | 每调用级 |
| `turn.ts:1338` | `STALE_AUTHORIZATION` | 每调用级 |
| `turn.ts:1348` | recheck deny / `RECHECK_REQUIRES_CONFIRMATION` | 每调用级 |
| `turn.ts:1374` | 执行器拒收（`ToolExecutionRejectedError` 转换） | 每调用级 |

另有 prepareTool 的 catch 分支（`turn.ts:1215-1218`）先 `markNotDispatched` 再 re-throw 透传既有 `ToolDeniedError` 实例，分类同样成立。所有被拒调用都在**工具执行之前**被拦截，不产生工具副作用。

**产品权衡：用户显式拒绝后的确认卡连弹（评审 P2-3）**。同批多个审批候选仍可能逐个走门控并连续弹出确认卡；drain 只处理在途结果未决期间的补位时序，不抑制之后恢复派发的确认请求。本方案的处置分三层：

- **P0 阶段统一不停止**：实现最简、语义一致（每个调用独立门控）；且首个拒绝结果回注后，模型大概率自行停止重发同类调用；
- **P1-D 缓解（§5.4）**：宿主确认层对「同批、同工具、同写目标」的后续 ask 以首个用户显式拒绝结果直接回注（去重），用户只需拒绝一次；
- **不将用户显式拒绝单列为「停止信号」**：那会让 agent-sdk 派发层依赖宿主确认语义，破坏分层；若 P1-D 落地后仍有场景噪声，再评估单列。

**回注关闭路径的执行面变化（评审 P2-4）**。`returnDeniedToolsToModel = false` 的路径（SDK 直连/测试用例）下，拒绝后仍按 drain 规则协调在途任务：无致命错误时最终继续派发未领取兄弟，Turn 按既有行为终止；在途出现致命错误时队列保持未派发。实施时排查依赖拒绝立即补位或停止时序的用例并按新状态机更新。

**与 P0-A 的关系**：P0-B 落地后，纯拒绝且无致命错误的路径最终会尝试所有调用；致命错误发生在 drain 窗口时仍会留下未领取项，由 P0-A 物化落账与占位。二者是「协调派发 + 空洞兜底」关系，建议同一 PR 落地。

### 5.3 P1-C：可观测性与归因精度

1. **停止派发事件**：发生「停止且存在未尝试调用」时，记一条结构化事件（触发 rejection 的理由码、已尝试/已作废计数、涉及 toolCallId 列表），事件名建议 `tools.dispatch_stopped_with_pending`。本次事故若有此事件，排查可从 30 分钟缩短到 5 分钟。**落点说明（评审 P3-3）**：「停止 + 未尝试」状态只存在于 SDK `turn.ts` 内部，宿主侧无法直接观测——需经 SDK observer 钩子新增投影来源，或复用物化落账的 `tool-call-not-dispatched` 事件在 `agentSdkSessionEventProjection`（`electron/runtime/agentSdkSessionEventProjection.ts`）的既有投影携带；实施时不得在 electron 侧另找挂点。
2. **空洞物化计数**：P0-A 的物化步骤每发生一次即计数上报，**与理由码解耦**；若需区分「物化路径」与「原 throw 路径」，在事件 payload 加来源字段，不新增理由码。理论上 P0-B 落地后该计数应恒为 0（仅致命路径偶发）；非零即是新缺陷信号。
3. **错误归因携带上下文**：Turn 失败向外传播时（`HostedTurnFinalizedError` 包装处，`hostedTurnHandoff.ts`），附上 modelTurn、失败 stepId 与首个 rejection 的 toolCallId/toolName/reasonCode，避免用户与开发者只看到裸 `TypeError` 文本。

### 5.4 P1-D：用户显式拒绝的批次去重（缓解确认卡连弹）

P0-B 的已知代价是同批多个审批候选在用户显式拒绝后仍会逐个走门控（§5.2 权衡）。缓解在**宿主确认层**实现，agent-sdk 派发层不感知：

- 同一模型轮内，后续 ask 若与已显式拒绝的调用**同工具且同写目标**（写目标 facts 一致），不再弹卡，直接以首个拒绝的结论回注（reasonCode 沿用 `CONFIRMATION_DENIED`，消息注明「同批同目标的同类调用已由用户拒绝」）；
- 不同目标、不同工具的调用不受影响，仍正常走确认；
- 作用范围限单轮批内，不跨轮记忆（跨轮记忆属既有的审批规则/记忆体系，不在本方案范围）。

是否采纳由实施阶段按确认层改动量评估；不做也不阻塞 P0。

### 5.5 不建议的修复方式

| 方式 | 不采纳理由 |
|---|---|
| 调大 `toolExecutionConcurrency` | 不改变「任意 rejection 作废队列」的语义，仅减少每次的洞数；且并发调大会放大同批写冲突风险（本次 6 个调用全部指向同一文件） |
| 在 `agentSdkDesktopObserver.ts:94` 做 `message?.role` 防御 | 把症状治在投影层：坏 transcript 被静默投影给模型，损坏转入不可见。观察器保持 fail-loud，正是本次能在日志里一眼定位的原因 |
| 直接删除 `stopped = true` | 连致命故障（取消/历史写入失败）也不停止派发，Turn 已注定失败还在继续执行有副作用的工具，违背「副作用边界」原则（关联方案 §3.4） |
| 在 push 处对 undefined 做过滤跳过 | 丢失调用的最后痕迹（连 not-dispatched 落账都没有）；且治标不治源头 |

## 6. 实施顺序

| 阶段 | 内容 | 交付物 |
|---|---|---|
| 1 | **完成**：P0-A + P0-B 同批落地（拒绝 drain 协调 + 未派发槽位物化）；改写原混合批测试为 deferred 确定性时序，并新增纯拒绝恢复、多 worker 竞争、1000 轮不变量测试 | `packages/agent-sdk/src/turn.ts`、`packages/agent-sdk/test/turn.test.ts` |
| 2 | **完成**：SDK Turn、Hosted AgentTurnHost、desktop observer 与 confirmation adapter 定向回归；覆盖 drain fatal / recover 路径 | 见本文末「实施验证记录」 |
| 3 | **完成**：P1-C SDK observer 投影 + 会话事件/诊断日志，P1-D 同轮同工具同写目标拒绝去重（只记用户显式拒绝） | `agentSdkDesktopObserver.ts`、`invocationAssembler.ts`、`agentSdkConfirmationPort.ts` |
| 4 | **代码级验收完成；真机运行未执行**：自动化确认拒绝后 Turn 恢复、同目标确认只发布一次、队列与 transcript 均有确定性覆盖。需启动桌面应用和真实确认 UI 才能验证视觉交互及新会话 pairing repair 指标 | 限制与记录见实施验证记录 |

与关联方案 [`tool-error-recovery-and-turn-continuity-plan.md`](tool-error-recovery-and-turn-continuity-plan.md) 的阶段 B（让工具失败在原 Turn 内得到处理）同向，建议一并评审；本方案不依赖其落地，可独立实施。

## 7. 测试方案与验收标准

### 7.1 不变量测试（AGENTS.md 队列/票据类模块硬性要求）

`mapWithConcurrency` 及其结算段属于典型的队列/槽位模块，除场景用例外必须有一条**随机操作序列 + 状态不变量断言**测试（示范：`electron/butler/butlerAdmission.test.ts` 末组）。放在 `packages/agent-sdk/test/turn.test.ts`（随 electron vitest 项目运行）：

- 用 mulberry32 确定性伪随机种子驱动 N 轮批派发：每轮 1–8 个调用，每个调用随机落入 成功 / 业务失败（isError 结果）/ `ToolDeniedError` / 致命失败（如历史追加错误）/ 空转；
- 每轮结算后断言跨函数不变量：
  1. `settledTools` 物化后**无空洞**（每个下标都有 settled 结果）；
  2. `messages` 中**不含 `undefined`**；
  3. **结局守恒（评审 P2-2 改写）**：每个 `tool_use` **至少有一种**结局记录——对应 `tool` 消息或 `tool-call-not-dispatched` 历史事件；且对应 `tool` 消息在 `messages` 中**至多一条**、not-dispatched 历史事件**至多一条**（不重复落账）。注意：物化路径与拒绝回注路径天然是「两者都有」（占位/回注消息 + 落账事件并存），这是既定设计，**不得**按「必居其一」判为违规；
  4. **队列作废仅由致命条件引起**：出现未尝试调用时，当轮 rejection 中必存在非 `ToolDeniedError` 的致命项；拒绝单独不能永久作废队列；
  5. 非致命拒绝不减少「已尝试」调用数（兄弟调用全部有结局）。
  6. drain 状态期间（拒绝已发生、尚有在途 worker 未结算）派发启动数不增加；全部在途 settle 且无致命项后才恢复领取。

随机序列测试使用内存 History（`MemoryHistory`）与假 observer，不落真实磁盘 IO，满足 electron 项目 forks 单 worker 与用例超时约束（评审 P3-4；与既有 `turn.test.ts` 用例同法）。

### 7.2 场景回归用例

1. **混合批时序（评审阻断复现）**：并发上限 2；`tc-denied` 立即拒绝，`tc-uncertain` 由可控 deferred promise 暂缓后抛派发结果未知，另有 `tc-queued`。断言：拒绝 settle 后、致命结果揭晓前 `tc-queued` 执行器调用次数仍为 0；致命结果揭晓后 Turn 以该原始错误结束，`tc-queued` 保持未派发并有 not-dispatched 事件，未产生其副作用；messages 无 `undefined`。
2. **纯拒绝恢复路径**：拒绝后仍有在途调用，先令该调用成功结算，再断言排队调用才启动并最终都有结果；Turn 不因拒绝而丢弃整批，messages 无 `undefined`。
3. **多 worker 竞争**：至少两个在途调用与多个拒绝交错完成，其中一个在途调用抛致命错误；断言 drain 屏障不会遗漏致命项，屏障打开前无新派发。
4. **普通业务失败**：批中一个调用返回 isError 结果（非 throw）→ 断言：兄弟调用不受影响（对既有行为的回归保护）。
5. **边界**：拒绝发生在最后一个槽位（无洞）→ 行为与新状态机一致，不产生多余等待或重复落账。

### 7.3 验收标准

- §7.1 不变量测试在 ≥1000 轮随机序列下全绿；回退任一修复应能转红（红绿同步验证）。
- §7.2 混合批时序中，排队工具在在途致命结果确定前执行次数为 0；最终记录为未派发，且其副作用边界未被越过。
- §7.2 纯拒绝恢复路径中， drain 完成后排队工具会被派发；不能把“拒绝之后暂缓补位”实现成“拒绝后永久停止”。
- 所有结局下 `messages` 不含 `undefined`，每个 `tool_use` 均有可追溯结局。
- 既有用例 `turn.test.ts:2103-2138` 属于“拒绝 + 派发结果未知”混合批；必须按确定性门控更新断言，确保排队调用仍是 `TURN_STOPPED_BEFORE_DISPATCH`，不能要求旧的偶然时序“保持绿”而不校验实际执行时序。
- 定向回归命令：`npm exec vitest run packages/agent-sdk/test/turn.test.ts electron/runtime/hostedAgentTurnHost.test.ts`（v2 按评审 P3-2 移除 `capacity.test.ts`——本次改动不涉及其签名）。
- 真机验收（阶段 4）：触发场景下 UI 不再出现 `Cannot read properties of undefined (reading 'role')`；`tool.result.pairing.repaired` 的 `roleAlternationFixed` 在新会话中趋近 0（旁证，非硬性门槛）。

## 8. 代码落点清单

| 文件 | 位置 | 改动 |
|---|---|---|
| `packages/agent-sdk/src/turn.ts` | :1192 | `mapWithConcurrency` 调用处传入 `shouldStop` 分类器（`!(reason instanceof ToolDeniedError)`） |
| `packages/agent-sdk/src/turn.ts` | :1417 前 | 新增空洞物化步骤：`markNotDispatched`（**复用 `:1442` 既有理由码判定表达式**，不新增理由码）+ fulfilled isError 占位消息，置于 deniedToolResults 循环之前 |
| `packages/agent-sdk/src/turn.ts` | :1539-1557 | `mapWithConcurrency` 签名增加 `shouldStop?` 选项，`stopped` 置位前先过分类器 |
| `packages/agent-sdk/src/turn.ts` | `mapWithConcurrency` 调度器 | 加入拒绝后的 drain 状态与同步屏障；确保 drain 未结束时不领取新项，且在途致命 rejection 不会被遗漏 |
| `packages/agent-sdk/test/turn.test.ts` | 末尾追加 | §7.1 不变量测试 + §7.2 混合批确定性时序、纯拒绝恢复、多 worker 竞争等场景 |
| `packages/agent-sdk/test/turn.test.ts` | 既有用例排查 | `:2103-2138` 必须改为 deferred 控制的确定性测试，明确排队工具在 `tc-uncertain` 致命错误前不执行，且落 `TURN_STOPPED_BEFORE_DISPATCH`；移除旧的“混合批不受影响”断言 |
| `electron/runtime/agentSdkSessionEventProjection.ts` 或 SDK observer（P1-C，评审 P3-3） | 投影来源 | `tools.dispatch_stopped_with_pending` 事件——**需 SDK 层新增投影来源**（observer 钩子）或复用 not-dispatched 事件投影；宿主侧无法直接观测 SDK 内部状态 |
| `electron/runtime/`（P1-C） | — | 物化计数上报 + 错误上下文透传 |
| `electron/confirmation/`（P1-D，可选） | 确认层 | 同批同工具同写目标的 ask 去重回注 |

## 9. 实施验证记录（2026-10-03）

- 使用独立 worktree：`.worktrees/tool-dispatch-slot-abort-tdd`，分支 `codex/tool-dispatch-slot-abort-tdd`。
- TDD 场景：拒绝后 drain 窗口中 fatal 时 queued 不执行且有 not-dispatched 记录；无 fatal 时在途任务 settle 后恢复 queued；两个在途 worker 竞争 settle 时不会提前解 drain；confirmation 用户拒绝只对同轮同工具同规范写目标去重。
- 随机不变量：固定 mulberry32 seed，1000 个 1–8 调用批次，采用 `MemoryHistory`；检查结局可追溯、消息无 `undefined`、消息与 not-dispatched 不重复、拒绝不单独作废队列。
- P1-C：SDK 内部产生 `tools.dispatch_stopped_with_pending`、`tools.undispatched_slots_materialized`、`tools.dispatch_failure_context`；desktop observer 将其投影到现有 `tool_result` 会话事件流（使用 `diagnosticType` 字段）并由宿主 `logAgentEvent` 写结构化日志。
- P1-D 采用。去重键包含 `modelTurn`、工具名与 `writePathFact.normalizedPath`，仅在同一模型轮内生效；下一轮即使目标路径相同也重新确认，允许模型调整内容后由用户重新审阅。不同工具/目标独立确认，策略性拒绝不进入用户拒绝缓存。
- 定向验证命令：`npm exec -- vitest run --project electron packages/agent-sdk/test/turn.test.ts electron/runtime/hostedAgentTurnHost.test.ts electron/runtime/agentSdkDesktopObserver.test.ts electron/confirmation/agentSdkConfirmationPort.test.ts`；通过 4 个测试文件、184 个测试。
- 随机不变量单独验证：`npm exec -- vitest run --project electron packages/agent-sdk/test/turn.test.ts -t '1000 deterministic randomized batches'`；1000 轮通过。
- SDK 类型验证：`npm run typecheck:agent-sdk`；通过。
- 真机验证未执行：当前运行环境没有启动桌面 Electron 与可交互审批 UI，亦没有可采集的新会话 pairing repair 指标；因此 §7.3 的 UI/线上旁证门槛保留为部署后验证项。
