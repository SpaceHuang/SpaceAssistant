# 模型流契约与 provider 路由

对应源码：`packages/agent-sdk/src/model.ts`、`packages/agent-sdk/src/provider.ts`。

## 流事件：StreamChunk

```ts
type StreamChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'thinking-signature'; signature: string; redacted?: boolean }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: Record<string, unknown>; thoughtSignature?: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }
  | { type: 'finish'; reason: 'stop' | 'tool-calls' | 'length' | 'cancelled' }
```

## canonical 消息与内容块

```ts
type CanonicalContentBlock =
  | Readonly<{ type: 'text'; text: string }>
  | Readonly<{ type: 'thinking'; thinking: string; thinkingSignature?: string; redacted?: boolean }>
  | Readonly<{ type: 'image'; mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string }>

type CanonicalToolCall = Readonly<{ id: string; name: string; input: Readonly<Record<string, unknown>>; thoughtSignature?: string }>

type CanonicalModelMessage =
  | { role: 'system'; content: string; timestamp?: number; id?: string }
  | { role: 'user'; content: string | readonly CanonicalContentBlock[]; timestamp?: number; id?: string }
  | { role: 'assistant'; content: string | readonly CanonicalContentBlock[]; toolCalls?: readonly CanonicalToolCall[]; timestamp?: number; id?: string }
  | { role: 'assistant'; content?: undefined; toolCalls: readonly CanonicalToolCall[]; timestamp?: number; id?: string }
  | { role: 'tool'; toolCallId: string; content: unknown; isError: boolean; timestamp?: number }
```

注意 `assistant` 有两个分支：纯工具调用消息可不带 `content`。`system` / `user` / `assistant` 可携带可选 `id`（会话存储重构后用于把消息身份贯穿 transcript 镜像与上下文重放身份）；`tool` 分支不参与该身份体系。

## collectModelAttempt：单次 provider 尝试的收集与校验

```ts
async function collectModelAttempt(
  stream: AsyncIterable<StreamChunk>,
  observer?: ModelStreamObserver,
  options?: { idleTimeoutMs?: number }
): Promise<CollectedModelStream>

const collectModelStream = collectModelAttempt   // 兼容别名
```

返回（**判别式联合**：取消分支允许缺 `usage`）：

```ts
type CancelledFinish = Readonly<{ type: 'finish'; reason: 'cancelled' }>
type NonCancelledFinish = Readonly<{ type: 'finish'; reason: 'stop' | 'tool-calls' | 'length' }>

type CollectedModelStream =
  | Readonly<{ chunks: readonly Exclude<StreamChunk, { type: 'finish' }>[]; finish: CancelledFinish; usage?: Extract<StreamChunk, { type: 'usage' }> }>
  | Readonly<{ chunks: readonly Exclude<StreamChunk, { type: 'finish' }>[]; finish: NonCancelledFinish; usage: Extract<StreamChunk, { type: 'usage' }> }>
```

`finish.reason === 'cancelled'` 是**唯一**允许 `usage` 缺失的分支：被中断的 provider 可能还没吐出 usage。消费方必须显式处理该分支，不能假定 `usage` 一定存在。

校验规则（违规一律抛 `InvalidModelStreamError`，`code = 'INVALID_MODEL_STREAM'`）：

- `finish` 之后不得再出现任何事件（`event received after finish`）。
- `usage` 必须唯一（`duplicate usage`）、必须在 `finish` 之前（`finish received before usage`）——**cancelled finish 例外**（取消可以不经过 usage）。
- 流结束时必须有 `finish`（`stream ended without finish`）；非 cancelled 流结束时必须有 `usage`（`stream ended without usage`），cancelled 流允许缺失。
- `finish.reason` 必须与 tool-call 块一致：`reason` 既非 `length` 也非 `cancelled` 时，`(reason === 'tool-calls') !== hasToolCall` 即报错。
- `tool-call`：`toolCallId` 非空且唯一；`input` 必须是非数组对象。

