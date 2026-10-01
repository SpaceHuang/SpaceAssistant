export type StreamChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'thinking-signature'; signature: string; redacted?: boolean }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: Record<string, unknown>; thoughtSignature?: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }
  | { type: 'finish'; reason: 'stop' | 'tool-calls' | 'length' | 'cancelled' }

export type CanonicalContentBlock =
  | Readonly<{ type: 'text'; text: string }>
  | Readonly<{ type: 'thinking'; thinking: string; thinkingSignature?: string; redacted?: boolean }>
  | Readonly<{ type: 'image'; mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string }>

export type CanonicalToolCall = Readonly<{ id: string; name: string; input: Readonly<Record<string, unknown>>; thoughtSignature?: string }>

export type CanonicalModelMessage =
  | Readonly<{ role: 'system'; content: string; timestamp?: number }>
  | Readonly<{ role: 'user'; content: string | readonly CanonicalContentBlock[]; timestamp?: number }>
  | Readonly<{ role: 'assistant'; content: string | readonly CanonicalContentBlock[]; toolCalls?: readonly CanonicalToolCall[]; timestamp?: number }>
  | Readonly<{ role: 'assistant'; content?: undefined; toolCalls: readonly CanonicalToolCall[]; timestamp?: number }>
  | Readonly<{ role: 'tool'; toolCallId: string; content: unknown; isError: boolean; timestamp?: number }>

export class InvalidModelStreamError extends Error {
  readonly code = 'INVALID_MODEL_STREAM'
  constructor(message: string) { super(message); this.name = 'InvalidModelStreamError' }
}

type CollectedModelChunks = readonly Exclude<StreamChunk, { type: 'finish' }>[]
type CollectedUsage = Extract<StreamChunk, { type: 'usage' }>
type CancelledFinish = Readonly<{ type: 'finish'; reason: 'cancelled' }>
type NonCancelledFinish = Readonly<{ type: 'finish'; reason: 'stop' | 'tool-calls' | 'length' }>

export type CollectedModelStream = Readonly<{
  chunks: CollectedModelChunks
  finish: CancelledFinish
  usage?: CollectedUsage
}> | Readonly<{
  chunks: CollectedModelChunks
  finish: NonCancelledFinish
  usage: CollectedUsage
}>

export type ModelStreamObserver = Readonly<{
  onChunk?(chunk: Exclude<StreamChunk, { type: 'finish' }>): void | Promise<void>
  onStreamError?(input: Readonly<{ error: unknown; usage?: Extract<StreamChunk, { type: 'usage' }> }>): void | Promise<void>
}>

/** Provider 流空闲超时（无进展护栏）：相邻 chunk 间隔（含首字节）超过阈值即抛出，宿主恢复层可据此重试。 */
export const PROVIDER_STREAM_IDLE_TIMEOUT = 'PROVIDER_STREAM_IDLE_TIMEOUT' as const

export class ModelStreamIdleTimeoutError extends Error {
  code = PROVIDER_STREAM_IDLE_TIMEOUT
  constructor(readonly idleTimeoutMs: number) {
    super(`model provider stream stalled for more than ${idleTimeoutMs}ms without progress`)
    this.name = 'ModelStreamIdleTimeoutError'
  }
}

