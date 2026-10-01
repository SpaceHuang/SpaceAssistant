import { describe, expect, it, vi } from 'vitest'
import { loadPiAnthropicBridge, PiAiAnthropicProvider, type PiAnthropicBridge, type AnthropicRouteProfile } from '../src'
import type { PreparedModelCall } from '../../agent-sdk/src/model'

const profile: AnthropicRouteProfile = {
  routeId: 'anthropic-main', protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01',
  adapterVersion: 'pi-ai@0.87.1', modelId: 'claude-sonnet-4-6', endpoint: 'https://api.anthropic.com',
  credentialRef: 'credential:anthropic:main', modelCapabilities: { contextWindow: 200_000, maxOutputTokens: 16_000, reasoning: true, strictJsonSchema: true }
}

function prepared(overrides: Partial<PreparedModelCall['request']> = {}): PreparedModelCall {
  return {
    route: routeOf(profile),
    request: { messages: [{ role: 'user', content: 'hello', timestamp: 1 }], maxTokens: 128, credentials: { apiKey: 'one-request-secret' }, ...overrides }
  }
}

function routeOf(value: AnthropicRouteProfile): PreparedModelCall['route'] {
  return { routeId: value.routeId, protocol: value.protocol, dialect: value.dialect, adapterVersion: value.adapterVersion, modelId: value.modelId, endpoint: value.endpoint }
}

