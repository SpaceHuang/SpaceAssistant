import type { CanonicalContentBlock, CanonicalModelMessage, ModelProvider, PreparedModelCall, StreamChunk } from '@spaceassistant/agent-sdk/model'

export type AnthropicRouteProfile = Readonly<{
  routeId: string
  protocol: 'anthropic-messages'
  dialect: 'anthropic-messages-2023-06-01'
  adapterVersion: 'pi-ai@0.87.1'
  modelId: string
  endpoint: string
  credentialRef: string
  modelCapabilities: Readonly<{ contextWindow: number; maxOutputTokens: number; reasoning: boolean; strictJsonSchema: boolean }>
}>

type PiEvent =
  | { type: 'start' | 'text_start' | 'text_end' | 'thinking_start' | 'thinking_end' | 'toolcall_start' | 'toolcall_delta' }
  | { type: 'text_delta'; delta: string }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'toolcall_end'; toolCall: { id: string; name: string; arguments: unknown } }
  | { type: 'done'; reason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'; message: { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }; errorMessage?: string; content?: Array<{ type?: string; thinkingSignature?: string; redacted?: boolean }> } }
  | { type: 'error'; error?: { errorMessage?: string; status?: number; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } }

type PiModel = {
  id: string; name: string; api: 'anthropic-messages'; provider: 'anthropic'; baseUrl: string; reasoning: boolean
  input: ('text' | 'image')[]; cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow: number; maxTokens: number; compat?: { supportsStrictTools?: boolean; allowEmptySignature?: boolean }
}
type PiCallOptions = { apiKey: string; signal?: AbortSignal; maxRetries: 0; maxTokens: number; thinkingEnabled?: boolean; thinkingBudgetTokens?: number; effort?: 'low' | 'medium' | 'high' | 'max' }
export type PiAnthropicBridge = {
  normalizeContext(context: { messages: unknown[]; tools?: Array<{ name: string; description: string; parameters: unknown; constrainedSampling?: { type: 'json_schema'; strict: 'prefer' | 'require' } }> }): unknown | Promise<unknown>
  stream(model: PiModel, context: unknown, options: PiCallOptions): AsyncIterable<PiEvent>
}


/** Production bridge loads only pi-ai's Anthropic Messages API implementation. */
export async function loadPiAnthropicBridge(): Promise<PiAnthropicBridge> {
  const [api, transcript] = await Promise.all([
    import('@earendil-works/pi-ai/api/anthropic-messages'),
    import('@earendil-works/pi-ai/utils/transcript')
  ])
  return {
    normalizeContext: (context) => transcript.normalizeContext(context as never),
    stream: (model, context, options) => api.stream(model as never, context as never, options as never) as AsyncIterable<PiEvent>
  }
}

export class PiAiAnthropicProvider implements ModelProvider {
  readonly providerId = 'pi-ai-anthropic-messages'
  private readonly routes: ReadonlyMap<string, AnthropicRouteProfile>

  constructor(private readonly options: { profiles: readonly AnthropicRouteProfile[]; bridge?: PiAnthropicBridge }) {
    const routes = new Map<string, AnthropicRouteProfile>()
    for (const profile of options.profiles) {
      validateProfile(profile)
      if (routes.has(profile.routeId)) throw new Error(`duplicate route id: ${profile.routeId}`)
      routes.set(profile.routeId, Object.freeze({ ...profile, modelCapabilities: Object.freeze({ ...profile.modelCapabilities }) }))
    }
    this.routes = routes
  }

  getRouteProfile(routeId: string): AnthropicRouteProfile | undefined {
    return this.routes.get(routeId)
  }

  async *stream(call: PreparedModelCall): AsyncIterable<StreamChunk> {
    assertOnlyKeys(call, ['route', 'request', 'generation'], 'model call option')
    assertOnlyKeys(call.route, ['routeId', 'protocol', 'dialect', 'adapterVersion', 'modelId', 'endpoint'], 'model route option')
    assertOnlyKeys(call.request, ['messages', 'maxTokens', 'signal', 'credentials', 'tools', 'thinking'], 'model request option')
    if (call.request.credentials) assertOnlyKeys(call.request.credentials, ['apiKey'], 'credential option')
    if (call.request.thinking) assertOnlyKeys(call.request.thinking, ['enabled', 'budgetTokens', 'effort'], 'thinking option')
    for (const tool of call.request.tools ?? []) assertOnlyKeys(tool, ['name', 'description', 'inputSchema', 'strictSchema'], 'tool option')
    const profile = this.routes.get(call.route.routeId)
    if (!profile || !matchesProfile(profile, call.route)) throw new Error('route profile mismatch')
    const apiKey = call.request.credentials?.apiKey
    if (!apiKey) throw new Error('credential injection required')
    if (call.request.maxTokens > profile.modelCapabilities.maxOutputTokens) throw new Error('requested maxTokens exceeds route capability')
    if (call.request.tools?.some((tool) => tool.strictSchema === 'require') && !profile.modelCapabilities.strictJsonSchema) throw new Error('strict JSON schema is not supported by this route')
    if (call.request.thinking?.enabled && !profile.modelCapabilities.reasoning) throw new Error('thinking is not supported by this route')
    if (call.request.thinking?.budgetTokens !== undefined && (!Number.isInteger(call.request.thinking.budgetTokens) || call.request.thinking.budgetTokens < 1 || call.request.thinking.budgetTokens >= call.request.maxTokens)) {
      throw new Error('thinking budget must be positive and below maxTokens')
    }
    validateImageInputs(call.request.messages)
    if (call.request.signal?.aborted) {
      yield { type: 'usage', inputTokens: 0, outputTokens: 0 }
      yield { type: 'finish', reason: 'cancelled' }
      return
    }
    const bridge = this.options.bridge ?? await loadPiAnthropicBridge()
    const model: PiModel = {
      id: profile.modelId,
      name: profile.modelId,
      api: 'anthropic-messages',
      provider: 'anthropic',
      baseUrl: profile.endpoint,
      reasoning: profile.modelCapabilities.reasoning,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: profile.modelCapabilities.contextWindow,
      maxTokens: profile.modelCapabilities.maxOutputTokens,
      compat: { supportsStrictTools: profile.modelCapabilities.strictJsonSchema, allowEmptySignature: new URL(profile.endpoint).hostname === 'api.deepseek.com' }
    }
    const context = await bridge.normalizeContext({
      messages: serializeCanonicalMessages(call.request.messages, profile.modelId),
      ...(call.request.tools ? { tools: call.request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as never,
        ...(tool.strictSchema ? { constrainedSampling: { type: 'json_schema' as const, strict: tool.strictSchema } } : {})
      })) } : {})
    })
    const events = bridge.stream(model, context, {
      apiKey,
      ...(call.request.signal ? { signal: call.request.signal } : {}),
      maxRetries: 0,
      maxTokens: call.request.maxTokens,
      ...(call.request.thinking?.enabled ? { thinkingEnabled: true } : {}),
      ...(call.request.thinking?.budgetTokens !== undefined ? { thinkingBudgetTokens: call.request.thinking.budgetTokens } : {}),
      ...(call.request.thinking?.effort !== undefined ? { effort: call.request.thinking.effort } : {})
    })
    let terminal = false
    for await (const event of events) {
      if (terminal) throw new Error('pi-ai emitted event after terminal')
      if (event.type === 'text_delta') yield { type: 'text-delta', text: event.delta }
      else if (event.type === 'thinking_delta') yield { type: 'thinking-delta', text: event.delta }
      else if (event.type === 'toolcall_end') {
        const args = event.toolCall.arguments
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('PI_TOOL_ARGUMENTS_INVALID')
        const thoughtSignature = (event.toolCall as { thoughtSignature?: unknown }).thoughtSignature
        yield { type: 'tool-call', toolCallId: event.toolCall.id, toolName: event.toolCall.name, input: args as Record<string, unknown>, ...(typeof thoughtSignature === 'string' ? { thoughtSignature } : {}) }
      } else if (event.type === 'error') {
        if (call.request.signal?.aborted) {
          yield { type: 'usage', inputTokens: event.error?.usage?.input ?? 0, outputTokens: event.error?.usage?.output ?? 0, ...(event.error?.usage?.cacheRead ? { cacheReadInputTokens: event.error.usage.cacheRead } : {}), ...(event.error?.usage?.cacheWrite ? { cacheCreationInputTokens: event.error.usage.cacheWrite } : {}) }
          yield { type: 'finish', reason: 'cancelled' }
          terminal = true
          continue
        }
        throw normalizeProviderError(event.error?.errorMessage, event.error?.status)
      } else if (event.type === 'done') {
        if (event.reason === 'error' || event.reason === 'aborted') {
          if (event.reason === 'aborted') {
            yield { type: 'usage', inputTokens: event.message.usage?.input ?? 0, outputTokens: event.message.usage?.output ?? 0, ...(event.message.usage?.cacheRead ? { cacheReadInputTokens: event.message.usage.cacheRead } : {}), ...(event.message.usage?.cacheWrite ? { cacheCreationInputTokens: event.message.usage.cacheWrite } : {}) }
            yield { type: 'finish', reason: 'cancelled' }
            terminal = true
            continue
          }
          throw normalizeProviderError(event.message.errorMessage)
        }
        const usage = event.message.usage
        if (!usage || typeof usage.input !== 'number' || typeof usage.output !== 'number') throw new Error('MODEL_USAGE_MISSING')
        for (const block of event.message.content ?? []) {
          if (block.type === 'thinking' && typeof block.thinkingSignature === 'string') {
            yield { type: 'thinking-signature', signature: block.thinkingSignature, ...(block.redacted ? { redacted: true } : {}) }
          }
        }
        yield { type: 'usage', inputTokens: usage.input, outputTokens: usage.output, ...(usage.cacheRead ? { cacheReadInputTokens: usage.cacheRead } : {}), ...(usage.cacheWrite ? { cacheCreationInputTokens: usage.cacheWrite } : {}) }
        yield { type: 'finish', reason: event.reason === 'toolUse' ? 'tool-calls' : event.reason }
        terminal = true
      }
    }
  }
}

