# 八、与现状的映射与验收

> 本篇把目标设计与现状逐项对齐：术语映射、配额池归属、park 残骸清理、`turn.ts` 收缩预测、迁移路径、验收判据与非目标。

---

## 1. 术语映射

| 现状符号 / 概念 | 目标概念 | 说明 |
| --- | --- | --- |
| `Turn`（现状语义偏近"一轮模型交互"） | **Turn**（完整任务） | 语义对齐 |
| `modelTurns` 计数 | **Step** | 一次模型请求 |
| —（无独立概念） | **调用** | 执行分片，调度的基本单位 |
| `scheduler.ts` `ToolScheduler` | **调度器** | 就绪队列 + 选择 + 执行（现状：**无生产调用者**） |
| `capacity.ts` `CapacityLedger` | **配额**（`count` + `waiters`） | |
| `admission` / `callAdmissionGate` | **配额**（`call:global` / `call:lane:*`） | 判定逻辑保留，机制统一 |
| `TurnCoordinator` | **状态投影 + Hooks** | 8 个状态 Map + 3 处定时器 → 投影 + 钩子 |
| `history.ts` | **FactLog** | 事件 kind 需按"事实纪律"重审 |
| `checkpointQueue` / `storage.checkpoint` | **SnapshotStore** | 从正确性机制降级为性能优化 |
| `AbortSignal` / `chatCancelRegistry` | **`cancel()`** | |
| `sessionLedgerFor*`（9 个钩子） | **Hooks** | 手工对账 → 状态投影 |
| `confirmationCommit` | **提交状态机**（通用化） | 从审批专有提升为所有调用的通用机制 |
| `recoverTurn` / `rebuildInvocationStates` | **`project()` + 恢复规则** | 推断 → 投影（见 [07-failure-and-recovery.md](./07-failure-and-recovery.md) §3） |
| `park` / `resume` / `ParkedAdmission` / `ResumeWaiter` | **无对应物** | 由"配额声明 + `P` 失败即阻塞"自然替代 |

### 影子调用：一类需要收编的现状代码

现状里有一类代码：**带等待，但不经过任何框架**。它们自己实现超时、取消、并发去重，而且往往**绕过 SDK 的抽象**。它们不是"框架管不到"，而是**当初写的时候没往框架里放**。

| 位置 | 它在等什么 | 自建了什么 | 绕过什么 |
| --- | --- | --- | --- |
| `electron/skills/skillRouter.ts` 的 `routeSkills` | LLM 返回（"该用哪些 Skill"） | `timeoutMs`（默认 15000）、`AbortController`、`inFlightBySession` 去重 | **`ModelProviderRegistry`**（直接 `createAnthropicClient`） |

**为什么它是问题**——它是一次真的在等外部的调用，却：

- **不占 LLM 配额**（自己直接打 API，绕过准入）
- 超时是私有常量（`?? 15000`）
- 取消靠自建 Map，不走 `cancel()`
- 不被 `inspect` / `explain` 看见，**不进事实流**
- 因此**恢复时无从得知它当时在做什么**

**收编方式**：把它变成一次普通调用（`kind: 'skill-route'`）。于是自建的三样**全部可以删掉**——

| 自建的 | 收编后由谁提供 |
| --- | --- |
| `timeoutMs`（外层 abort 定时器，默认 15000） | **`CallRequest.deadline`**——它是**唯一生效**的超时 |
| `timeoutMs`（传给 `callRoutingLlm` 的那个） | **直接删**——它是**死参数**：被解构后从未使用 |
| `AbortController` + 监听 | `runtime.cancel()` / `CallRequest.signal` |
| `inFlightBySession` 去重 + `prev?.abort()` | **删**（**不是配额**——见下） |

**识别方法**：搜"宿主侧带 `await`、且**直接构造外部客户端**"的代码——它们都是候选。**每一个都是"等待藏在框架外"的实例**，也都是这条设计原则的反例。

---

## 2. 配额池归属

现状中"配额 + 队列"的实现至少 **17 处**。目标形态下它们全部收敛为**一个配额机制 + 若干具名配额配置**：

