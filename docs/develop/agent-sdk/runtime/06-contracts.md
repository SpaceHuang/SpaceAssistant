# 六、契约

> 本篇定义 Runtime 的门面：调用的输入与输出、执行器回报到提交的完整链路、观测与控制接口。
> 契约的设计目标是两条：**业务侧形状不变**（仍用 `await`），以及**业务不感知调度但能观测原因**。

---

## 1. 门面

```ts
interface Runtime {
  // —— 提交 ——
  call(req: CallRequest): Promise<CallResult>

  // —— 观测（只读，不影响 Runtime）——
  snapshot(): RuntimeSnapshot
  inspect(scope: SessionId | TurnId | CallId): ScopeView
  explain(callId: CallId): BlockReason
  facts(query: FactQuery): readonly Fact[]

  // —— 控制 ——
  cancel(target: SessionId | TurnId | CallId, reason: string): void
  drain(): Promise<void>
  close(): Promise<void>
}
```

**注意这里没有 `signal()`**：唤醒不再是外部接口——它已被三处吸收（配额的 `V`、执行器的 `onOutcome`、`P` 的 `timeout`），见 [05-extension-points.md](./05-extension-points.md) §4。

**`call` 返回 Promise**，这是"业务逻辑不变"的落点：JS 的 `await` 天然是协程的让出点，所以

```ts
// 编排层（turn loop / 工具链路 / 安全策略组件）写法与今天无异
const result = await runtime.call({ kind: 'tool', scope, intent })
```

业务看到的是同步风格的调用，内部发生的是：创建调用 → 可能被挂起 → 完成时 resolve。**挂起与恢复由 JS 协程机制完成，Runtime 不保存任何现场**（见 [02-runtime-core.md](./02-runtime-core.md) §2）。

---

## 2. 调用的输入：意图 + 已知事实

```ts
type CallRequest = {
  capability: string                           // ① 能力身份：'tool' / 'model' / 'agent' / 'human'
  scope: { sessionId: SessionId; turnId: TurnId; stepId?: StepId }
  intent: unknown                              // 业务意图，Runtime 不解释
  parentCallId?: CallId                        // 嵌套时的父调用（**显式**，见 §7）
  deadline?: Instant
  signal?: AbortSignal
}
```

### `capability` 与"执行边界"是两个维度

早先两者都叫 `kind`，这会造成混淆。它们必须分开：

| 维度 | 取值 | 谁决定 |
| --- | --- | --- |
| **能力身份**（`capability`） | `tool` / `model` / `agent` / `human` | **编排层**——它说"我要做什么" |
| **执行边界**（`ExecutorKind`） | `local` / `process` / `mcp` / `http` / `human` / `agent` | **能力元数据**——它说"这靠哪个边界实现" |

例：`capability: 'tool'` + `intent.toolName: 'grep'` ⇒ 能力元数据给出 `ExecutorKind: 'local'`；`'run_shell'` ⇒ `'process'`；某个 MCP 工具 ⇒ `'mcp'`。

**编排层只写前者，后者由装配映射**（[09-assembly.md](./09-assembly.md) §6）。

### `intent` 就是共识 7 那句公式的物化

```text
新调用的输入 = 任务意图 + 全部已知事实（失败原因 / 执行情况 / 已发生副作用）+ 新期待
```

**注意：`intent` 已经包含"已知事实"了，它不是单独的一个字段。** 原因：

- 从事实构造输入是**业务语义**（续写消息怎么写、要告诉模型什么），属编排层
- Runtime 传的是**已构造好的完整输入**，它不需要知道里面含什么
- 这样 Runtime 本体里不会出现"续写""重试"这类概念

编排层从哪里拿事实？从 `runtime.facts(query)`：

```ts
// 编排层：模型调用失败后构造带上失败原因的新调用
const history = runtime.facts({ scope: 'turn', kinds: ['tool-call-finished', 'call-settled'] })
const result = await runtime.call({
  capability: 'model',
  scope,
  intent: { messages: [...], notice: '上一次输出被截断，请继续' }   // ← 事实已被编进去
})
```