/** Collect and validate one provider attempt; callers retain responsibility for retry and commit policy. */
export async function collectModelAttempt(
  stream: AsyncIterable<StreamChunk>,
  observer?: ModelStreamObserver,
  options?: { idleTimeoutMs?: number }
): Promise<CollectedModelStream> {
  const accepted: Array<Exclude<StreamChunk, { type: 'finish' }>> = []
  let usage: Extract<StreamChunk, { type: 'usage' }> | undefined
  let finish: Extract<StreamChunk, { type: 'finish' }> | undefined
  let hasToolCall = false
  const toolCallIds = new Set<string>()
  const idleTimeoutMs = options?.idleTimeoutMs
  const observedStream = (async function* () {
    try { yield* stream }
    catch (error) {
      await observer?.onStreamError?.({ error, ...(usage ? { usage } : {}) })
      throw error
    }
  })()
  const iterator = observedStream[Symbol.asyncIterator]()
  // 每 chunk 到位即重置计时：超过 idleTimeoutMs 无任何新字节 → 判定 provider 流挂起（无整体超时，长回复不受限）
  const nextWithIdleGuard = (): Promise<IteratorResult<StreamChunk>> => {
    if (!idleTimeoutMs || idleTimeoutMs <= 0) return iterator.next()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ModelStreamIdleTimeoutError(idleTimeoutMs)), idleTimeoutMs)
    })
    return Promise.race([
      iterator.next().finally(() => { if (timer) clearTimeout(timer) }),
      timeout
    ])
  }
  try {
    for (let step = await nextWithIdleGuard(); !step.done; step = await nextWithIdleGuard()) {
      const chunk = step.value
      if (finish) throw new InvalidModelStreamError('event received after finish')
      if (chunk.type === 'usage') {
        if (usage) throw new InvalidModelStreamError('duplicate usage')
        usage = chunk
        accepted.push(chunk)
      } else if (chunk.type === 'finish') {
        if (!usage && chunk.reason !== 'cancelled') throw new InvalidModelStreamError('finish received before usage')
        if (chunk.reason !== 'length' && chunk.reason !== 'cancelled' && ((chunk.reason === 'tool-calls') !== hasToolCall)) throw new InvalidModelStreamError('finish reason does not match tool-call chunks')
        finish = chunk
      } else {
        if (chunk.type === 'tool-call') {
          if (!chunk.toolCallId.trim() || toolCallIds.has(chunk.toolCallId)) throw new InvalidModelStreamError('empty or duplicate tool-call id')
          if (!chunk.toolName.trim() || !chunk.input || typeof chunk.input !== 'object' || Array.isArray(chunk.input)) throw new InvalidModelStreamError('invalid tool-call payload')
          toolCallIds.add(chunk.toolCallId)
        }
        accepted.push(chunk)
        if (chunk.type === 'tool-call') hasToolCall = true
      }
      if (chunk.type !== 'finish') await observer?.onChunk?.(chunk)
    }
  } catch (error) {
    // 空闲超时是本层注入的护栏错误（provider 流本身未抛错）——补观测后上抛，恢复层据此重试
    if (error instanceof ModelStreamIdleTimeoutError) {
      await observer?.onStreamError?.({ error, ...(usage ? { usage } : {}) })
    }
    throw error
  }
  if (!finish) throw new InvalidModelStreamError('stream ended without finish')
  if (finish.reason === 'cancelled') return { chunks: accepted, ...(usage ? { usage } : {}), finish: finish as CancelledFinish }
  if (!usage) throw new InvalidModelStreamError('stream ended without usage')
  return { chunks: accepted, usage, finish: finish as NonCancelledFinish }
}

/** Backward-compatible name retained while callers migrate to the attempt-oriented API. */
export const collectModelStream = collectModelAttempt

export type ModelProvider = {
  readonly providerId: string
  stream(input: PreparedModelCall): AsyncIterable<StreamChunk>
}

export type PreparedModelCall = Readonly<{
  route: Readonly<{ routeId: string; protocol: string; dialect: string; adapterVersion: string; modelId: string; endpoint?: string }>
  request: Readonly<{
    messages: readonly CanonicalModelMessage[]
    maxTokens: number
    signal?: AbortSignal
    credentials?: Readonly<{ apiKey: string }>
    tools?: readonly Readonly<{ name: string; description: string; inputSchema: Readonly<Record<string, unknown>>; strictSchema?: 'prefer' | 'require' }>[]
    thinking?: Readonly<{ enabled: boolean; budgetTokens?: number; effort?: 'low' | 'medium' | 'high' | 'max' }>
  }>
}>

/** Persistable canonical request identity; ephemeral credentials and cancellation signals are excluded. */
export function snapshotPreparedModelCall(call: PreparedModelCall): Readonly<{
  route: PreparedModelCall['route']
  request: Omit<PreparedModelCall['request'], 'credentials' | 'signal'>
}> {
  const { credentials: _credentials, signal: _signal, ...request } = call.request
  return structuredClone({ route: call.route, request })
}

export type RegisteredPreparedModelCall = PreparedModelCall & Readonly<{ generation: number }>

export class UnknownModelRouteError extends Error {
  readonly code = 'UNKNOWN_MODEL_ROUTE'
  constructor(routeId: string) { super(`unknown model route: ${routeId}`); this.name = 'UnknownModelRouteError' }
}

