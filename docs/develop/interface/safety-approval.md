# 安全、审批与执行准入

对应源码：`capability.ts`、`safetyPermit.ts`、`safetyGate.ts`、`executionAdmission.ts`、`toolExecutionPort.ts`、`approval.ts`、`confirmationCommit.ts`。

安全链路的顺序是：**能力投影 → 策略决策 → 许可签发 → 许可消费 → 派发声明（dispatch claim）→ 执行**。

## 1. 能力投影（capability.ts）

```ts
type CapabilityLookup =
  | { state: 'known-authorized'; id: string }
  | { state: 'known-unauthorized'; id: string }
  | { state: 'unknown'; requestedId: string }

class CapabilityRegistry {
  define(invocationId: string, knownCapabilityIds: readonly string[], authorizedCapabilityIds?: readonly string[]): void
  lookup(invocationId: string, requestedId: string): CapabilityLookup
  visible(invocationId: string): readonly string[]
  remove(invocationId: string): void
}
```

- `define` 的 `authorizedCapabilityIds` 缺省等于已知集；授权集必须是已知集的子集，否则抛 `authorized capability must be known`。
- `lookup` 未定义调用或未在已知集内 → `unknown`。
- `visible` 返回冻结的授权集数组；`remove` 在调用结束时清理。
- 该类只做**投影**，永不暴露执行器句柄。

## 2. 许可（safetyPermit.ts）

```ts
type PermitBinding = Readonly<{
  requestId: string; turnId: string; invocationId: string; toolCallId: string
  capabilityId: string
  inputSnapshotHash: string; planDigest: string; factsDigest: string
  authorizationVersion: string
  phase: 'initial-compat' | 'recheck'
}>

type PermitConsumeResult = { ok: true } | {
  ok: false
  reason: 'UNKNOWN' | 'BINDING_MISMATCH' | 'EXPIRED' | 'CANCELLED' | 'CONSUMED' | 'AUTHORIZATION_STALE'
}

interface SafetyPermitStore {
  issue(binding: PermitBinding, expiresAt: number): string   // 返回 permitId
  consume(permitId: string, expected: PermitBinding): Promise<PermitConsumeResult>
  invalidateInvocation(requestId: string, reason: 'cancelled' | 'revoked' | 'expired'): void
  invalidateBinding(requestId: string, invocationId: string, reason: 'cancelled' | 'revoked' | 'authorization-changed'): void
  clearInvocation(requestId: string): void
  settle(permitId: string): void
}
```

`InMemorySafetyPermitStore`（参考实现）：

- `issue`：`expiresAt` 必须有限且在未来，否则抛错；permitId 用 `crypto.getRandomValues`（24 字节 hex），随机源缺失抛 `secure random source unavailable`。
- `consume` 判定顺序：不存在 → `UNKNOWN`；已消费 → `CONSUMED`；已失效 → 记录原因（`CANCELLED` / `AUTHORIZATION_STALE`）；过期 → 置 `invalid` 并返回 `EXPIRED`；调用级失效命中 → 置 `invalid` 并返回；绑定级失效命中 → 置 `invalid` 并返回；`sameBinding` 不符 → `BINDING_MISMATCH`；否则置 `consumed` 并 `{ ok: true }`。
- `sameBinding` 逐字段比较全部 10 个 `PermitBinding` 字段。
- `invalidateInvocation` 的 `reason` 映射：`cancelled → CANCELLED`，其余（`revoked` / `expired`）→ `AUTHORIZATION_STALE`。
- 生产宿主只应在**单次调用生命周期**内持久化。

## 3. 策略决策与门控（safetyGate.ts）