**这也是共识 7 的另一面**：一切"重新发起"（续写 / 重试 / 恢复 / 用户追加）在契约上**没有区别**——它们都只是"一个 `intent` 里含着已知事实的新调用"。**正常逻辑里不存在"重试"这个机制。**

### `scope` 的用途

Runtime 不理解 `sessionId` / `turnId` 的业务含义，只用它做三件事：

| 用途 | 说明 |
| --- | --- |
| **租约**作用域 | 例如 `session:<id>`——由**租约**（不是许可）实现"一会话一个 Turn"，且带**归属校验**（[04](./04-quota-and-guards.md) §2） |
| 观测分组 | `inspect(scope)` 按会话 / Turn 聚合 |
| 取消作用域 | `cancel(sessionId)` 取消该会话全部非终态调用 |

### turn 级调用（无 `stepId`）

`stepId` 是**可选**的——这不是省略，而是一个**真实存在的调用类别**：有些调用发生在 **Turn 已受理、但第一个 Step 尚未开始**的**配置阶段**（解析配置、解析凭据、**技能路由**）。它们属于这个 Turn，但不属于任何 Step。

| 项 | 取值 |
| --- | --- |
| `scope.turnId` | **有**（Turn 已受理） |
| `scope.stepId` | **无** |
| 事实标记 | Turn 级——不属于任何 `step/start`…`step/end` 区间 |
| 调度 | 与普通调用一致——**不因为"不在 Step 内"而特殊** |

**现状对应物**：`electron/ipc/agentProtocolIpc.ts` 的 turn `configuring` 阶段——先 `turnCoordinator.prepare(...)` 拿到 `turnId`，再在其中做技能路由（源码注释：*"立即交还 turnId，使配置/路由阶段可被 cancel-turn 打断"*）。所以"turn 级调用"不是新概念，而是**现状已在使用的形态**，这里只是把它写进契约。

### 配额声明不在请求里

`CallRequest` **不含**配额字段。配额由装配的映射器**查能力元数据**后推导（[04-quota-and-guards.md](./04-quota-and-guards.md) §2「声明由谁填写」），例如：

```text
capability='model'                        → ['llm:global']
capability='model' + 审核用途             → ['llm:audit']      （由策略配置决定）
capability='tool' && toolName='run_shell' → ['tool:concurrent', 'process:shell', 'call:global']
```

这是"业务不感知配额"的保证：**编排层不知道也不声明配额**，它只说"我要做什么"。**知识在能力元数据（工具注册表 / 模型路由）里，映射器只负责查表。**

---

## 3. 调用的输出与结算

```ts
type CallResult =
  | { outcome: 'done',      result: unknown }
  | { outcome: 'failed',    cause: string, dispatched: boolean }   // dispatched = 是否越过派发边界
  | { outcome: 'cancelled' }
  | { outcome: 'uncertain', cause: string }
```

| outcome | 含义 | 能否重做 |
| --- | --- | --- |
| `done` | 完成，结果已提交为事实 | — |
| `failed` + `dispatched: false` | **未派发**的失败（预算耗尽 / `P` 超时） | ✅ **"零副作用"是确定事实** |
| `failed` + `dispatched: true` | 已派发的明确失败 | ⚠️ **可能已产生部分效果**——由上层依幂等协议判断，**Runtime 不表态** |
| `cancelled` | 执行器**确认已停止**（含超时取消） | 视是否曾派发而定 |
| `uncertain` | **已派发、结果未知** | ❌ 技术层无法回答 |

**`dispatched` 这一位是评审要求补上的**：此前 `failed` 不区分"是否已派发"，而上层恰恰需要它来判断"能不能安全重做"（[02](./02-runtime-core.md) §6）。

**这四个值只回答"我方"的两个确定事实**（请求发出去了吗、拿到确定回应了吗），**不含任何对副作用的判断**：

- Runtime 无法可靠地知道"该调用会不会改变外部世界"——外部工具协议不要求声明副作用，参数语义也没有固定算法（见 [05-extension-points.md](./05-extension-points.md) §2 要点 2）
- 因此一律保守：**已派发 + 结果未知 ⇒ `uncertain`**，与工具类型无关

`uncertain` 是四个终态里唯一需要上层参与的：它意味着"要不要重做"这个问题**技术上无法回答**。