export class ModelRouteChangedError extends Error {
  readonly code = 'MODEL_ROUTE_CHANGED'
  constructor(readonly routeId: string) { super(`model route changed during invocation: ${routeId}`); this.name = 'ModelRouteChangedError' }
}

export class ModelProviderRegistry {
  private generation = 0
  private readonly routeGenerations = new Map<string, number>()
  private readonly routes = new Map<string, { profile: PreparedModelCall['route']; provider: ModelProvider }>()
  private readonly callProviders = new WeakMap<RegisteredPreparedModelCall, ModelProvider>()
  private readonly supportedProtocols: ReadonlySet<string>

  constructor(options: { supportedProtocols?: readonly string[] } = {}) {
    this.supportedProtocols = new Set(options.supportedProtocols ?? [
      'anthropic-messages', 'openai-chat-completions', 'openai-responses'
    ])
  }

  register(route: PreparedModelCall['route'], provider: ModelProvider): number {
    const frozenRoute = freezeRoute(route)
    if (!this.supportedProtocols.has(route.protocol)) throw new Error(`protocol not enabled: ${route.protocol}`)
    this.routes.set(route.routeId, { profile: frozenRoute, provider })
    this.generation += 1
    this.routeGenerations.set(route.routeId, this.generation)
    return this.generation
  }

  remove(routeId: string): number {
    this.routes.delete(routeId)
    this.generation += 1
    this.routeGenerations.set(routeId, this.generation)
    return this.generation
  }

  prepare(routeId: string, request: PreparedModelCall['request']): RegisteredPreparedModelCall {
    const registered = this.routes.get(routeId)
    if (!registered) throw new UnknownModelRouteError(routeId)
    if (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0) throw new Error('maxTokens must be a positive integer')
    const call = freezeCall(registered.profile, request, this.routeGenerations.get(routeId)) as RegisteredPreparedModelCall
    this.callProviders.set(call, registered.provider)
    return call
  }

  getProvider(call: RegisteredPreparedModelCall): ModelProvider {
    const provider = this.callProviders.get(call)
    if (!provider) throw new Error('prepared call is not owned by this provider registry')
    const current = this.routes.get(call.route.routeId)
    if (!current || this.routeGenerations.get(call.route.routeId) !== call.generation || current.provider !== provider || !sameRouteProfile(current.profile, call.route)) {
      throw new ModelRouteChangedError(call.route.routeId)
    }
    return provider
  }

  getRoute(routeId: string): Readonly<{ profile: PreparedModelCall['route']; providerId: string }> | undefined {
    const registered = this.routes.get(routeId)
    return registered ? Object.freeze({ profile: registered.profile, providerId: registered.provider.providerId }) : undefined
  }
}

function sameRouteProfile(left: PreparedModelCall['route'], right: PreparedModelCall['route']): boolean {
  const normalize = (value: PreparedModelCall['route']) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

function freezeRoute(route: PreparedModelCall['route']): PreparedModelCall['route'] {
  for (const [field, value] of Object.entries(route)) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`route ${field} is required`)
  }
  return Object.freeze({ ...route })
}

export function prepareModelCall(input: PreparedModelCall): PreparedModelCall {
  const { route } = input
  for (const [field, value] of Object.entries(route)) {
    if (!value.trim()) throw new Error(`route ${field} is required`)
  }
  if (!Number.isInteger(input.request.maxTokens) || input.request.maxTokens <= 0) throw new Error('maxTokens must be a positive integer')
  return freezeCall(route, input.request)
}

function freezeCall(route: PreparedModelCall['route'], request: PreparedModelCall['request'], generation?: number): PreparedModelCall {
  const snapshot = {
    route: { ...route },
    request: {
      messages: structuredClone(request.messages),
      maxTokens: request.maxTokens,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.credentials ? { credentials: { ...request.credentials } } : {}),
      ...(request.tools ? { tools: structuredClone(request.tools) } : {}),
      ...(request.thinking ? { thinking: { ...request.thinking } } : {})
    },
    ...(generation === undefined ? {} : { generation })
  }
  return deepFreeze(snapshot) as PreparedModelCall
}

function deepFreeze<T>(value: T): T {
  if (typeof AbortSignal !== 'undefined' && value instanceof AbortSignal) return value
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  }
  return value
}