function normalizeProviderError(message?: string, status?: number): Error & { status?: number } {
  const resolvedStatus = status ?? (message?.match(/\b(4\d\d|5\d\d)\b/)?.[1] ? Number(message.match(/\b(4\d\d|5\d\d)\b/)![1]) : undefined)
  const outputConfigRejected = resolvedStatus === 400 && /output_config/i.test(message ?? '')
  return Object.assign(new Error(outputConfigRejected ? '400 output_config rejected' : 'MODEL_PROVIDER_ERROR'), resolvedStatus ? { status: resolvedStatus } : {})
}

function serializeCanonicalMessages(messages: readonly CanonicalModelMessage[], modelId: string): unknown[] {
  const toolNames = new Map<string, string>()
  return messages.map((message) => {
    if (message.role === 'system' || message.role === 'user') {
      if (Array.isArray(message.content) && message.role === 'system' && message.content.some((block) => block.type === 'image')) {
        throw new Error('system image content is not supported')
      }
      return { ...message, timestamp: message.timestamp ?? 0 }
    }
    if (message.role === 'assistant') {
      const content: unknown[] = message.content === undefined ? [] : typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : message.content.map((block: CanonicalContentBlock) => {
          if (block.type === 'text') return { type: 'text', text: block.text }
          if (block.type === 'thinking') return { type: 'thinking', thinking: block.thinking, ...(block.thinkingSignature ? { thinkingSignature: block.thinkingSignature } : {}), ...(block.redacted ? { redacted: true } : {}) }
          return { type: 'image', mimeType: block.mimeType, data: block.data }
        })
      for (const tool of message.toolCalls ?? []) {
        toolNames.set(tool.id, tool.name)
        content.push({ type: 'toolCall', id: tool.id, name: tool.name, arguments: structuredClone(tool.input), ...(tool.thoughtSignature ? { thoughtSignature: tool.thoughtSignature } : {}) })
      }
      return {
        role: 'assistant', content, api: 'anthropic-messages', provider: 'anthropic', model: modelId,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: message.toolCalls?.length ? 'toolUse' : 'stop', timestamp: message.timestamp ?? 0
      }
    }
    const toolName = toolNames.get(message.toolCallId)
    if (!toolName) throw new Error('tool result has no matching assistant tool call')
    return {
      role: 'toolResult', toolCallId: message.toolCallId, toolName,
      content: serializeToolResult(message.content), isError: message.isError, timestamp: message.timestamp ?? 0
    }
  })
}