**"要不要重做"不在契约内**——它是上层（编排层 / 产品）的决策，可依据幂等键、自有工具元数据，或发起一个调用去问模型 / 问人。Runtime 不做表态。

---

## 4. 从执行器回报到提交：完整链路

```text
执行器 onOutcome(outcome)
  │
  ├─▶ 状态 → settling（**非终态**：结果已得、事实未落库）
  │
  ├─▶ Hooks.onCallSettled（commit 语义）
  │     ├─ 成功 → 事实已确立
  │     └─ 失败 → **幂等重试"写事实"**（同一 callId、同一事实）
  │                └─ 最终失败 → 结算为 uncertain
  │
  ├─▶ 状态 → terminal（`done` / `failed` / `uncertain`）   ← 到这里才不可逆（I2）
  │
  ├─▶ V：归还该调用持有的全部配额 → 唤醒（跳过不满足的等待者，见 [03](./03-scheduler.md) §5）
  │
  └─▶ resolve call() 的 Promise  → 编排层恢复执行
```

三个要点：

**（1）`settling` 必须在 `terminal` 之前。** 早先的顺序是"先终态、后提交"，那会导致提交失败时要**改终态**——违反 I2。正确的顺序是：**结果已得 ⇒ `settling` ⇒ 提交 ⇒ `terminal`**。

**（2）提交重试 ≠ 重新派发。** 提交失败时**只能重试"写事实"**（幂等），**绝不能重新派发外部操作**——因为外部可能已经执行过。详见 [02-runtime-core.md](./02-runtime-core.md) §6 的对照表。

**（3）配额释放在 `terminal` 之后。** 归还动作**不能暗示"结果已提交"**：若在 `settling` 期间就释放，恢复时会看到"配额已放、事实未落库"的不一致状态。所以释放必须在提交成功（`terminal`）之后——尽管这意味着"提交重试期间仍占着配额"。

---

## 5. 观测接口

### `snapshot()` —— 全局

```ts
// ① 诊断快照（观测用——**不承担恢复**）
type RuntimeDiagnostics = {
  phase: 'idle' | 'running' | 'draining' | 'closed'
  counts: { inFlight: number; ready: number; waiting: number }
  quotas: Record<QuotaName, { spec: QuotaSpec; used: number }>
}

// ② 恢复快照（性能优化用——必须含"调用数据 + 游标 + 版本"）
type RuntimeSnapshot = {
  eventCursor: number          // 对应到事件流的哪个位置
  schemaVersion: number        // 投影版本——升级后旧快照必须能被判定为不可用
  calls: CallSnapshot[]        // 非终态调用：callId、声明、是否已派发、输入引用
  leases: LeaseSnapshot[]      // **租约**的占用（长生命周期，跨调用——见 [04](./04-quota-and-guards.md) §2）
}
```

> ⚠️ **两者不能混用**（评审指出的缺口）：此前 `RuntimeSnapshot` 只有计数与配额，却被 [07](./07-failure-and-recovery.md) §3.2 当成恢复快照使用。**诊断快照回答"现在什么状态"，恢复快照回答"从哪继续"——字段要求完全不同。**

### `inspect(scope)` —— 按会话 / Turn / 调用

```ts
type ScopeView = {
  calls: Array<{
    callId: CallId
    capability: string
    state: CallState
    blockedBy?: BlockReason      // 为什么没在跑（派生视图）
    since: number
  }>
}
```

### `explain(callId)` —— 一个调用为什么没在跑

```ts
type BlockReason =
  | { kind: 'quota',  name: QuotaName }        // blocked：挂在等这个配额
  | { kind: 'queued', detail: string }         // ready：在就绪队列中排队，未被调度
```

**这是"业务不感知队列但能观测原因"的接口表达**（[01-positioning.md](./01-positioning.md) §4）。业务拿不到队列长度、排队位次、唤醒机制，但能回答"我的调用为什么还没跑"。

**`BlockReason` 只有两类**，因为等待只有两种归属：在某个配额的 `waiters` 里（`blocked`），或在就绪队列里（`ready`）。它直接从状态读出，不需要"配额状况 + 声明的即时计算"。

