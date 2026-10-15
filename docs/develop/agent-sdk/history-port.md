# 调用事件流（history.ts）

对应源码：`packages/agent-sdk/src/history.ts`。这是**调用级**的规范事件流：追加、校验、幂等、重启状态重建。

## 事件与端口

```ts
type HistoryEvent = {
  eventId: string
  idempotencyKey: string
  invocationId: string
  turnId: string
  sequence: number
  schemaVersion: number
  kind: HistoryEventKind
  payload: unknown
}

type HistorySnapshot = { invocationId: string; version: number; schemaVersion: number; events: HistoryEvent[] }
type HistoryAppendResult = { version: number; duplicate: boolean }
type InvocationHistoryAppendResult = HistoryAppendResult & { events: readonly HistoryEvent[] }

/** 会话 transcript 的原子提交意图：与终态事件同批落库（会话存储重构后 turn 终态不再依赖宿主双写）。 */
type SessionTranscriptCommitIntent = Readonly<{
  sessionId: string
  baseVersion: number
  outcome: 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted'
  messages: readonly Readonly<Record<string, unknown>>[]
  /** 本轮拥有桌面消息骨架时，同事务镜像该消息的终态。 */
  messageMirror?: Readonly<{ messageId: string; status: 'completed' | 'failed' | 'cancelled'; content?: string }>
}>

interface HistoryPort {
  appendBatch(events: readonly HistoryEvent[], expectedVersion: number, transcriptCommit?: SessionTranscriptCommitIntent): Promise<HistoryAppendResult>
  read(invocationId: string): Promise<HistorySnapshot>
}
```

`transcriptCommit` 只在终态追加时传入：宿主适配器必须把「History 终态事件」与「会话 transcript 提交」放进**同一事务**（失败即整体回滚）；SDK 侧只负责表达意图，不关心其落库实现。`messageMirror` 用于同事务镜像桌面消息骨架的终态（`status` 取值 `completed` / `failed` / `cancelled`）。

`HistoryEvent['kind']` 为闭合联合（18 项，内联在 `HistoryEvent` 上，无独立类型别名）：

`session-input-committed`、`invocation-context-committed`、`transcript-compacted`、`model-request-started`、`provider-retry-scheduled`、`model-attempt-discarded`、`model-response-committed`、`replay-message-committed`、`tool-call-started`、`tool-call-finished`、`tool-call-not-dispatched`、`approval-waiting`、`approval-resolved`、`approval-updated`、`invocation-parked`、`invocation-interrupted`、`invocation-completed`、`invocation-failed`。

## InvocationHistoryWriter

把同一调用的并发生产者串行化成连续的追加流。

```ts
class InvocationHistoryWriter {
  constructor(history: HistoryPort, identity: { invocationId: string; turnId: string; schemaVersion?: number })
  get currentVersion(): number | undefined
  currentOrPersistedVersion(): Promise<number>          // 先 await 内部 tail，再回退到持久化版本
  append(events: readonly { kind: HistoryEvent['kind']; payload: unknown }[], transcriptCommit?: SessionTranscriptCommitIntent): Promise<InvocationHistoryAppendResult>
  appendAtVersion(events, expectedVersion: number, transcriptCommit?: SessionTranscriptCommitIntent, beforeAppend?: () => void): Promise<InvocationHistoryAppendResult>
}
```

- 构造时 `invocationId` / `turnId` 必须非空；空批次以 `HistoryBatchError('history append must not be empty')` 拒绝。
- 每次追加前 `read(invocationId)`，用内部 `version`（或快照版本）作 `expectedVersion`；快照版本不符抛 `HistoryVersionConflict`。
- 事件字段由 writer 生成：`sequence = expectedVersion + index + 1`、`eventId = "<invocationId>:history:<sequence>"`、`idempotencyKey = "<invocationId>:<kind>:<sequence>"`、`schemaVersion` 取自 identity 或快照。
- `appendAtVersion` 是 **SDK 内部的替换钩子**（上下文端口用它写 `transcript-compacted`）：调用方显式给定 `expectedVersion`，与内部版本不一致同样抛 `HistoryVersionConflict`；`expectedVersion` 必须是非负整数（否则 `HistoryBatchError('expected history version must be a non-negative integer')`）；校验与追加**共用同一条 writer 队列**，`beforeAppend` 在队列内、`read` 之后、写事件之前执行（用于 epoch 复检，见 [context.md](./context.md)）。
- 内部 `tail` 链保证串行：前一次操作失败不会阻塞后续追加；`currentOrPersistedVersion()` 也排在队列之后读取，避免拿到"尚未落库的旧版本"。

## 批次校验（validateHistoryBatch）

对每个事件强制：

- `kind` 必须在闭合枚举内。
- `eventId` / `idempotencyKey` / `invocationId` / `turnId` 非空。
- 同批次必须共享 `invocationId`、`turnId`、`schemaVersion`。
- `sequence` 与 `schemaVersion` 必须是正整数。
- `payload` 必须是**规范 JSON**：仅允许 plain object / array / string / number（有限）/ boolean / null；不得含 symbol、非枚举属性或 getter、自定义原型、稀疏数组，数组只允许 `0..length-1` 的数字索引；并要求 `JSON.parse(JSON.stringify(payload))` 与原文稳定串一致。违规抛 `HistoryBatchError`（含违规路径）。
- 同批次内 `eventId` 与 `idempotencyKey` 不得重复。