| # | 现状位置 | 目标归属 |
| --- | --- | --- |
| 1 | SDK `runtime/semaphore.ts` `Semaphore` | 配额机制（容量）本体 |
| 2 | SDK `McpConcurrencyGate` | 配额 `mcp:global` / `mcp:server:*` |
| 3 | `electron/mcp/semaphore.ts` | 同 #2（**重复实现**） |
| 4 | `electron/mcp/mcpToolExecutor.ts` 的 `globalSemaphore` / `perServerSemaphores` | 同 #2（**第二份重复**） |
| 5 | `turn.ts` `approvalSlots = new Semaphore(2)` | 配额 `approval:slot` |
| 6 | `turn.ts` `ApprovalCandidateSlots(2, …)` | 配额 `approval:candidate` |
| 7 | `turn.ts` `mapWithConcurrency(toolCalls, 2, …)` | 调度器（就绪队列 + 选择） |
| 8 | `capacity.ts` `CapacityLedger` | 配额机制（容量） |
| 9 | `resourceLock.ts` `ResourceLockRegistry` | **保留冲突判定**（祖先 / `unknown` 屏障属"关系推理"，配额表达不了）；只把**生命周期**交给 Runtime（[04](./04-quota-and-guards.md) §3） |
| 10 | `scheduler.ts` `ToolScheduler` | 调度器 |
| 11 | `approval.ts` `ApprovalAdmission` | 配额 `approval:*` |
| 12 | `electron/runtime/callAdmissionGate.ts` | 配额（`call:global` / `call:lane:*`） |
| 13 | `electron/butler/butlerAdmission.ts` | 配额 `automation:*` + **速率型预算** |
| 14 | `electron/remote/remoteTaskController.ts` / `remoteTaskBudget.ts` | 配额 `remote:*` |
| 15 | `src/shared/checkpointQueue.ts` | **不是配额** → `SnapshotStore` 的写入串行化 |
| 16 | `electron/sessionEvents.ts` 的 `enqueueCommit` / `pendingChunks` | **不是配额** → `FactLog` 的实现细节 |
| 17 | `electron/sessionCompactionLock.ts` 的 `withSessionTurnAdmission` | 会话级**租约**（`session:<id>`——**不是许可**，见 [04](./04-quota-and-guards.md) §2）——**不在 `callAdmissionGate` 之内**，此前未计入本表 |
| — | `callAdmissionGate` 的 `waiters` + `resumeWaiters` | 配额自带的 `waiters`（`resumeWaiters` 随 park 删除） |

**#15 / #16 的处理值得注意**：它们的语义是"保证写入顺序"，不是"限制并发"。按 [README](./README.md) 的分类，**定序类不合并进配额，但共用同一套等待基础设施**。

### 五类语义不能都化约为"计数信号量"

上表把每处都映射成"具名配额"，但**它们的语义并不相同**。迁移时必须逐类确认——**可以共享底层设施，但语义与验收测试各自独立**：

| 语义 | 现状实例 | 能否化约为具名容量 | 目标形态 |
| --- | --- | --- | --- |
| **并发限流** | `toolExecutionConcurrency: 2`、`McpConcurrencyGate`、`ApprovalAdmission` | **能** | 具名配额（容量 N） |
| **资源互斥** | `ResourceLockRegistry`（`unknown:*` 与一切冲突；路径祖先冲突） | ❌ **不能化约**——祖先关系属"关系推理"，配额只能表达**精确同名**（[04](./04-quota-and-guards.md) §3） | **保留现有冲突判定**，只把生命周期交给 Runtime |
| **速率限制** | `butlerAdmission` 的"每小时上限" | **不能**——它是"窗口内次数"，不是"同时占用数" | **预算**（窗口型） |
| **单飞去重** | `skillRouter` 的 `inFlightBySession` | **不能**——容量 1 是"串行排队"，**不是"合并 / 丢弃"** | **编排层语义** |
| **最新请求覆盖** | `skillRouter` 的 `prev?.abort()` | **不能**——同上 | **编排层语义** |
| **定序** | `checkpointQueue`、`sessionEvents.enqueueCommit` | **不需要**——它不是限流 | 共用等待基础设施即可 |

**只有前两类能靠"具名容量"表达；后三类要各自建模**，但可以共用同一套等待 / 唤醒基础设施（[03](./03-scheduler.md)）。