### `facts(query)` —— 读事实

```ts
type FactQuery = {
  scope?: SessionId | TurnId
  kinds?: readonly FactKind[]
  since?: number
  limit?: number
}
```

**这是"构造下一次请求输入"的来源**（共识 14）。它同时服务于两侧：

| 喂给谁 | 投影形态 | 用途 |
| --- | --- | --- |
| 模型 | 消息序列（自然语言） | 作为上下文（"上一次你被截断了，请继续"） |
| 执行器 | 结构化（幂等键、已派发记录） | 避免重复副作用 |

同一份事实，两种投影。

---

## 6. 控制接口

| 接口 | 语义 | 实现要点 |
| --- | --- | --- |
| `cancel(target, reason)` | 取消该作用域下全部非终态调用 | 已派发的调用**不强杀**，只传递取消请求（由执行器决定何时响应）；未派发的直接从就绪队列 / `waiters` 中移除 |
| `drain()` | 进入 `draining`，等全部非终态调用收敛 | 收敛条件是**状态查询**（是否还有非终态调用），不是时间赌博（替代现状的 5s `finishingWindowMs`） |
| `close()` | 关闭，停止接受新调用 | — |

**取消的语义要点**：`cancel` 是**请求**而非**强制**。已派发的调用可能已经产生了副作用，Runtime 无权断言它"已停止"——因此取消后的结算仍走正常路径（执行器回报 `cancelled` / `done` / `uncertain`）。

**并且：取消不释放配额。** 归属该调用的许可要等执行器**回报结果**时才归还（`V` 在结算路径上）。否则会出现"旧操作仍在运行、配额却已重新分配给别人"的超额并发——执行器启动长期操作（子进程、后台任务）时，取消请求与真实停止之间可能隔很久。

### 超时、取消与关闭：四种不同的"停止"

把它们混为一谈是本设计早先的一个漏洞。必须分开：

| 概念 | 覆盖什么 | 到期 / 发生后的结果 |
| --- | --- | --- |
| **排队超时**（`P` 的 `timeout`） | 等待**许可**的时间 | `failed`——**零副作用，可安全重做** |
| **执行截止**（`CallRequest.deadline`） | 从**派发**到结果的时间 | 已派发 ⇒ **`uncertain`** |
| **请求取消**（`cancel`） | 表达"我不再需要这个结果" | 由**执行器**决定何时响应 |
| **确认停止**（执行器回报） | "我确实停了" | **到这一步才能释放配额** |

**两个关键区分**：

1. **排队超时 ≠ 执行截止**——前者发生在"未派发"阶段（安全）；后者发生在"已派发"阶段（可能 `uncertain`）。二者不能互相代替。
2. **请求取消 ≠ 确认停止**——取消只是请求；已派发的调用在**执行器回报之前仍占有配额**。

**`drain()` 必须有界**：若某个执行器**永不回报**，`drain` 会永久等待。所以它要带上限——超时后按序处置：① 仍在途的标为 `uncertain`；② 记录"未确认的停止"；③ 释放配额（此时只能假定它不会再产生需要协调的新结果）。

---

## 7. 嵌套调用的身份

嵌套是常态（审核 Agent 有自己的 Runtime）：

```text
外层调用 #42（kind='agent'，边界＝另一个 Runtime 实例）
   └─ 内层：审核 Agent 的 Turn #7 → 它的 Step → 它的调用
```

契约上需要一处关联：**`CallRequest.parentCallId`**——**显式的字段，不藏在 `intent` 里**（否则 Runtime 无法用它做嵌套取消与审计关联），使

| 关联 | 用途 |
| --- | --- |
| 外层 `callId` ←→ 内层 `turnId` | 事实关联（审计时能串起来） |
| 外层取消 ←→ 内层 `cancel` | 取消向内传播 |

内层有**自己的事实流与自己的恢复逻辑**；外层只记录"我发起了一次调用，结果是 X"。二者只在调用边界上交汇。详见 [07-failure-and-recovery.md](./07-failure-and-recovery.md) §5。

---

## 8. 下一篇

- 异常与恢复：[07-failure-and-recovery.md](./07-failure-and-recovery.md)
