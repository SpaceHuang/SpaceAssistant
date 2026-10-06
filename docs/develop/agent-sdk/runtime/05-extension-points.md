# 五、扩展点

> 本篇定义除配额机制（见 [04-quota-and-guards.md](./04-quota-and-guards.md)）之外的全部扩展点：执行器、状态钩子、时钟、排序策略、持久化端口。
>
> **共同特征**：Runtime 本体只定义接口与调用时机，实现全部由装配注入。每一项都给出默认实现，以便"最小可用 Runtime"能跑起来。

---

## 1. 总览

| 扩展点 | 职责 | 默认实现 | 缺失时 |
| --- | --- | --- | --- |
| **Ordering** | 就绪队列的排序（唤醒策略 / 公平性） | `(priority, submitSeq)` | 先到先服务 |
| **Executor** | 执行一次调用 | — | **必须提供** |
| **QuotaRegistry**（见 [04](./04-quota-and-guards.md) §7） | 配额账本与作用域 | 进程级内存 | 无配额约束 |
| **Hooks** | 状态变化通知 | 无操作 | 无持久化 / 无投影 |
| **Clock** | `P` 的超时定时器 | 真实时间 | 无超时 |
| **FactLog** | 事实追加与读取 | 内存 | 重启后状态丢失 |

> 表中 `QuotaRegistry` 属第四篇，其余为本篇内容。

各扩展点的注入方式统一（完整形状见 [09-assembly.md](./09-assembly.md) §4）：

```ts
createRuntime({ executors, permits, budgets, quotasOf, priorityOf,
                capabilities, facts, snapshots, clock, hooks, ordering, policy })
```

---

## 2. 执行器（Executor）

执行器是**唯一有副作用的地方**，也是唯一允许 `await` 外部世界的地方。

```ts
interface Executor {
  /** 这个执行器处理的**执行边界**（不是"能力身份"，见 [06-contracts.md](./06-contracts.md) §2） */
  executorKind: ExecutorKind

  /** 非阻塞启动。结果通过回调返回，不通过返回值。 */
  start(call: Call, handlers: {
    onOutcome(outcome: Outcome): void
    /** 边界已越过（**尽力而为**——有些边界无法确认，见 §2 要点 4） */
    onDispatched?(): void
    /** 进度通知（仅供观测，**不参与任何判定**） */
    onProgress?(): void
  }): void

  /** 取消**请求**——不是强制；由执行器决定何时响应（[06](./06-contracts.md) §6） */
  cancel?(callId: CallId, reason: string): void
}

type Outcome =
  | { kind: 'done',      result: unknown }
  | { kind: 'failed',    cause: string, dispatched: boolean }   // dispatched 决定"能否重做"归谁判断
  | { kind: 'cancelled' }                                        // 执行器**确认已停止**——释放配额的前提
  | { kind: 'uncertain', cause: string }                         // 已派发，但结果未知
```

**`Outcome` 里为什么必须有 `cancelled` 与 `dispatched`**（评审指出的两处缺口）：

| 缺口 | 后果 | 修法 |
| --- | --- | --- |
| 没有"确认停止"这一态 | `uncertain` 只说明"结果未知"，**不能证明底层操作已停**；此时若释放配额，会出现"旧操作还在跑、配额已分给别人"的**超额并发**（子进程、远端请求尤甚） | `cancelled` 由执行器在**确认停止**时回报；在此之前该调用**仍占着配额** |
| `failed` 不区分"是否已派发" | 上层无法知道"这次失败能不能安全重做"（未派发 = 一定零效果；已派发 = 可能已产生部分效果） | `failed` 带 `dispatched`；**重做与否由上层依幂等协议判断**（[02](./02-runtime-core.md) §6） |

**取消是请求，不是强制**：`cancel()` 只表达"我不再需要这个结果"，执行器可以忽略、可以延迟响应——**要等到 `cancelled` 回报，才算"确认停止"**。

### 四个设计要点

**（1）`start` 必须非阻塞。**

这是调度器循环成立的前提：调度器取一个就绪的 Turn、启动它的下一个调用、再回来取下一个。若 `start` 阻塞，它会把调度器一起卡住。

**（2）Runtime 不判断"有没有副作用"。**

`Executor` 接口里**刻意没有**任何关于"该调用是否会改变外部世界"的字段，因为这个问题**没有可靠的事实来源**：

| 来源 | 是否可靠 |
| --- | --- |
| 内部工具的静态声明 | 只覆盖自有工具；且同一工具不同参数性质不同（`run_shell` 跑 `ls` vs `rm`） |
| MCP 等外部工具的声明 | **协议不要求声明副作用**，拿不到 |
| 从参数推断 | 无固定算法（shell / 脚本 / 动态代码无法静态分析） |

**不可依赖的信息不能进入机制。** 因此 Runtime 只依据**我方行为的两个确定事实**：