> **收编 Skill 路由时的两处具体风险**：① 现状的 15 秒超时覆盖**整个外部调用**，应映射为 `deadline`——**不能用 `P` 的 `timeout` 替代**（后者只覆盖"等容量"）；② `inFlightBySession` + `prev?.abort()` 实现的是"**最新请求覆盖**"（丢弃旧的），与"容量 1 的**串行排队**"是**不同语义**，不能化约。

---

## 3. park 残骸清理（及同类"迁移未收尾"残留）

| 位置 | 现状 | 处置 |
| --- | --- | --- |
| SDK `scheduler.ts` `InvocationRuntime` 的 park 家族 | 已删（2026-09-30） | 完成 |
| SDK `invocation.ts:295` 的 `park(...)` 方法签名 | 残留 | 删 |
| SDK `history.ts` 的 `invocation-parked` kind + 恢复分支 | 残留 | 停止写入；读取兼容保留一个版本 |
| 宿主 `CallAdmissionGate.park` / `resume` / `discard` | **生产零调用者，仅测试覆盖** | 删 |
| 宿主 `ResumeWaiter` / `parked` / `resumeInflight` | 同上 | 删 |
| 宿主 `wakeNext()` 的双队列合并排序 | 因 park 而存在 | 删（单队列后不需要） |
| `docs/develop/interface/host-ports.md` 的 park 差异说明 | 文档残留 | 删 |
| **`skill:route` IPC 旧通道**（`agentProtocolIpc.ts` handler + `preload.ts` 暴露 + `api.ts` 类型 + 4 处测试 mock） | **零生产调用者**——已被 `context-injection-refactor-plan.md`（第 247/496 行）"**路由归 Core**"取代，主进程 `configuring` 阶段已接管 | 删（连同 `inFlightBySession` + `prev?.abort()`） |

**最后一行与 park 是同一类现象**：机制换了、旧入口没设删除截止点，于是留下来，还带着专为它写的防御代码（"防渲染端与主进程同时发起路由"的覆盖逻辑）。**这也正是"清理时必须同时删除对应测试"的原因**——那 4 处 mock 正是它"看起来还有用"的假象来源。

**删除纪律**：这些残留的共同问题是"每一处都有自己的测试保护自己，于是没有一处能被安全删除"。清理时必须**同时删除对应测试**，否则测试会成为删除的阻力——这正是 park 横跨五处存活的原因。

**根因**：`invocation-parked` 是**内部状态转移**被误当作事实写进了事件流。这条错误一旦犯下，就产生了"历史数据兼容"的永久包袱。**内部状态不入事实流**（[02-runtime-core.md](./02-runtime-core.md) §4）。

---

## 4. `turn.ts` 收缩预测

现状 `packages/agent-sdk/src/turn.ts` **1643 行**。其中几乎每个 `await` 都对应一个"本该是独立调用"的操作：

| 现状 `await` 点 | 目标形态 |
| --- | --- |
| `preflightModelRequest(...)` | 调用（可能调模型做压缩） |
| `turnBoundary(...)` | 调用（可能压缩） |
| `recoverProviderAttempt(...)` | **新调用**（重试 = 带事实的模型请求） |
| `recoverOutputLimit(...)` | **新调用**（续写 = 带事实的模型请求） |
| `safetyGate.evaluate(...)` | 调用（等审核 Agent / 等用户） |
| `confirmation(...)` | 调用（等用户，IPC 边界） |
| `resourceLocks.acquire(...)` | **不是调用**——是 `P`（配额等待） |
| `toolExecution.execute(...)` | 调用（等工具） |
| `observer.*` 投影回调 | Hooks |

**预测**：turn loop 从"执行者"变为"编排者"后，体积应降到**百行量级**，且正比于"它编排的步骤数"而非"它内联的操作数"（判据 5）。

---

## 5. 迁移路径

五步，每步都保留"新旧并行、结果必须一致"的验证期：

