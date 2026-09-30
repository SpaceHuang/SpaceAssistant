# 生命周期、容量、调度与资源锁

对应源码：`lifecycle.ts`、`capacity.ts`、`scheduler.ts`、`resourceLock.ts`。

## 1. 调用生命周期账本（lifecycle.ts）

```ts
type InvocationTerminalStatus = 'completed' | 'cancelled' | 'failed' | 'denied' | 'interrupted'
type InvocationStatus = 'running' | InvocationTerminalStatus
type InvocationSnapshot = Readonly<{ invocationId: string; status: InvocationStatus }>
type AgentInvocationIdentity = Readonly<{ requestId: string; turnId: string; invocationId: string }>

class InvocationLifecycle {
  constructor(readonly invocationId: string)   // 空字符串抛错
  snapshot(): InvocationSnapshot
  settle(status: InvocationTerminalStatus): InvocationSnapshot | undefined   // 非 running 时返回 undefined（幂等）
}
```

最小、宿主中立的账本：一次调用只结算一次，重复结算被忽略。

## 2. 容量共享账本（capacity.ts）

```ts
type CapacityQueueKind = 'normal' | 'resume'

type CapacitySnapshot = {
  applicationLeases: number
  approvalCandidates: number
  parentApprovalCounts: Record<string, number>
  queuedNormal: number
  queuedResume: number
  queuedTotal: number
}

type CapacityReservation = { release: () => void }

class CapacityLedger {
  constructor(limits: {
    applicationSlots: number
    approvalCandidateSlots: number
    queueLimit: number
    maxApprovalsPerParent: number
  })
  snapshot(): CapacitySnapshot
  reserveApplicationLease(ownerId: string): CapacityReservation | undefined
  reserveApprovalCandidate(parentTaskId: string): CapacityReservation | undefined
  enqueue(kind: CapacityQueueKind, id: string): boolean
  dequeue(id: string): { kind: CapacityQueueKind; id: string } | undefined
}
```

- 构造校验：全部限额必须是非负整数，且除 `queueLimit` 外必须 ≥ 1；否则抛 `invalid capacity limit: <name>`。
- `reserveApplicationLease` / `reserveApprovalCandidate` 取不到名额返回 `undefined`（调用方决定排队或拒绝）。
- `reserveApprovalCandidate` 同时受全局 `approvalCandidateSlots` 与每父调用 `maxApprovalsPerParent` 约束；`release` 幂等并回收父计数（计数归零则删除键）。
- `enqueue` 对重复 id 或队列已满返回 `false`；`dequeue` 按 id 出队，未命中返回 `undefined`。
- 设计意图：application lease、approval candidate、resume / normal 队列是不同维度，但必须从**同一个快照**观察与释放，避免各自维护"看起来空闲"的计数。

## 3. 依赖调度器（scheduler.ts）

```ts
type ToolNode<T> = {
  id: string
  dependsOn?: string[]
  resourceKeys?: readonly string[]
  run: () => Promise<T> | T
  isSuccess?: (value: T) => boolean
  onDependencyFailure?: (dependencies: readonly string[]) => Promise<T> | T
}

class ToolSchedulerReservationError extends Error {
  readonly code = 'tool-reservation-unavailable'
  readonly retryable = true
  constructor(reason?: 'no-progress-subscription' | 'progress-timeout')
}
const DEFAULT_PROGRESS_WAIT_TIMEOUT_MS = 30_000

function canParkInvocation(activeNodeCount: number, waitingApprovalCount: number): boolean

class ToolScheduler {
  constructor(options?: {
    maxConcurrent?: number                              // 缺省 Infinity
    isWaiting?: (id: string) => boolean                  // 节点是否在等待（不占并发）
    tryReserveStart?: (id: string) => boolean            // 启动前预留；false 则节点留在计划中
    releaseStart?: (id: string) => void
    subscribeProgress?: (notify: () => void) => () => void
    progressWaitTimeoutMs?: number                       // 缺省 30_000，必须有限正数
  })
  run<T>(nodes: ToolNode<T>[]): Promise<Record<string, T>>
  runOrdered<T>(nodes: ToolNode<T>[]): Promise<Array<{ id: string; value: T }>>
}
```

调度规则：