describe('PiAiAnthropicProvider', () => {
  it('enables empty thinking signatures for DeepSeek passback only', async () => {
    const deepSeekProfile = { ...profile, routeId: 'deepseek', modelId: 'deepseek-v4-pro', endpoint: 'https://api.deepseek.com/anthropic' }
    const models: unknown[] = []
    const bridge: PiAnthropicBridge = {
      normalizeContext: (context) => context,
      stream: async function* (model) {
        models.push(model)
        yield { type: 'done', reason: 'stop', message: { usage: { input: 1, output: 1 } } }
      }
    }
    for (const selectedProfile of [profile, deepSeekProfile]) {
      const provider = new PiAiAnthropicProvider({ profiles: [selectedProfile], bridge })
      for await (const _chunk of provider.stream({ ...prepared(), route: routeOf(selectedProfile) })) { /* consume */ }
    }
    expect(models).toMatchObject([
      { compat: { allowEmptySignature: false } },
      { compat: { allowEmptySignature: true } }
    ])
  })

  it('preserves Anthropic cache input usage fields in the SDK usage chunk', async () => {
    const provider = new PiAiAnthropicProvider({ profiles: [profile], bridge: {
      normalizeContext: (context) => context,
      stream: async function* () {
        yield { type: 'done', reason: 'stop', message: { usage: { input: 20, output: 3, cacheRead: 11, cacheWrite: 5 } } }
      }
    } })
    const chunks = []
    for await (const chunk of provider.stream(prepared())) chunks.push(chunk)
    expect(chunks).toContainEqual({ type: 'usage', inputTokens: 20, outputTokens: 3, cacheReadInputTokens: 11, cacheCreationInputTokens: 5 })
  })

  it('pins an allowlisted Anthropic profile and maps text/tool/usage/terminal events', async () => {
    const stream = vi.fn<PiAnthropicBridge['stream']>(async function* () {
      yield { type: 'start' }
      yield { type: 'text_delta', delta: 'hello' }
      yield { type: 'toolcall_end', toolCall: { id: 'tc-1', name: 'read_file', arguments: { path: 'a.txt' }, thoughtSignature: 'tool-sig' } }
      yield { type: 'done', reason: 'toolUse', message: { usage: { input: 3, output: 4 } } }
    })
    const bridge: PiAnthropicBridge = { normalizeContext: (context) => context, stream }
    const provider = new PiAiAnthropicProvider({ profiles: [profile], bridge })
    const chunks = []
    for await (const chunk of provider.stream(prepared())) chunks.push(chunk)
    expect(chunks).toEqual([
      { type: 'text-delta', text: 'hello' },
      { type: 'tool-call', toolCallId: 'tc-1', toolName: 'read_file', input: { path: 'a.txt' }, thoughtSignature: 'tool-sig' },
      { type: 'usage', inputTokens: 3, outputTokens: 4 },
      { type: 'finish', reason: 'tool-calls' }
    ])
    expect(stream).toHaveBeenCalledOnce()
    const [model, _context, options] = stream.mock.calls[0]!
    expect(model).toMatchObject({ id: profile.modelId, api: 'anthropic-messages', provider: 'anthropic', baseUrl: profile.endpoint })
    expect(options).toMatchObject({ apiKey: 'one-request-secret', maxRetries: 0, maxTokens: 128 })
    expect(Object.keys(options).some((key) => /key/i.test(key))).toBe(true)
  })

  it('awaits lazy async transcript normalization before calling the provider stream', async () => {
    let receivedContext: unknown
    const normalizedContext = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] }
    const bridge: PiAnthropicBridge = {
      normalizeContext: async () => normalizedContext,
      stream: async function* (_model, context) {
        receivedContext = context
        if (!Array.isArray((context as { messages?: unknown }).messages)) throw new Error('messages is not iterable')
        yield { type: 'done', reason: 'stop', message: { usage: { input: 1, output: 1 } } }
      }
    }
    const provider = new PiAiAnthropicProvider({ profiles: [profile], bridge })
    const chunks = []
    for await (const chunk of provider.stream(prepared())) chunks.push(chunk)
    expect(receivedContext).toEqual(normalizedContext)
    expect(chunks).toContainEqual({ type: 'finish', reason: 'stop' })
  })

  it('preserves signed thinking history and maps canonical effort to pi-ai', async () => {
    let normalized: unknown
    let options: unknown
    const bridge: PiAnthropicBridge = {
      normalizeContext: (context) => { normalized = context; return context },
      stream: async function* (_model, _context, callOptions) {
        options = callOptions
        yield { type: 'done', reason: 'stop', message: { usage: { input: 3, output: 2 }, content: [{ type: 'thinking', thinkingSignature: 'opaque-signature' }] } }
      }
    }
    const provider = new PiAiAnthropicProvider({ profiles: [profile], bridge })
    const call = prepared({
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning', thinkingSignature: 'opaque-signature' }, { type: 'text', text: 'answer' }] },
        { role: 'user', content: 'continue' }
      ],
      thinking: { enabled: true, effort: 'high' }
    })
    const chunks = []
    for await (const chunk of provider.stream(call)) chunks.push(chunk)

    expect(chunks).toContainEqual({ type: 'thinking-signature', signature: 'opaque-signature' })
    expect((normalized as { messages: unknown[] }).messages[0]).toMatchObject({ role: 'assistant', content: [
      { type: 'thinking', thinking: 'private reasoning', thinkingSignature: 'opaque-signature' },
      { type: 'text', text: 'answer' }
    ] })
    expect(options).toMatchObject({ thinkingEnabled: true, effort: 'high' })
  })

  it('passes an Anthropic Messages mock-wire golden through the pinned pi-ai API', async () => {
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init })
      const frames = [
        ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: profile.modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'golden' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }],
        ['message_stop', { type: 'message_stop' }]
      ] as const
      const payload = frames.map(([name, value]) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`).join('')
      return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    try {
      const provider = new PiAiAnthropicProvider({ profiles: [profile] })
      const chunks = []
      for await (const chunk of provider.stream(prepared({ messages: [
        { role: 'system', content: 'Follow the workspace safety policy.', timestamp: 0 },
        { role: 'user', content: 'hello', timestamp: 1 }
      ] }))) chunks.push(chunk)
      expect(chunks).toEqual([
        { type: 'text-delta', text: 'golden' },
        { type: 'usage', inputTokens: 7, outputTokens: 3 },
        { type: 'finish', reason: 'stop' }
      ])
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toBe('https://api.anthropic.com/v1/messages?beta=true')
      const headers = new Headers(requests[0]?.init?.headers)
      expect(headers.get('x-api-key')).toBe('one-request-secret')
      expect(headers.get('anthropic-version')).toBe('2023-06-01')
      const body = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>
      expect(body).toMatchObject({
        model: profile.modelId, max_tokens: 128, stream: true,
        system: [{ type: 'text', text: 'Follow the workspace safety policy.', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
      })
      const wireMessages = body.messages as Array<{ content: Array<Record<string, unknown>> }>
      expect(wireMessages[0]?.content[0]).toMatchObject({ cache_control: { type: 'ephemeral' } })
      expect(JSON.stringify(body)).not.toContain('credential:anthropic:main')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('maps canonical image content blocks to Anthropic base64 image sources', async () => {
    const originalFetch = globalThis.fetch
    let requestBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      const frames = [
        ['message_start', { type: 'message_start', message: { id: 'msg_image', type: 'message', role: 'assistant', model: profile.modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
        ['message_stop', { type: 'message_stop' }]
      ] as const
      const payload = frames.map(([name, value]) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`).join('')
      return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    try {
      const provider = new PiAiAnthropicProvider({ profiles: [profile] })
      const call = prepared({ messages: [{ role: 'user', content: [
        { type: 'text', text: 'Describe this picture' },
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }
      ] }] })
      const chunks = []
      for await (const chunk of provider.stream(call)) chunks.push(chunk)
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
      const messages = requestBody?.messages as Array<{ content: Array<Record<string, unknown>> }>
      expect(messages[0]?.content).toContainEqual({ type: 'text', text: 'Describe this picture' })
      expect(messages[0]?.content.find((block) => block.type === 'image')).toMatchObject({
        type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' }
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('rejects unsupported image MIME types before calling the provider bridge', async () => {
    const stream = vi.fn<PiAnthropicBridge['stream']>(async function* () {
      yield { type: 'done', reason: 'stop', message: { usage: { input: 1, output: 1 } } }
    })
    const normalizeContext = vi.fn((context: { messages: unknown[] }) => context)
    const provider = new PiAiAnthropicProvider({ profiles: [profile], bridge: { normalizeContext, stream } })
    const call = prepared({ messages: [{ role: 'user', content: [
      { type: 'image', mimeType: 'image/png', data: 'PHN2Zy8+' }
    ] }] })
    const invalidCall = { ...call, request: { ...call.request, messages: [{ role: 'user', content: [{ type: 'image', mimeType: 'image/svg+xml', data: 'PHN2Zy8+' }] }] } } as unknown as PreparedModelCall
    const run = async () => { for await (const _chunk of provider.stream(invalidCall)) void _chunk }
    await expect(run()).rejects.toThrow('unsupported image MIME type')
    expect(normalizeContext).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
  })

  it('replays canonical assistant tool calls and tool results into Anthropic Messages history', async () => {
    const originalFetch = globalThis.fetch
    let requestBody: Record<string, unknown> | undefined
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      const frames = [
        ['message_start', { type: 'message_start', message: { id: 'msg_history', type: 'message', role: 'assistant', model: profile.modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 9, output_tokens: 1 } } }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }],
        ['message_stop', { type: 'message_stop' }]
      ] as const
      const payload = frames.map(([name, value]) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`).join('')
      return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    try {
      const provider = new PiAiAnthropicProvider({ profiles: [profile] })
      const call = prepared({ messages: [
        { role: 'user', content: 'read notes' },
        { role: 'assistant', content: 'I will inspect the file.', toolCalls: [{ id: 'call-read', name: 'read_file', input: { path: 'notes.md' } }] },
        { role: 'tool', toolCallId: 'call-read', content: { success: true, data: 'the notes' }, isError: false },
        { role: 'user', content: 'what did it say?' }
      ] })
      for await (const _chunk of provider.stream(call)) void _chunk
      const messages = requestBody?.messages as Array<{ role: string; content: unknown }>
      expect(messages[1]?.role).toBe('assistant')
      expect(messages[1]?.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: 'I will inspect the file.' }),
        expect.objectContaining({ type: 'tool_use', id: 'call-read', name: 'read_file', input: { path: 'notes.md' } })
      ]))
      expect(messages[2]?.role).toBe('user')
      expect(messages[2]?.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'tool_result', tool_use_id: 'call-read', content: expect.any(String) })
      ]))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('maps an explicit JSON-schema tool and thinking options to Anthropic Messages wire', async () => {
    const originalFetch = globalThis.fetch
    let requestBody: Record<string, unknown> | undefined
    let capturedOptions: unknown
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      const frames = [
        ['message_start', { type: 'message_start', message: { id: 'msg_tool', type: 'message', role: 'assistant', model: profile.modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 'sig' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'checking' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool-1', name: 'read_file', input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"notes.md"}' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 1 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 8 } }],
        ['message_stop', { type: 'message_stop' }]
      ] as const
      const payload = frames.map(([name, value]) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`).join('')
      return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    try {
      const realBridge = await loadPiAnthropicBridge()
      const provider = new PiAiAnthropicProvider({ profiles: [profile], bridge: {
        normalizeContext: (context) => realBridge.normalizeContext(context),
        stream: (model, context, options) => { capturedOptions = options; return realBridge.stream(model, context, options) }
      } })
      const chunks = []
      for await (const chunk of provider.stream(prepared({
        maxTokens: 2048,
        thinking: { enabled: true, budgetTokens: 1024 },
        tools: [{ name: 'read_file', description: 'Read one file', strictSchema: 'require', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }]
      }))) chunks.push(chunk)
      expect(chunks).toContainEqual({ type: 'thinking-delta', text: 'checking' })
      expect(chunks).toContainEqual({ type: 'tool-call', toolCallId: 'tool-1', toolName: 'read_file', input: { path: 'notes.md' } })
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: 'tool-calls' })
      expect(capturedOptions).toMatchObject({ thinkingEnabled: true, thinkingBudgetTokens: 1024 })
      expect(requestBody).toMatchObject({
        max_tokens: 2048,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        tools: [{ name: 'read_file', description: 'Read one file', strict: true, input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }]
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('makes one wire attempt on provider failure and normalizes errors without leaking response text', async () => {
    const originalFetch = globalThis.fetch
    let attempts = 0
    globalThis.fetch = (async () => {
      attempts += 1
      return Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'sensitive-provider-detail' } }, { status: 429 })
    }) as typeof fetch
    try {
      const provider = new PiAiAnthropicProvider({ profiles: [profile] })
      const run = async () => { for await (const _chunk of provider.stream(prepared())) void _chunk }
      await expect(run()).rejects.toThrow('MODEL_PROVIDER_ERROR')
      expect(attempts).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('retains only the status and marker needed for the host output_config compatibility retry', async () => {
    const bridge: PiAnthropicBridge = {
      normalizeContext: (context) => context,
      stream: async function* () { yield { type: 'error', error: { errorMessage: '400 invalid field output_config; private body text' } } }
    }
    const provider = new PiAiAnthropicProvider({ profiles: [profile], bridge })
    const run = async () => { for await (const _chunk of provider.stream(prepared({ thinking: { enabled: true, effort: 'high' } }))) void _chunk }
    await expect(run()).rejects.toMatchObject({ message: '400 output_config rejected', status: 400 })
  })

  it('fails closed when strict schema is requested on a route without strict capability', async () => {
    const noStrictProfile = { ...profile, modelCapabilities: { ...profile.modelCapabilities, strictJsonSchema: false } }
    const stream = vi.fn<PiAnthropicBridge['stream']>(async function* () {
      yield { type: 'done', reason: 'toolUse', message: { usage: { input: 0, output: 0 } } }
    })
    const provider = new PiAiAnthropicProvider({ profiles: [noStrictProfile], bridge: { normalizeContext: (context) => context, stream } })
    const run = async () => {
      for await (const _chunk of provider.stream({ ...prepared({ tools: [{ name: 't', description: '', inputSchema: { type: 'object' }, strictSchema: 'require' }] }), route: routeOf(noStrictProfile) })) void _chunk
    }
    await expect(run()).rejects.toThrow('strict JSON schema is not supported by this route')
    expect(stream).not.toHaveBeenCalled()
  })

  it('rejects unsupported model option combinations and image payloads before contacting pi-ai', async () => {
    const stream = vi.fn<PiAnthropicBridge['stream']>(async function* () {
      yield { type: 'done', reason: 'stop', message: { usage: { input: 0, output: 0 } } }
    })
    const provider = new PiAiAnthropicProvider({ profiles: [profile], bridge: { normalizeContext: (context) => context, stream } })
    const run = async (call: ReturnType<typeof prepared>) => {
      for await (const _chunk of provider.stream(call)) void _chunk
    }

    await expect(run(prepared({ maxTokens: profile.modelCapabilities.maxOutputTokens + 1 })))
      .rejects.toThrow('requested maxTokens exceeds route capability')
    await expect(run(prepared({ thinking: { enabled: true, budgetTokens: 10 }, maxTokens: 10 })))
      .rejects.toThrow('thinking budget must be positive and below maxTokens')
    await expect(run(prepared({ messages: [{ role: 'user', content: [{ type: 'image', mimeType: 'image/svg+xml', data: 'PHN2Zz4=' }] }] } as never)))
      .rejects.toThrow('unsupported image MIME type')
    await expect(run(prepared({ messages: [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'not-base64' }] }] } as never)))
      .rejects.toThrow('invalid base64 image data')
    expect(stream).not.toHaveBeenCalled()
  })

  it('fails closed on unknown canonical request options and route versions before bridge work', async () => {
    const normalizeContext = vi.fn((context: { messages: unknown[] }) => context)
    const stream = vi.fn<PiAnthropicBridge['stream']>(async function* () {
      yield { type: 'done', reason: 'stop', message: { usage: { input: 0, output: 0 } } }
    })
    const provider = new PiAiAnthropicProvider({ profiles: [profile], bridge: { normalizeContext, stream } })
    const unknownOption = {
      ...prepared(),
      request: { ...prepared().request, temperature: 0.2 }
    } as unknown as PreparedModelCall
    const run = async (call: PreparedModelCall) => { for await (const _chunk of provider.stream(call)) void _chunk }

    await expect(run(unknownOption)).rejects.toThrow('unsupported model request option: temperature')
    const unknownVersion = { ...prepared(), route: { ...prepared().route, adapterVersion: 'pi-ai@0.88.0' } } as unknown as PreparedModelCall
    await expect(run(unknownVersion)).rejects.toThrow('route profile mismatch')
    expect(normalizeContext).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
    expect(() => new PiAiAnthropicProvider({ profiles: [{ ...profile, adapterVersion: 'pi-ai@0.88.0' } as never] }))
      .toThrow('unsupported Anthropic route profile')
  })

  it('does not dispatch or fabricate usage when cancellation predates provider dispatch', async () => {
    const controller = new AbortController()
    controller.abort()
    const stream = vi.fn<PiAnthropicBridge['stream']>(async function* () {
      yield { type: 'done', reason: 'stop', message: { usage: { input: 1, output: 1 } } }
    })
    const provider = new PiAiAnthropicProvider({ profiles: [profile], bridge: { normalizeContext: (context) => context, stream } })
    const chunks = []
    for await (const chunk of provider.stream(prepared({ signal: controller.signal }))) chunks.push(chunk)
    expect(stream).not.toHaveBeenCalled()
    expect(chunks).toEqual([{ type: 'finish', reason: 'cancelled' }])
  })

  it.each([
    { name: 'error without usage', event: { type: 'error', error: { errorMessage: 'aborted' } } as const, expected: [{ type: 'finish', reason: 'cancelled' }] },
    { name: 'error with explicit zero usage', event: { type: 'error', error: { errorMessage: 'aborted', usage: { input: 0, output: 0 } } } as const, expected: [{ type: 'usage', inputTokens: 0, outputTokens: 0 }, { type: 'finish', reason: 'cancelled' }] },
    { name: 'done aborted without usage', event: { type: 'done', reason: 'aborted', message: {} } as const, expected: [{ type: 'finish', reason: 'cancelled' }] },
    { name: 'done aborted with actual usage', event: { type: 'done', reason: 'aborted', message: { usage: { input: 7, output: 2, cacheRead: 3 } } } as const, expected: [{ type: 'usage', inputTokens: 7, outputTokens: 2, cacheReadInputTokens: 3 }, { type: 'finish', reason: 'cancelled' }] }
  ])('maps an in-flight abort from $name without inventing usage', async ({ event, expected }) => {
    const controller = new AbortController()
    const stream = vi.fn<PiAnthropicBridge['stream']>(async function* (_model, _context, options) {
      expect(options.signal).toBe(controller.signal)
      controller.abort()
      yield event
    })
    const provider = new PiAiAnthropicProvider({ profiles: [profile], bridge: { normalizeContext: (context) => context, stream } })
    const chunks = []
    for await (const chunk of provider.stream(prepared({ signal: controller.signal }))) chunks.push(chunk)
    expect(stream).toHaveBeenCalledOnce()
    expect(chunks).toEqual(expected)
  })

  it('ends a stalled upstream stream on abort without waiting for another provider event', async () => {
    const controller = new AbortController()
    let started!: () => void
    const enteredStream = new Promise<void>((resolve) => { started = resolve })
    const stream = vi.fn<PiAnthropicBridge['stream']>(async function* (_model, _context, options) {
      expect(options.signal).toBe(controller.signal)
      started()
      await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }))
    })
    const provider = new PiAiAnthropicProvider({ profiles: [profile], bridge: { normalizeContext: (context) => context, stream } })
    const chunks: unknown[] = []
    const consumption = (async () => {
      for await (const chunk of provider.stream(prepared({ signal: controller.signal }))) chunks.push(chunk)
    })()
    await enteredStream
    controller.abort()
    await expect(consumption).resolves.toBeUndefined()
    expect(chunks).toEqual([{ type: 'finish', reason: 'cancelled' }])
  }, 1000)

  it('maps an iterator error racing after abort to cancellation and preserves ordinary failures', async () => {
    const aborted = new AbortController()
    const cancelledProvider = new PiAiAnthropicProvider({ profiles: [profile], bridge: {
      normalizeContext: (context) => context,
      stream: async function* () {
        aborted.abort()
        throw new Error('network reset')
      }
    } })
    const cancelledChunks = []
    for await (const chunk of cancelledProvider.stream(prepared({ signal: aborted.signal }))) cancelledChunks.push(chunk)
    expect(cancelledChunks).toEqual([{ type: 'finish', reason: 'cancelled' }])

    const active = new AbortController()
    const failingProvider = new PiAiAnthropicProvider({ profiles: [profile], bridge: {
      normalizeContext: (context) => context,
      stream: async function* () { throw new Error('network reset') }
    } })
    const consume = async () => { for await (const _chunk of failingProvider.stream(prepared({ signal: active.signal }))) void _chunk }
    await expect(consume()).rejects.toThrow('network reset')
  })

  it('requires explicit registered route identity, credential injection, and passes cancellation', async () => {
    const signal = new AbortController().signal
    const stream = vi.fn<PiAnthropicBridge['stream']>(async function* (_model, _context, options) {
      expect(options.signal).toBe(signal)
      yield { type: 'done', reason: 'stop', message: { usage: { input: 0, output: 0 } } }
    })
    const provider = new PiAiAnthropicProvider({ profiles: [profile], bridge: { normalizeContext: (value) => value, stream } })
    await expect(async () => {
      for await (const _chunk of provider.stream({ ...prepared(), route: { ...routeOf(profile), protocol: 'openai-chat-completions' } })) void _chunk
    }).rejects.toThrow('route profile mismatch')
    await expect(async () => {
      for await (const _chunk of provider.stream(prepared({ credentials: undefined }))) void _chunk
    }).rejects.toThrow('credential injection required')
    for await (const _chunk of provider.stream(prepared({ signal }))) void _chunk
  })

  it('rejects route endpoints that embed credentials or fragments', () => {
    expect(() => new PiAiAnthropicProvider({ profiles: [{ ...profile, endpoint: 'https://user:password@gateway.example/v1' }] }))
      .toThrow('Anthropic endpoint must not embed credentials or fragments')
    expect(() => new PiAiAnthropicProvider({ profiles: [{ ...profile, endpoint: 'https://gateway.example/v1#secret' }] }))
      .toThrow('Anthropic endpoint must not embed credentials or fragments')
  })
})