| 问题 | 可靠性 |
| --- | --- |
| 我的请求发出去了吗？ | **确定**（`start` 被调用即已派出） |
| 我拿到确定的回应了吗？ | **确定** |

由此只有三个格子，且**"未派发 + 结果未知"这一格不存在**——未派发的情况永远是确定的：

| | 结果确定 | 结果未知 |
| --- | --- | --- |
| **未派发** | `failed`（预算耗尽 / `P` 超时：零副作用，可安全重做） | —（不可能） |
| **已派发** | `done` / `failed` | `uncertain` |

**`uncertain` 的含义是"我不知道"，不是"我判断它可能有副作用"。**

**（3）判"能不能重做"是语义问题，由决策方问模型——而那就是一个调用。**

"这个操作重做安全吗"与"这个操作安全吗"是**两件正交的事**：

| 操作 | 安全吗 | 重做安全吗 |
| --- | --- | --- |
| `send_message` | 安全 | **不可重做**（重复发消息） |
| 读敏感文件 | **不安全** | 可重做（读操作无效果） |
| `ls` | 安全 | 可重做 |
| `rm -rf` | 不安全 | 不可重做 |

四种组合都存在，因此**不能用一方的结论替代另一方**——**"副作用判断"不属于安全策略模块的职责**。

归属规则是"**谁需要这个答案，谁发起**"（与共识 5 的"发起去中心化"一致）：

| 需要什么答案 | 发起者 |
| --- | --- |
| 这个操作安全吗 | 安全策略模块 |
| **这个操作能重做吗** | **决策方（编排层）**——它要决定"要不要重做" |

决策方的手段：

```text
有可靠依据（幂等键、自有工具元数据）  → 直接决定，零等待
没有                                → 发起一个调用问模型 / 问人（普通调用，无新机制）
仍不确定                            → 保守：不自动重做，上抛给人
```

**唯一不依赖对面声明的重做安全手段是幂等键**：由我方生成，重做时使用同一个键，**由接收方负责去重**——它把责任变成对面的协议义务，而不是我方需要推断的事实。

**（4）派发边界不是"一次调用"，而是"三个状态"。**

早先写的是"`start` 被调用即已派出"——**这过于乐观**。执行器从"被调用"到"请求真的出去"之间有窗口：

| # | 状态 | 由谁确认 |
| --- | --- | --- |
| 1 | **派发意图已持久化**（"我决定要派发"） | Runtime（本地写入） |
| 2 | **执行器已启动**（`start` 被调用） | Runtime |
| 3 | **边界已越过**（请求真的出去了） | 执行器——**若它能确认** |

崩溃落在这些状态之间时的处置：

| 崩溃位置 | 处置 |
| --- | --- |
| **1 之前** | 未派发 ⇒ 可安全重做 |
| **1 之后、3 确认之前** | **`uncertain`（保守）**——它可能已经发出，也可能没有 |

**为什么必须保守**：本地写入与外部派发**无法组成原子事务**（[02-runtime-core.md](./02-runtime-core.md) §4 的"派发意图"）。而**幂等键只有在接收方支持去重时**才能缩小这类不确定性——它不能替代这条规则。

**所以"准备"前移为编排（[02](./02-runtime-core.md) §2）只是把窗口缩小、不能消除它**——序列化参数、建立连接这些动作仍在执行器内部。

---

## 3. 状态钩子（Hooks）

```ts
interface Hooks {
  /** 调用状态发生转移 */
  onCallTransition?(call: Call, from: CallState, to: CallState): void

  /** 调用结算（终态）。这是"提交"的落点。 */
  onCallSettled?(call: Call, outcome: Outcome): void | Promise<void>

  /** 事实已追加（用于投影、审计、UI） */
  onFactsAppended?(facts: readonly Fact[]): void
}
```

### 两种钩子语义必须分开

| | 语义 | 失败时 |
| --- | --- | --- |
| **commit** | 提交事实，必须成功 | 进入提交状态机（`rolled_back` / `reconciling`），可能使调用结算为 `uncertain` |
| **observe** | 观测（审计、UI、指标） | 仅记录诊断，**不影响状态机推进** |

现状中的 `criticalModelResponseProjection` / `criticalToolProjection` 等开关就是这条区分的雏形。目标形态把"critical 与否"从"回调开关"提升为**接口语义**：`onCallSettled` 天然是 commit，其余天然是 observe。

**纪律**：observe 类钩子的异常绝不能改变执行结论。这是"审计失败不得导致业务失败"的保证。

---

## 4. 唤醒：没有独立的"唤醒源"

旧设计里有一个"唤醒源"扩展点（外部调 `runtime.signal(condition)`）。**新模型下它不存在了**——"唤醒"被三处吸收：