```ts
type SafetyPolicyDecision =
  | { kind: 'allow'; authorizationVersion: string; expiresAt?: number }
  | { kind: 'ask'; confirmationId: string; answerer: 'user' | 'agent'; reasonCode: string; context?: unknown }
  | { kind: 'deny'; reasonCode: SafetyDenyReason; userMessage?: string }

type SafetyDenyReason =
  | 'UNKNOWN_CAPABILITY' | 'UNAUTHORIZED_CAPABILITY' | 'MISSING_MATERIAL' | 'RULES_FLOOR_VIOLATED'
  | 'POLICY_DENY' | 'FACTS_CHANGED' | 'STALE_AUTHORIZATION' | 'SHELL_PRECHECK_DENY' | 'FILE_AUTO_APPROVAL_DENY'

type SafetyPolicyPort = { evaluate(input: PermitBinding & { capability: CapabilityLookup; signal?: AbortSignal }): Promise<SafetyPolicyDecision> }
type SafetyPolicyResolver = (binding: PermitBinding) => SafetyPolicyPort

type SafetyGateResult =
  | { kind: 'allow'; permitId: string; authorizationVersion: string; phase: PermitBinding['phase'] }
  | Extract<SafetyPolicyDecision, { kind: 'ask' }>
  | { kind: 'deny'; reasonCode: SafetyDenyReason }

class SafetyGate {
  constructor(deps: { capabilities: CapabilityRegistry; permitStore: SafetyPermitStore; policy?: SafetyPolicyPort; resolvePolicy?: SafetyPolicyResolver })
  evaluate(binding: PermitBinding, signal?: AbortSignal): Promise<SafetyEvaluation>   // SafetyEvaluation = SafetyPolicyDecision
  authorize(binding: PermitBinding, signal?: AbortSignal): Promise<SafetyGateResult>
  discardPermit(permitId: string): void
}
```

- 构造时 `policy` 与 `resolvePolicy` 至少给一个，否则抛 `safety policy is required`。
- `evaluate`：`signal` 已 abort → `deny('POLICY_DENY')`；能力 `unknown` → `deny('UNKNOWN_CAPABILITY')`；`known-unauthorized` → `deny('UNAUTHORIZED_CAPABILITY')`；策略返回 `allow` 时校验 `authorizationVersion` 与绑定一致，否则 `deny('STALE_AUTHORIZATION')`；策略调用后再查一次 abort。
- `authorize` = `evaluate` → 仅在 `allow` 时 `issuePermit`：缺省有效期 `Date.now() + 30_000`；`issue` 抛错 → `deny('MISSING_MATERIAL')`；成功后返回 `{ kind: 'allow', permitId, authorizationVersion, phase }`。
- `discardPermit`：竞态中把已签发但不再使用的许可 `settle` 掉（turn 循环取消路径会调用）。

turn 循环实际消费的是收窄后的公开面（宿主可显式委托包装，直接赋 `SafetyGate` 实例仍兼容）：

```ts
type SafetyGatePort = Pick<SafetyGate, 'evaluate' | 'authorize' | 'discardPermit'>
```

- `deny` 决策可携带 `userMessage`：turn 循环把它透传成 `ToolDeniedError.userMessage`，`returnDeniedToolsToModel` 开启时作为 `is_error` 工具结果回给模型（模型可见的区分文案）；缺省走通用 fallback。
- `FACTS_CHANGED` 表示"事实在准备与终检之间变化"，与 `STALE_AUTHORIZATION`（授权版本变化）是不同拒绝码，装配方不要混用。

## 4. 执行准入（executionAdmission.ts）

```ts
type ExecutionDispatchLease = {
  markEntered(): void
  close(outcome: 'completed' | 'failed' | 'cancelled' | 'unknown-after-dispatch'): void
}
type BeginDispatchResult =
  | { ok: true; lease: ExecutionDispatchLease; signal: AbortSignal }
  | { ok: false; reason: 'CANCELLED' | 'REVOKED' | 'AUTHORIZATION_STALE' | 'PERMIT_NOT_CONSUMED' | 'BINDING_MISMATCH' }

type ExecutionAdmissionCoordinator = {
  markPermitConsumed(permitId: string, binding: PermitBinding): void
  beginDispatch(permitId: string, expected: PermitBinding, validatePrepared?: () => boolean | Promise<boolean>): Promise<BeginDispatchResult>
  invalidate(binding: Pick<PermitBinding, 'requestId' | 'invocationId'>, reason: 'cancelled' | 'revoked' | 'authorization-changed'): void
  settle(permitId: string): void
}
```

