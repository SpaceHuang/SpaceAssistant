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
  | { role: 'system'; content: string; timestamp?: number }
  | { role: 'user'; content: string | readonly CanonicalContentBlock[]; timestamp?: number }
  | { role: 'assistant'; content: string | readonly CanonicalContentBlock[]; toolCalls?: readonly CanonicalToolCall[]; timestamp?: number }
  | { role: 'assistant'; content?: undefined; toolCalls: readonly CanonicalToolCall[]; timestamp?: number }
  | { role: 'tool'; toolCallId: string; content: unknown; isError: boolean; timestamp?: number }
```

注意 `assistant` 有两个分支：纯工具调用消息可不带 `content`。

## collectModelAttempt：单次 provider 尝试的收集与校验

```ts
async function collectModelAttempt(
  stream: AsyncIterable<StreamChunk>,
  observer?: ModelStreamObserver
): Promise<CollectedModelStream>

const collectModelStream = collectModelAttempt   // 兼容别名
```

返回：

```ts
type CollectedModelStream = Readonly<{
  chunks: readonly Exclude<StreamChunk, { type: 'finish' }>[]
  usage: Extract<StreamChunk, { type: 'usage' }>
  finish: Extract<StreamChunk, { type: 'finish' }>
}>
```

校验规则（违规一律抛 `InvalidModelStreamError`，`code = 'INVALID_MODEL_STREAM'`）：

- `finish` 之后不得再出现任何事件（`event received after finish`）。
- `usage` 必须唯一（`duplicate usage`）、必须在 `finish` 之前（`finish received before usage`）、流结束时必须存在（`stream ended without usage` / `stream ended without finish`）。
- `finish.reason` 必须与 tool-call 块一致：非 `length` 时 `(reason === 'tool-calls') !== hasToolCall` 即报错。
- `tool-call`：`toolCallId` 非空且唯一；`input` 必须是非数组对象。

观察者：

```ts
type ModelStreamObserver = Readonly<{
  onChunk?(chunk: Exclude<StreamChunk, { type: 'finish' }>): void | Promise<void>
  onStreamError?(input: Readonly<{ error: unknown; usage?: Extract<StreamChunk, { type: 'usage' }> }>): void | Promise<void>
}>
```

- `onChunk` 在 `finish` 之前逐块回调（不含 `finish`）。
- `onStreamError` 只在流抛错时回调一次，并会带上已收到的 `usage`（若有）；错误继续向上抛。
- 重试与提交策略由调用方负责，`collectModelAttempt` 只做单次尝试的收集。

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

## 错误类型汇总

| 类 | code | 触发 |
| --- | --- | --- |
| `InvalidModelStreamError` | `INVALID_MODEL_STREAM` | 流事件序列 / 载荷非法 |
| `UnknownModelRouteError` | `UNKNOWN_MODEL_ROUTE` | `prepare` 未注册路由 |
| `ModelRouteChangedError` | `MODEL_ROUTE_CHANGED` | 调用期间路由身份或 provider 变化 |
| `UnsupportedReasoningError` | `unsupported-reasoning` | provider 不支持请求的思维档 |