取消分支的消费方约定见 [turn-loop.md](./turn-loop.md#循环阶段概览)：turn loop 会先做 cancelled attempt 结算（投影 usage + `model-attempt-discarded`），再抛取消 / 超时错误。

**provider 侧实现约定**（`ModelProvider.stream`）：取消时只在**确有真实用量**时先 yield `usage`、再 yield `finish: { reason: 'cancelled' }`；**不得**用 `usage: 0/0` 之类的伪造值占位，没有用量就直接给 cancelled finish。cancelled finish 之后不得再产出任何事件。

观察者：

```ts
type ModelStreamObserver = Readonly<{
  onChunk?(chunk: Exclude<StreamChunk, { type: 'finish' }>): void | Promise<void>
  onStreamError?(input: Readonly<{ error: unknown; usage?: Extract<StreamChunk, { type: 'usage' }> }>): void | Promise<void>
}>
```

- `onChunk` 在 `finish` 之前逐块回调（不含 `finish`）。
- `onStreamError` 只在流抛错时回调一次，并会带上已收到的 `usage`（若有）；错误继续向上抛。空闲超时护栏抛出的 `ModelStreamIdleTimeoutError` 也走这条通道（见下）。
- 重试与提交策略由调用方负责，`collectModelAttempt` 只做单次尝试的收集。

## 空闲超时护栏（idle timeout）

```ts
const PROVIDER_STREAM_IDLE_TIMEOUT = 'PROVIDER_STREAM_IDLE_TIMEOUT' as const
class ModelStreamIdleTimeoutError extends Error {
  readonly code = PROVIDER_STREAM_IDLE_TIMEOUT
  constructor(readonly idleTimeoutMs: number)
}
```

- 语义：**相邻两个 chunk 之间**（含等待首字节）的间隔超过 `idleTimeoutMs` 即判定 provider 流挂起；只做"无进展"判定，不设整体时长上限，长回复不受影响。
- `collectModelAttempt` 缺省不启用；turn 循环用 `providerStreamIdleTimeoutMs ?? 120_000` 传入，`0` / 负值关闭。
- 超时行为：抛 `ModelStreamIdleTimeoutError`，并对底层流做 best-effort 取消（直接对源 iterator 调 `return()`）。实现刻意不经 async generator 包装转发 `next()` / `return()`——包装后挂起的 `return()` 永不 resolve 也不转发；超时赢下 race 后悬挂的 `next()` 挂空 catch，避免宿主没有 unhandledRejection 兜底时炸进程。
- 观测：超时同样会触发一次 `onStreamError`（带已收到的 `usage`），宿主恢复层按普通流错误重试即可。

## provider 接口与请求快照

```ts
type ModelProvider = {
  readonly providerId: string
  stream(input: PreparedModelCall): AsyncIterable<StreamChunk>
}

type PreparedModelCall = Readonly<{
  route: Readonly<{ routeId: string; protocol: string; dialect: string; adapterVersion: string; modelId: string; endpoint?: string }>
  request: Readonly<{
    messages: readonly CanonicalModelMessage[]
    maxTokens: number
    signal?: AbortSignal
    credentials?: Readonly<{ apiKey: <secret:redacted> }>
    tools?: readonly Readonly<{ name: string; description: string; inputSchema: Readonly<Record<string, unknown>>; strictSchema?: 'prefer' | 'require' }>[]
    thinking?: Readonly<{ enabled: boolean; budgetTokens?: number; effort?: 'low' | 'medium' | 'high' | 'max' }>
  }>
}>

function snapshotPreparedModelCall(call: PreparedModelCall): Readonly<{
  route: PreparedModelCall['route']
  request: Omit<PreparedModelCall['request'], 'credentials' | 'signal'>
}>   // 用于持久化：剔除凭据与取消信号，其余 structuredClone
```

`route` 全部字段为必填非空字符串（`endpoint` 也在必填校验范围内）；`maxTokens` 必须为正整数。

注意档位枚举有两份，不要混用：请求侧 `request.thinking.effort` 是 `'low' | 'medium' | 'high' | 'max'`（含产品侧最强档）；而 `provider.ts` 的 `ReasoningEffort` 是 `'off' | 'low' | 'medium' | 'high'`（**不含** `max`），后者是旧 provider 适配面的兼容枚举。

## ModelProviderRegistry

```ts
type RegisteredPreparedModelCall = PreparedModelCall & Readonly<{ generation: number }>

class ModelProviderRegistry {
  constructor(options?: { supportedProtocols?: readonly string[] })  // 缺省 anthropic-messages / openai-chat-completions / openai-responses
  register(route: PreparedModelCall['route'], provider: ModelProvider): number   // 返回 generation
  remove(routeId: string): number
  prepare(routeId: string, request: PreparedModelCall['request']): RegisteredPreparedModelCall
  getProvider(call: RegisteredPreparedModelCall): ModelProvider
  getRoute(routeId: string): Readonly<{ profile: PreparedModelCall['route']; providerId: string }> | undefined
}
```

行为要点：

- `register` 校验 `route.protocol` 在 `supportedProtocols` 内，否则抛 `protocol not enabled: <protocol>`；路由 profile 冻结保存。
- `prepare` 对未注册路由抛 `UnknownModelRouteError`；`maxTokens` 非正整数抛错；返回的是深冻结快照（含 `structuredClone` 的 messages / tools），并在内部登记 `WeakMap<call, provider>`。
- `getProvider` 会校验调用是否属于本注册表、路由代际是否漂移、provider 是否更换、profile 是否逐字段一致；任一不满足抛 `ModelRouteChangedError(routeId)`。**这是"调用内路由冻结"的执行点**。
- `getRoute` 返回冻结的 `{ profile, providerId }`，不泄漏 provider 实例。

独立工具函数：

```ts
function prepareModelCall(input: PreparedModelCall): PreparedModelCall   // 不经过注册表的一次性冻结，route 字段与 maxTokens 同样校验
```

## provider.ts：思维档与用量补全

```ts
type ReasoningEffort = 'off' | 'low' | 'medium' | 'high'
type ProviderInput  = { model: string; reasoning: ReasoningEffort; prompt: string; signal?: AbortSignal }
type ProviderOutput = { content: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }

class UnsupportedReasoningError extends Error { readonly code: 'unsupported-reasoning'; readonly requested: ReasoningEffort }

class ProviderInvocation {
  constructor(deps: {
    capabilities: { reasoning: readonly ReasoningEffort[] }
    invoke(input: ProviderInput): Promise<ProviderOutput>
  })
  run(input: ProviderInput): Promise<ProviderOutput>
}
```

- `run` 先检查 `capabilities.reasoning` 是否含请求档位，否则抛 `UnsupportedReasoningError`。
- 有 `usage` 时补全 `totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0)`。
- `ReasoningEffort` 是 agent-core 自己的四档枚举（`off | low | medium | high`），**不含**产品侧枚举（`src/shared/thinkingEffort.ts`）的 `max`；源码注释显式声明两者暂不统一，如需统一另立需求。

## 错误类型汇总

| 类 | code | 触发 |
| --- | --- | --- |
| `InvalidModelStreamError` | `INVALID_MODEL_STREAM` | 流事件序列 / 载荷非法 |
| `ModelStreamIdleTimeoutError` | `PROVIDER_STREAM_IDLE_TIMEOUT` | provider 流相邻 chunk 间隔超过 `idleTimeoutMs`（无进展护栏） |
| `UnknownModelRouteError` | `UNKNOWN_MODEL_ROUTE` | `prepare` 未注册路由 |
| `ModelRouteChangedError` | `MODEL_ROUTE_CHANGED` | 调用期间路由身份或 provider 变化 |
| `UnsupportedReasoningError` | `unsupported-reasoning` | provider 不支持请求的思维档 |