`InMemoryExecutionAdmissionCoordinator` 语义：

- `markPermitConsumed` **只能在** `SafetyPermitStore.consume` 返回 ok 之后调用；claim 不能由许可的存在推导。重复通知是幂等的（不会把已 claim 的许可重置）；同 permitId 但绑定不同 → 抛 `PERMIT_CONSUMPTION_BINDING_CHANGED`。
- `beginDispatch`：未消费 → `PERMIT_NOT_CONSUMED`；绑定不符 → `BINDING_MISMATCH`；已被失效 → 对应 `CANCELLED` / `REVOKED` / `AUTHORIZATION_STALE`；`validatePrepared` 返回 false → `AUTHORIZATION_STALE`。
- **线性化点**：异步校验后重新读取失效状态与 claim 状态，之后到 `permit.claimed = true` 之间没有 `await`，因此"取消 / 撤权"与"派发"有唯一同步顺序。claim 之后新产生的失效作用于该 lease（`invalidate` 会 `controller.abort(reason)`）。
- `settle(permitId)`：删除许可；当同一 `(requestId, invocationId)` 既无兄弟许可也无活动 lease 时，清理失效记录。
- 观测字段：`executorEntries`（累计进入执行器次数）、`closedOutcomes`（permitId → 关闭结局）、`activeLeaseCount(requestId, invocationId?)`。

## 5. permit-bound 执行端口（toolExecutionPort.ts）

```ts
type PermitBoundToolCall = Readonly<{ invocationId: string; toolCallId: string; toolName: string; signal?: AbortSignal }>

type PermitBoundToolExecutionPort<TCall extends PermitBoundToolCall, TResult> = Readonly<{
  [brand]: true   // 私有 unique symbol 品牌；只有 SDK 工厂能产出
  execute(call: TCall, permitId: string, onDispatchClaimed?: (cancel: () => void) => void | Promise<void>): Promise<TResult>
}>

function createPermitBoundToolExecutionPort<TCall, TResult>(deps: {
  permits: SafetyPermitStore
  admission: ExecutionAdmissionCoordinator
  allowedPhase?: PermitBinding['phase']            // V1 宿主需显式 opt-in 'initial-compat'
  resolveExpected(call: TCall): Promise<PermitBinding>
  validatePrepared?(call: TCall, expected: PermitBinding): boolean | Promise<boolean>
  isRevoked?(call: TCall): boolean
  subscribeRevocation?(call: TCall, onRevocation: () => void): () => void
  subscribeAuthorizationChange?(call: TCall, onChange: () => void): () => void
  currentAuthorizationVersion?(call: TCall): string | undefined
  execute(call: TCall, signal: AbortSignal): Promise<TResult>
}): PermitBoundToolExecutionPort<TCall, TResult>
```

`execute` 的固定顺序：

