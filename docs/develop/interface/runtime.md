# runtime 工厂与纯组件核

对应源码：`packages/agent-sdk/src/runtime/createAgentRuntime.ts`、`runtime/components.ts`、`runtime/semaphore.ts`。

无宿主依赖，纯 node 可用；全部跨调用可变状态随实例走。

## createAgentRuntime

```ts
function createAgentRuntime(components?: AgentRuntimeComponents): AgentRuntime
```

| 字段 | 类型 | 缺省 |
| --- | --- | --- |
| `instanceId` | `string` | `randomUUID()`（每次创建不同） |
| `audit` | `RuntimeAudit` | `NOOP_AUDIT` |
| `confirmIds` | `ConfirmIdSpace` | `new ConfirmIdSpace()` |
| `chatCancels` | `ChatCancelRegistry` | `new ChatCancelRegistry()` |
| `toolRevocations` | `ToolRevocationRegistry` | `new ToolRevocationRegistry()` |
| `mcpGate` | `McpConcurrencyGate` | `new McpConcurrencyGate()` |
| `builtinRegistry` | `BuiltinRegistryLike` | 空实现（`get` 恒 `undefined`） |

`audit` / `confirmIds` / `chatCancels` / `toolRevocations` / `mcpGate` / `builtinRegistry` 在 `AgentRuntime` 上均为只读字段；组件可逐项覆盖注入（宿主绑定 SQLite 审计、`TypedToolRegistry` 等桌面能力）。

```ts
interface RuntimeAudit {
  record(event: { type?: string; [key: string]: unknown }): void
  setRetentionDays(days: number): void
  getRetentionDays(fallback?: number): number   // NOOP 缺省返回 180
}
export const NOOP_AUDIT: RuntimeAudit

interface BuiltinRegistryLike { get(name: string): unknown }
```

## ConfirmIdSpace（确认 ID 空间）

```ts
interface ConfirmIdSpaceLike {
  allocate(maxAttempts?: number): string   // 默认 32 次尝试
  release(id: string): void
  isInUse(id: string): boolean
  clear(): void
}
```

- 4 字符 Crockford Base32（字母表去 `I`/`L`/`O`/`U`），由 `crypto.randomBytes(3)` 采样 20 bit；返回大写形式。
- 冲突则重试，`maxAttempts` 用尽抛 `confirmId collision exhausted`。
- `release` / `isInUse` 对大写归一（内部按大写存储）。

## ChatCancelRegistry（聊天取消注册表）

```ts
const CHAT_CANCELLED_MESSAGE = 'CHAT_CANCELLED'
class ChatCancelledError extends Error          // name = 'ChatCancelledError'

interface ChatCancelLinks {
  cancelToolConfirmsForRequest?(requestId: string): void
  cancelToolsForRequest?(requestId: string): void
  cancelAllPendingToolConfirms?(): void
}

interface ChatCancelRegistryLike {
  register(requestId: string): AbortSignal
  signalChatCancel(requestId: string): void
  clear(requestId: string): void
  throwIfCancelled(signal: AbortSignal): void
  cancelAllActiveChats(): void
}
```

- `register`：同一 `requestId` 重复注册会先 `abort` 旧 controller，再返回新 signal。
- `signalChatCancel`：abort 该 request 的 signal，并联动 `links.cancelToolConfirmsForRequest` / `cancelToolsForRequest`。
- `cancelAllActiveChats`：清空全部 controller，并额外触发 `links.cancelAllPendingToolConfirms`。
- `throwIfCancelled(signal)`：`signal.aborted` 时抛 `ChatCancelledError`。
- `links` 由宿主注入，SDK 纯核缺省 no-op。

## ToolRevocationRegistry（工具撤权注册表）

```ts
const TOOL_REQUEST_LANES = ['desktop', 'feishu', 'wechat', 'automation'] as const
type ToolRevocationEvent = { requestId: string; executionId: string; lane: string; toolName: string }

interface ToolRevocationRegistryLike {
  registerToolRevocationRequest(requestId: string, lane: string, executionId: string): void
  revokeToolForLane(lane: string, toolName: string): number
  revokeToolForAllLanes(toolName: string): number
  isToolRevoked(requestId: string, toolName: string, executionId?: string): boolean
  clearToolRevocationRequest(requestId: string, executionId?: string): void
  onRevocation(listener: (event: ToolRevocationEvent) => void): () => void
}
```

- `registerToolRevocationRequest`：`executionId` 必填非空，抛 `tool revocation executionId required`。
- `revokeToolForAllLanes` 只覆盖 `TOOL_REQUEST_LANES` 内的已知 lane；其他 lane 不在"全 lane"范围内。
- 返回值 = 本次新增撤权的在途请求数；每个事件都会通知全部 listener。
- listener 抛错不会中断其他 listener，但会在最后抛 `AggregateError`（消息含 `lane ?? 'all lanes'` 与 `toolName`）。
- `clearToolRevocationRequest(requestId)` 不带 `executionId` 时，若匹配到多条则抛 `ambiguous tool revocation request`。

## Semaphore 与 MCP 闸

```ts
class Semaphore {
  constructor(readonly limit: number)
  get pending(): number        // 等待者数量
  get activeCount(): number    // 当前占位数量
  acquire(options?: { signal?: AbortSignal }): Promise<void>
  release(): void
}
async function withSemaphore<T>(semaphore: Semaphore, fn: () => Promise<T>): Promise<T>

class McpConcurrencyGate {
  constructor(readonly globalConcurrency = 8, perServerConcurrency = 4)
  perServer(serverId: string): Semaphore
  run<T>(serverId: string, fn: () => Promise<T>): Promise<T>
}
```

- `acquire`：`signal` 已 abort 时以 `semaphore-cancelled` 拒绝；空闲则立即 `active++`；否则入队（`signal` abort 可退出队列）。
- `release` 语义是**名额转让**：有等待者时直接唤醒队首（不减 `active`），无等待者才 `active--`。
- 同一 `AbortSignal` 的监听在出队 / 释放时移除（`{ once: true }`）。
- `McpConcurrencyGate.run` = 全局信号量外层、每服务信号量内层的嵌套；`perServerSemaphores` 为实例字段，**不再模块级共享**。

## 使用注意

- 所有 registry 都是实例级状态，多 runtime 并存互不影响；不要把 `ChatCancelRegistry` / `ToolRevocationRegistry` 当作模块单例使用。
- `McpConcurrencyGate` 与 `Semaphore` 只保证并发上限，不保证顺序（除 FIFO 唤醒外无优先级）。