| 步 | 内容 | 风险 | 验证 |
| --- | --- | --- | --- |
| 1 | **登记**（不改执行）：每次模型 / 工具调用登记为调用，执行路径不变，Runtime 只维护 CallTable 并观测 | 低 | **状态机是否描述得完整**——若出现表达不了的状态，说明状态机还缺东西 |
| 2 | **回报**（不改调度）：执行器回报 `done` / `failed` / `uncertain` | 低 | Runtime 与旧机制对状态的认知是否一致 |
| 3 | **接管最内层**：`mapWithConcurrency` + `Semaphore` + `ApprovalCandidateSlots` → 调度器分发 | 中 | 并发行为等价 + 判据 6（等待都是可见调用） |
| 4 | **逐层收敛**：审批槽、资源锁、MCP（三份合一）、宿主准入 → 具名配额 | 中 | 每收一处，配额实现数应减一 |
| 5 | **切换执行模型**：编排通过 `runtime.call()` 提交，Runtime 统一调度 | 高 | 判据 1–6 全部达成 |

**前两步是关键**：它们**不改变任何行为**，却能验证这个 Runtime 的状态机是否真的能描述现实。如果做不到，后面的都不必谈。

### 并行线：影子调用的收编

影子调用（见 §1 末）是**独立的宿主侧代码**，不依赖主线的任何一步——**只要有 `runtime.call()` 就能开工**，因此它是一条可以最早启动、且不占关键路径的并行线：

| 步 | 内容 | 风险 | 验证 |
| --- | --- | --- | --- |
| **S1** | 把影子调用改为经 `runtime.call()` 提交（如 `kind: 'skill-route'`） | 低 | 行为等价（同超时、同取消语义），但**变得可观测、可限流** |
| **S2** | 删掉它自建的 `timeoutMs` / `AbortController` / 去重 Map | 低 | 这三样能力已由 Runtime 提供（`P` 的 `timeout`、`cancel()`、配额容量） |

**为什么值得优先做**：

1. 它**不占关键路径**，收益却立刻可见——这类调用从"看不见的等待"变成"可观测、可限流、可恢复的调用"
2. 它是**检验这个 Runtime 是否好用的第一个真实用例**——如果连一个影子调用都收编不顺，说明 `call()` 的接口形状有问题，那时改动成本最低

### 迁移纪律

> **每一步的旧机制都必须设明确的删除截止点。**

否则会重演 park 的命运：新机制上线了，旧队列因为"还有测试罩着"永久留下，变成第 17 处。

---

## 6. 验收判据

### 设计判据（[01-positioning.md](./01-positioning.md) §5）

| # | 判据 | 现状 | 目标 |
| --- | --- | --- | --- |
| 1 | 新增一条约束需要改几处 | 多层多处 | **1 处**（组件/配置） |
| 2 | 删掉所有 timer 后系统是否仍正确 | 否 | 是 |
| 3 | `project(events)` 是否与实际渲染一致 | 无此投影 | 是（属性测试） |
| 4 | 业务代码里是否还有配额词汇 | 多处 | 0 处 |
| 5 | turn loop 体积正比于什么 | 内联的操作数（1643 行） | 编排的步骤数 |
| 6 | 链路中"会等待"的环节是否都是可见调用 | 否 | 是 |

### 量化指标

| 指标 | 现状 | 目标 |
| --- | --- | --- |
| 配额 / 队列实现数量 | ≥ **17** | 1（配额机制）+ 1（调度器） |
| 唤醒协议种类 | 3（交接式 / 循环扫描 / 合并排序） | 1 |
| `queued` 手工同步点 | 9 | 0 |
| **"猜状态"类 timer** | 3（2s checkpoint、5s finishing、30s 进度）——**`model.ts` 的流空闲超时不在此列**（它识别"Provider 无进展"），已移出统计 | 0 |
| **行为变更登记** | 0（散落在讨论里） | **全覆盖**——全部进 [10](./10-implementation-plan.md) §10 的「行为变更登记」（C1–C4） |
| MCP 并发闸实现份数 | 3 | 1 |
| park 存活位置数 | 5 | 0 |
| **影子调用**（自建超时 / 取消 / 去重的宿主侧等待） | ≥ 1（`skillRouter.routeSkills`） | **0** |
| 恢复逻辑的推断分支 | `owned` / `residue.turnId` / `owned.turnId` 三路 + cancelled/failed 分流 | 0（投影 + 一条规则） |

### 承诺 vs 机制兑现

设计稿里的每一句"承诺"都必须有机制兑现——否则它就是**过度承诺**。把评审发现的问题固化成这张表，它就变成**常设检查项**：