| 唤醒场景 | 由谁触发 | 怎么触发 |
| --- | --- | --- |
| **配额被归还** | **许可对象** | `V` 之内：`count += 1` → `wake_one`（[03-scheduler.md](./03-scheduler.md) §5） |
| **调用完成** | **执行器** | `onOutcome`（§2） |
| **超时** | **时钟** | `P` 挂起时注册的定时器到期 |

**没有"集中唤醒入口"这个东西**——每个等待者挂在**它自己那个配额对象**的 `waiters` 上，唤醒是"该对象被归还时顺手完成的"，不需要中央分发。

> 这也消掉了一类问题：旧模型需要"集中入口"是为了避免"一个事件同时满足多个条件时重复唤醒或漏唤醒"。新模型里不存在这个问题——**每个等待者只挂在一个队列上**（[02-runtime-core.md](./02-runtime-core.md) 不变量 I5），`V` 只唤醒它自己队列里的下一个。

---

## 5. 时钟（Clock）

```ts
interface Clock {
  now(): number
  schedule(at: Instant, callback: () => void): Cancel
}
```

时钟有两个用途，且**仅限这两个**：

| 用途 | 说明 |
| --- | --- |
| **超时** | `P(names, { timeout })` 挂起时注册定时器；到期则让该 `P` 失败 |

### 判据 2 的守门人

[01-positioning.md](./01-positioning.md) 的设计判据 2 是"**删掉所有 timer 后系统是否仍正确**"。时钟是唯一允许引入定时器的地方，因此：

- **允许**：超时、定时唤醒——它们是**状态转移的输入**（时间到了这件事本身是一个事实）
- **禁止**：任何"用来猜状态"的轮询。若某逻辑需要用 timer 判断"某个东西现在应该是什么状态"，说明状态没有单一权威源

现状的反例可直接对照：2s checkpoint 轮询、5s `finishingWindowMs`、30s 进度超时，都不属于上述两类用途。

---

## 6. 排序策略（Ordering）

```ts
interface Ordering {
  compare(a: Call, b: Call): number
}
```

默认：`(priority, submitSeq)` —— 优先级相同时先到先服务。

它是**策略**，因此下列需求全部是替换这个排序键，而不是改调度器：

| 需求 | 如何表达 |
| --- | --- |
| 交互优先于后台 | `priority` 比较键 |
| 年龄提升（防饥饿） | 在 `compare` 里加入"等待时长"权重 |
| 每会话保底槽 | 在 `compare` 里给长时间未获配额的会话加权 |
| 加权公平 | 按配额消耗速率归一化 |

**这些在现状架构里做不到**——等待者分散在 14 处方队列里，没有任何一处能看到完整的等待集合，因此无法做全局排序。

---

## 7. 持久化端口（FactLog）

```ts
interface FactLog {
  append(facts: readonly Fact[], expectedVersion: number): Promise<AppendResult>
  read(since?: number): Promise<readonly Fact[]>
}

interface SnapshotStore {          // 可选：性能优化
  save(snapshot: RuntimeSnapshot): Promise<void>
  load(): Promise<RuntimeSnapshot | undefined>
}
```

| 端口 | 地位 | 失败时 |
| --- | --- | --- |
| `FactLog` | **真相** | 导致提交状态机进入 `rolled_back` / `reconciling` |
| `SnapshotStore` | **性能优化** | 只是重放更多事实，**不影响正确性** |

**这条区分是本次设计最大的单点简化**：现状中 checkpoint 失败会导致状态丢失，因此有 3 次重试、100ms 退避、`checkpointFailed` 集合、`retryCheckpoint()` 入口。目标形态里 checkpoint 只是"避免全量重放"的快照，**它把一个问题从正确性降级为性能**。

`FactLog` 的接口要求（与现状 `history.ts` 同源）：

- 幂等追加（幂等键 + 事件 ID）
- 版本 / 序号校验（`expectedVersion`）
- 只追加，不修改、不删除（不变量 I6）
- 载荷必须是规范 JSON（可序列化、可比较）

---

## 8. 扩展点与"第一原则"

回到 [README](./README.md) 第一原则，本篇所有扩展点都是"机制"：

| Runtime 提供机制 | 装配提供策略 |
| --- | --- |
| `Executor` 接口（非阻塞 `start` + `onOutcome`） | 有哪些执行器、各处理什么 `executorKind` |
| `Hooks` 的 commit / observe 二分 | 挂哪些钩子、做持久化还是审计 |
| 配额对象自带的 `waiters` | 谁与谁共享一个配额（即唤醒范围） |
| `Clock` 接口 | 超时设多久、哪些地方用定时 |
| `Ordering` 接口 | 排序规则（优先级、年龄、保底） |
| `FactLog` / `SnapshotStore` 接口 | 存储实现（SQLite / 内存 / 远端） |

---

## 9. 下一篇

- 契约（调用的输入输出、执行器回报、观测接口）：[06-contracts.md](./06-contracts.md)