function serializeToolResult(value: unknown): unknown[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (Array.isArray(value)) return value.map((block) => {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') return block
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'image') return block
    return { type: 'text', text: safeJson(block) }
  })
  return [{ type: 'text', text: safeJson(value) }]
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? String(value) } catch { throw new Error('tool result is not serializable') }
}

function validateProfile(profile: AnthropicRouteProfile): void {
  assertOnlyKeys(profile, ['routeId', 'protocol', 'dialect', 'adapterVersion', 'modelId', 'endpoint', 'credentialRef', 'modelCapabilities'], 'Anthropic route profile option')
  assertOnlyKeys(profile.modelCapabilities, ['contextWindow', 'maxOutputTokens', 'reasoning', 'strictJsonSchema'], 'model capability option')
  if (profile.protocol !== 'anthropic-messages' || profile.dialect !== 'anthropic-messages-2023-06-01' || profile.adapterVersion !== 'pi-ai@0.87.1') {
    throw new Error('unsupported Anthropic route profile')
  }
  for (const field of ['routeId', 'modelId', 'endpoint', 'credentialRef'] as const) if (!profile[field].trim()) throw new Error(`route ${field} is required`)
  const url = new URL(profile.endpoint)
  if (url.protocol !== 'https:') throw new Error('Anthropic endpoint must use HTTPS')
  if (url.username || url.password || url.hash) throw new Error('Anthropic endpoint must not embed credentials or fragments')
  if (!Number.isInteger(profile.modelCapabilities.contextWindow) || profile.modelCapabilities.contextWindow <= 0) throw new Error('invalid contextWindow capability')
  if (!Number.isInteger(profile.modelCapabilities.maxOutputTokens) || profile.modelCapabilities.maxOutputTokens <= 0) throw new Error('invalid maxOutputTokens capability')
}

function assertOnlyKeys(value: object, allowed: readonly string[], description: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unsupported ${description}: ${key}`)
}

function matchesProfile(profile: AnthropicRouteProfile, route: PreparedModelCall['route']): boolean {
  return route.protocol === profile.protocol && route.dialect === profile.dialect && route.adapterVersion === profile.adapterVersion &&
    route.modelId === profile.modelId && route.endpoint === profile.endpoint
}

const ANTHROPIC_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const BASE64_DATA_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function validateImageInputs(value: unknown, seen = new WeakSet<object>()): void {
  if (Array.isArray(value)) {
    if (seen.has(value)) return
    seen.add(value)
    for (const item of value) validateImageInputs(item, seen)
    return
  }
  if (!value || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  const record = value as Record<string, unknown>
  if (record.type === 'image') {
    if (typeof record.mimeType !== 'string' || !ANTHROPIC_IMAGE_MIME_TYPES.has(record.mimeType)) {
      throw new Error('unsupported image MIME type')
    }
    if (typeof record.data !== 'string' || !record.data || !BASE64_DATA_PATTERN.test(record.data)) {
      throw new Error('invalid base64 image data')
    }
  }
  for (const child of Object.values(record)) validateImageInputs(child, seen)
}