1. `resolveExpected(call)` 后校验 `invocationId` / `toolCallId` / `capabilityId === toolName` / `phase === (allowedPhase ?? 'recheck')`，不符 → `ToolExecutionRejectedError('BINDING_MISMATCH')`。
2. **先订阅**撤权与授权变更（保证排队中的工作也会被失效、活动 lease 会被 abort），再 `isRevoked` 检查、授权版本比对（不一致 → 置 stale 并失效；`currentAuthorizationVersion` 返回 `undefined` 时抛 `CURRENT_AUTHORIZATION_VERSION_UNAVAILABLE`）。
3. `call.signal` 监听：abort 时同时失效许可与准入（`cancelled`）。
4. `permits.consume` → 失败转 `ToolExecutionRejectedError(consumed.reason)` → `admission.markPermitConsumed` → `admission.beginDispatch`。
5. `onDispatchClaimed(cancel)`（SDK turn 循环在此写 `tool-call-started`）；该回调抛错会 `lease.close('failed')` 并原样抛出。
6. **派发前复检**（进入执行器前最后一道同步判定）：`onDispatchClaimed` 可能异步（例如 History 写入），其间 lease 可能被撤销 / 授权变更 / 取消；因此若 `dispatch.signal.aborted`，则 `lease.close('cancelled')` 并按 `signal.reason` 抛 `ToolExecutionRejectedError('REVOKED' | 'AUTHORIZATION_STALE' | 'CANCELLED')` —— 该路径可证执行器**未进入**（turn 循环据此把已写的 `tool-call-started` 提案回退为未派发）。
7. `lease.markEntered()` → `execute(call, dispatch.signal)`；执行成功但 signal 已 abort → 抛 `Execution lease aborted before acknowledgement`；执行抛错 → 一律包成 `ToolExecutionAfterDispatchError`（进入执行器后异常无法证明无副作用），`outcome` 记为 `unknown-after-dispatch`（被 abort 时）或 `failed`。
8. `finally`：移除监听、`admission.settle` 与 `permits.settle`。

相关错误：

```ts
type ToolExecutionRejectReason = PermitConsumeResult 的失败 reason | 'REVOKED' | 'PERMIT_NOT_CONSUMED'
class ToolExecutionRejectedError extends Error   // code = 'TOOL_EXECUTION_REJECTED'
class ToolExecutionAfterDispatchError extends Error  // code = 'TOOL_EXECUTION_UNKNOWN_AFTER_DISPATCH'，持有 originalError
```

`resolveExpected` 必须读宿主私有准备记录与当前调用上下文，**不得**从 permitId 或公开许可字段反推期望值。

## 6. 审批事实与容量（approval.ts）

```ts
type ApprovalStatus = 'requested' | 'queued' | 'evaluating' | 'awaiting-user' | 'submitting'
  | 'approved' | 'denied' | 'unavailable' | 'timed-out' | 'cancelled'   // 后 5 个为终态

type ApprovalCause = 'agent-approved' | 'agent-deny' | 'policy-denied' | 'user-denied'
  | 'approval-queue-full' | 'approval-queue-timeout' | 'provider-rate-limit'
  | 'provider-unavailable' | 'config-error' | 'unparsable' | 'evaluation-timeout'
  | 'cancelled' | 'interrupted' | 'recursion-blocked' | 'facts-changed' | 'authorization-revoked'

interface ApprovalRecord {
  schemaVersion: 1; approvalId: string; attemptId: string; toolUseId: string
  answerer: 'agent' | 'user' | 'policy'
  status: ApprovalStatus; cause?: ApprovalCause
  reason?: { summary: string; nextStep?: string }
  requestedAt: number; queuedAt?: number; startedAt?: number; settledAt?: number
  deadlineAt?: number; retryAfterAt?: number
  revision: number
}

class ApprovalFactStore {
  apply(next: ApprovalRecord): boolean   // false = 被拒（幂等/过期）
  get(approvalId: string): ApprovalRecord | undefined   // 深拷贝
}
```

`apply` 拒绝条件（返回 `false`，不覆盖现有记录）：`attemptId` 不同、`revision` 未递增、当前已是终态。内存事实存储只做规范事实；持久化由宿主的 History 端口承担。