## 转换校验（validateHistoryTransition）

对 `previous + incoming` 全量重放检查：

- 一个调用的 history 流**不能改变 turn 身份**（所有事件 `turnId` 一致）。
- 已出现**闭合事件**（`invocation-parked` / `invocation-interrupted` / `invocation-completed` / `invocation-failed`）后禁止追加——`invocation-parked` 自存储重构起与终态同权（park 家族下线后不再有"park 后恢复可执行"的路径，旧库中的 parked 事件仍可读）。
- 终态 payload 与 status 匹配：`completed` 要求 `status === 'completed'`；`failed` 要求 `failed` 或 `denied`；`interrupted` 要求 `interrupted` 或 `cancelled`。
- 工具挂起跟踪：`model-response-committed` 的 `message.toolCalls[].id` 与 `tool-call-started` 记为挂起，`tool-call-finished` / `tool-call-not-dispatched` 消解；终态（`completed` / `failed`）时不得仍有挂起工具调用或挂起审批。
- 审批挂起跟踪：`approval-waiting` 记挂起（同一 pending id 重复 → 报错；带 `answerer` / `reasonCode` / `requestedAt` 元数据时必须完整且 `answerer` 为 `user` / `agent`），`approval-resolved` 消解（`approved` 必填布尔；`outcome` 枚举 `approved | denied | timeout | unavailable | cancelled` 且必须与 `approved` 一致；`settledAt`、`answerer`、`cause` 若出现必须合法；不得解消非挂起审批；身份与 `approval-waiting` 记录的 `approvalId` 不一致 → 报错）。
- 终态事件必须是所在批次的**最后一个**事件（`invocation-parked` 同样计入"闭合"，其后不得再有事件）。

## 重启状态重建

```ts
type RebuiltInvocationState = { invocationId: string; state: 'interrupted' | 'completed' | 'failed' | 'denied' | 'cancelled'; lastEventId: string }
function rebuildInvocationStates(snapshot: HistorySnapshot): Map<string, RebuiltInvocationState>
```

- 已完成的终态（`completed` / `failed` / `denied` / `cancelled`）且无挂起工具 / 审批时，直接沿用。
- `invocation-parked` 与 `invocation-interrupted` 一旦出现即视为闭合：状态落 `interrupted`（此时若 `invocation-interrupted` 的 `payload.status === 'cancelled'` 则落 `cancelled`），`lastEventId` 指向该事件，不再向后推导。
- 其余情况的**核心保证**：parked 或 in-flight 的工作在进程重启后**绝不恢复为可执行**——只要存在挂起审批、未消解的工具派发、或未闭合的调用事件（`session-input-committed`、`invocation-context-committed`、`transcript-compacted`、`model-request-started`、`replay-message-committed`、`model-attempt-discarded`、`model-response-committed`），状态一律落为 `interrupted`，`lastEventId` 指向最后的相关事件。
- 无任何终态证据时返回空 Map。

## 辅助导出

```ts
function historyEventsEqual(left: HistoryEvent, right: HistoryEvent): boolean   // 稳定串比较
```

## MemoryHistory（参考实现）

```ts
class MemoryHistory implements HistoryPort {
  constructor(schemaVersion = 1)
  appendBatch(events, expectedVersion): Promise<HistoryAppendResult>   // 未声明第三参：transcriptCommit 在该实现里被忽略
  read(invocationId): Promise<HistorySnapshot>
}
```

> 参考实现刻意不消费 `transcriptCommit`（省略参数仍满足 `HistoryPort`）；只有宿主生产适配器才需要把 History 终态与会话 transcript 放进同一事务。

`appendBatch` 行为顺序：

1. `validateHistoryBatch`（失败即抛，不写入）。
2. `expectedVersion` 必须是非负整数。
3. 批次 `schemaVersion` 必须与流一致，否则抛 `HistoryBatchError`。
4. **幂等命中**：若批次中事件的 `idempotencyKey` 或 `eventId` 已存在，则要求全部逐一等价（`historyEventsEqual`），此时返回 `{ version, duplicate: true }`；只要有一条不等价就抛 `HistoryIdempotencyConflict`。
5. 版本与序号校验：`expectedVersion !== 流长度` → `HistoryVersionConflict`；`sequence !== expectedVersion + index + 1` → `HistorySequenceConflict`。
6. `validateHistoryTransition` 通过后原子写入（`structuredClone`），返回 `{ version, duplicate: false }`。

## 错误类型

| 类 | code | 语义 |
| --- | --- | --- |
| `HistoryVersionConflict` | `version-conflict` | 期望版本与实际不符（持有 `expected` / `actual`） |
| `HistorySequenceConflict` | `sequence-conflict` | 事件序号不连续（持有 `expected` / `actual`） |
| `HistoryIdempotencyConflict` | `idempotency-conflict` | 幂等键 / 事件 id 冲突且内容不等价 |
| `HistoryBatchError` | `invalid-history-batch` | 批次本身非法（形状、kind、canonical JSON、转换规则） |
| `HistoryCorruptionError` | `history-corrupt` | 流损坏（持有 `invocationId`） |