| 承诺 | 由什么兑现 | 状态 |
| --- | --- | --- |
| **终态不可逆** | `settling` 非终态 + 提交先于终态（[02](./02-runtime-core.md) §2、§6） | **已兑现** |
| **调度统一** | 所有调用进就绪队列、由调度器选中才执行（[03](./03-scheduler.md) §10 的 L7） | **已兑现** |
| **等待都可见** | `P` + `runtime.call()` | **部分**——影子调用尚未收编（§1 末） |
| **事实可重放** | `project(snapshot, events)` | **前提待补**——"派发意图"等事实尚未全部进入持久协议（[02](./02-runtime-core.md) §4） |
| **checkpoint 只是性能优化** | 事实流足以重建一切 | **待兑现**——它依赖上一行（[07](./07-failure-and-recovery.md) §3.2） |
| **恢复只有一条规则** | `uncertain` + 未派发重建 | **部分**——半完成 Step 需中途重入（[07](./07-failure-and-recovery.md) §3.5） |
| **旧机制可替换** | 五类语义分别建模 | **部分**——并发限流可替换；速率 / 单飞 / 覆盖各自建模（§2 末） |
| **Turn 所有权不被降级** | **第三类配额（租约）** + 归属校验（[README](./README.md) 共识 10、[04](./04-quota-and-guards.md) §2） | **已补**——评审纠正了"用容量 1 的许可表达"的错误 |
| **行为差异可追溯** | [10](./10-implementation-plan.md) §10 的「**行为变更登记**」（C1–C4） | **已建立** |

**用法**：新增任何设计承诺时，同时填一行"由什么兑现"。**填不出来，就说明它是过度承诺。**

---

## 7. 非目标

| 不做 | 原因 |
| --- | --- |
| **不做抢占式时间片** | 异步模型里并发不消耗本机执行能力；不存在"某调用赖着不让"的场景 |
| **不做 park / resume** | 它是"执行单元太粗"的产物；分片细化到调用后自然消失 |
| **不做"全局单一槽"** | 配额是具名配额的集合，不是一个数字（见 [README](./README.md) 第一原则） |
| **不在 Runtime 里写死配额作用域** | 隔离与共享是配额命名的结果，属装配决策 |
| **不把配额 / 预算的具体数值放进 Runtime** | 数值是策略 |
| **不改业务语义** | Turn / Step 编号规则、审批语义、安全策略粒度（按调用逐一评估）均不变 |
| **不让 Runtime 认识业务概念** | "审核""压缩""grep"只能是 `kind` 与 `intent` 的取值，不是 Runtime 的分支 |
| **不允许新增影子调用** | "带等待但绕过框架"的代码必须改为 `runtime.call()`——否则可观测性、限流与恢复都会漏掉一块（见 §1 末）。**它同时也是一条正向要求**：任何新的"等外部"都必须以调用的形态出现 |

---

## 8. 全篇回顾

```text
README          定位、第一原则、概念对齐、14 条共识
 01 定位与目标   现状四症状、为什么不收敛、目标模型、职责边界、6 条判据
 02 Runtime 主体 组成、**Call 状态机**（主体是 Call 而非"执行流"）、不变量、事实流、投影、提交、运行阶段、编排边界
 03 许可与调度   许可对象、P/V、调度器、唤醒策略、7 条不变量
 04 配额与保护   准入即 P、许可/预算/**租约**、作用域、保护逻辑、死锁、优先级
 05 扩展点       执行器、钩子、时钟、排序、持久化端口
 06 契约         调用的输入输出、回报到提交、观测与控制、嵌套身份
 07 异常与恢复   结算规则、持久化与 checkpoint、恢复、Runtime 级异常、跨边界、死锁
 08 映射与验收   术语映射、配额归属、影子调用、park 清理、收缩预测、迁移、判据、非目标
 09 组装         装配契约、能力元数据、执行器按边界分、动态注册、compose、纪律
```

**一句话总结**：

> **Runtime 持有执行状态；调度器负责"就绪队列 → 选择 → 执行"；一切限制都是具名配额，靠 `P`/`V` 生效——准入就是一次 `P`。调用是调度推进的单位，Turn 与 Step 是语义分组；等待必须以可见调用的形态出现，并落在某个配额对象的 `waiters` 上。**