```ts
type ApprovalRequest = { requestId: string; parentTaskId: string; deadlineAt?: number }
type ApprovalLease = { kind: 'granted'; release: () => void }
type ApprovalAcquireResult = ApprovalLease | { kind: 'rejected'; cause: 'queue-full' | 'cancelled' | 'parent-limit' | 'timeout' }

class ApprovalAdmission {
  constructor(options: { concurrency: number; queueLimit: number; maxInFlightPerParent?: number })
  snapshot(): { active: number; queued: number }
  acquire(request: ApprovalRequest): Promise<ApprovalAcquireResult>
  cancel(requestId: string): boolean
}
```

- 审批容量由 runtime 自己持有，**不消耗**应用的 turn 准入计数。
- `concurrency >= 1`、`queueLimit >= 0`，否则抛错。
- `acquire` 立即拒绝的三种情况：`deadlineAt` 已过 → `timeout`；父调用在途数已达 `maxInFlightPerParent` → `parent-limit`；队列已满 → `queue-full`。
- 排队时会为父调用**预留**一个名额（避免惊群式超发）；超时 / 取消 / 出队拒绝时释放预留。
- `cancel(requestId)` 只能取消尚在排队中的等待者（返回是否命中）。
- `release` 幂等；释放后按队列顺序唤醒，逐个重新检查 deadline 与父限额。

## 7. 确认提交（confirmationCommit.ts）

```ts
type CommitPlan = {
  submissionId: string; confirmId: string; sessionId: string; ownerId: string
  generation: number; revision: number
  action: 'approved' | 'denied'; memory: 'written' | 'none'
}

type ConfirmationCommitStatus = 'pending' | 'committing' | 'committed' | 'rolled_back' | 'reconciling' | 'cancelled'
type ConfirmationCommitEvent = { type: 'reserve' | 'commit' | 'rollback' | 'reconcile' | 'cancel' }

type CommitReceipt =
  | { kind: 'committed'; submissionId: string; historyVersion: number; eventId: string }
  | { kind: 'not-committed'; submissionId: string; code: 'storage-failed' | 'stale' | 'wrong-owner' | 'protocol-conflict' | 'invalid-plan'; canResubmit: boolean }
  | { kind: 'unknown'; submissionId: string }

class ConfirmationCommitStateMachine {
  constructor(initial: ConfirmationCommitState)
  get state(): ConfirmationCommitState
  transition(event: ConfirmationCommitEvent): ConfirmationCommitState   // 非法转换抛错
}

class ConfirmationCommit {
  constructor(committer: { commit(plan: CommitPlan): Promise<{ historyVersion: number; eventId: string }> })
  submit(plan: CommitPlan): Promise<CommitReceipt>
  query(submissionId: string): Promise<CommitReceipt | undefined>
  state(submissionId: string): ConfirmationCommitState | undefined
}
```

状态机转换表（唯一共享转换表）：

| 当前 | 事件 | 结果 |
| --- | --- | --- |
| `pending` | `reserve` | `committing` |
| `pending` | `cancel` | `cancelled` |
| `committing` | `commit` | `committed` |
| `committing` | `rollback` | `rolled_back` |
| `committing` | `reconcile` | `reconciling` |

`committing` 之后不允许直接进入 `cancelled`：写入已开始时取消方无法证明授权未落库，必须落到 `rolled_back` 或 `reconciling`。

`submit` 的重试协议：

- 已有 receipt 时，只有 owner（`confirmId` + `sessionId` + `ownerId` + `generation`）一致，且满足「不可重试则 plan 完全一致（同 `revision`、`action`、`memory`）/ 可重试则 `revision` 递增」，才复用或重试；否则返回 `not-committed` + `protocol-conflict`（`canResubmit: false`）。
- plan 字段校验失败（缺 id、`generation`/`revision` 非正整数）→ `not-committed` + `invalid-plan`。
- 同一 `submissionId` 的进行中操作会复用同一个 Promise。
- `committer.commit` 抛 `UnknownCommitError` → `reconcile` + `{ kind: 'unknown' }`；其他错误 → `rollback` + `not-committed` + `storage-failed`（`canResubmit: true`）。