- 依赖满足（全部 `dependsOn` 已产出结果）才可运行；无 ready 且无在途时抛 `tool dependency cycle or missing dependency`。
- **未声明 `resourceKeys` 的节点 = 未知副作用**：只能作为单节点串行屏障（有在途节点时不启动；启动后不再并行其它节点）。
- 声明了 `resourceKeys` 的节点之间用资源冲突判定串行；`unknownRunning`（有在途未知副作用节点）时其他节点全部等待。
- `isWaiting` 为真的在途节点不占用 `maxConcurrent` 名额，因此"在途节点都在等审批"不会阻塞后续独立工具。
- 依赖失败时先写 `onDependencyFailure` 结果（缺省 `undefined`）并把该节点标记为失败。
- `isSuccess` 返回 false 的节点进入 failed 集合，供下游作依赖失败处理。
- **预留失败且已无 Promise 可等**时：有 `subscribeProgress` 则等待进度通知（超时转 `progress-timeout`）；没有订阅协议则抛 `ToolSchedulerReservationError('no-progress-subscription')` —— 不允许同步忙等饿死取消、定时器与容量释放。
- 唤醒来源必须显式：completion promise、进度通知；`subscribeProgress` 在 `run` 结束时退订。
- `runOrdered` = `run` 后按输入顺序归并，保证模型 `tool_result` 序列稳定。

资源冲突判定（`resourcesConflict`）：

| 情况 | 结果 |
| --- | --- |
| 键完全相同 | 冲突 |
| 任一侧非 `workspace:` 前缀 | 不冲突 |
| 两侧均为 `workspace:<path>` 且一侧是另一侧的前缀目录 | 冲突 |

路径归一：去掉尾部 `/`（长度 > 1 时），故 `/src` 与 `/src2` 属独立资源。

`canParkInvocation(activeNodeCount, waitingApprovalCount)`：两个计数均为整数、`activeNodeCount > 0` 且 `waitingApprovalCount >= activeNodeCount` —— Core 对 Runtime park 的最小判定（只有没有其它可运行节点时才能让出父租约）。

### InvocationRuntime（调用级运行租约 / park）

```ts
type RuntimeLease = { runtimeId: string; invocationId: string; generation: number; release: () => void }
type ParkHandle = { runtimeId: string; invocationId: string; generation: number; checkpoint: unknown }

class InvocationRuntime {
  constructor(readonly runtimeId: string, options?: { maxParkedTurns?: number })  // 缺省 32，必须正整数
  acquireLease(invocationId: string): RuntimeLease      // 已持有或已 park 时抛 'invocation already leased'
  park(invocationId: string, lease: RuntimeLease, checkpoint?: unknown): ParkHandle | undefined
  resume(handle: ParkHandle): boolean
  resumeLease(handle: ParkHandle): RuntimeLease | undefined
}
```

- `generation` 单调递增；`release` 只在 generation 匹配时生效且幂等。
- `park` 校验 lease 归属（runtimeId / invocationId / generation 匹配且 generation > 0），并在 `parked.size >= maxParkedTurns` 时返回 `undefined`。
- `resumeLease` 重新取得租约；**旧 park handle 只能消费一次**（第二次调用返回 `undefined`）。

## 4. 资源互斥锁（resourceLock.ts）

```ts
type ResourceLease = { release(): void }

class ResourceLockRegistry {
  acquire(keys: readonly string[], options?: { signal?: AbortSignal }): Promise<ResourceLease>
}
```

- `keys` 去重并排序后申请；`signal` 已 abort → 以 `resource-lock-cancelled` 拒绝。
- 无冲突且无等待者时立即授予；否则入队（FIFO）。
- `release` 幂等，释放后唤醒队首可满足的等待者。
- 排队期间 `signal` abort → 从队列移除并以 `resource-lock-cancelled` 拒绝（监听 `{ once: true }`，授予 / 拒绝时移除监听）。
- 冲突判定：

| 情况 | 结果 |
| --- | --- |
| 键相同 | 冲突 |
| 任一侧以 `unknown:` 开头 | 冲突（未知副作用无法证明影响范围，跨会话按全局屏障保守互斥） |
| 两侧均为 `workspace:<path>` 且互为前缀目录 | 冲突 |
| 其它 | 不冲突 |

- keys 需由宿主能力适配器**预先归一**（例如 `workspace:` 前缀），SDK 不做路径解析。
