import { describe, expect, it } from 'vitest'
import { collectModelAttempt, collectModelStream, InvalidModelStreamError, type StreamChunk } from '../src/model'
import { prepareModelCall } from '../src/model'

async function* chunks(items: StreamChunk[]) { yield* items }

describe('canonical model stream', () => {
  it('notifies the SDK observer of provider usage before the stream reaches finish', async () => {
    let releaseFinish!: () => void
    let providerFinished = false
    let resolveUsageObserved!: () => void
    const finishGate = new Promise<void>((resolve) => { releaseFinish = resolve })
    const usageObserved = new Promise<void>((resolve) => { resolveUsageObserved = resolve })
    async function* providerStream(): AsyncIterable<StreamChunk> {
      yield { type: 'usage', inputTokens: 1500, outputTokens: 2, cacheReadInputTokens: 200 }
      await finishGate
      providerFinished = true
      yield { type: 'finish', reason: 'stop' }
    }

    const collected = collectModelAttempt(providerStream(), {
      onChunk(chunk) { if (chunk.type === 'usage') resolveUsageObserved() }
    })
    await usageObserved
    expect(providerFinished).toBe(false)
    releaseFinish()
    await expect(collected).resolves.toMatchObject({ usage: {
      inputTokens: 1500, outputTokens: 2, cacheReadInputTokens: 200
    } })
    expect(providerFinished).toBe(true)
  })

  it('public attempt collector preserves canonical chunk order and validates terminal usage/finish', async () => {
    const items: StreamChunk[] = [
      { type: 'text-delta', text: 'answer' },
      { type: 'usage', inputTokens: 3, outputTokens: 2 },
      { type: 'finish', reason: 'stop' }
    ]
    await expect(collectModelAttempt(chunks(items))).resolves.toEqual({ chunks: items.slice(0, 2), usage: items[1], finish: items[2] })
    await expect(collectModelAttempt(chunks([{ type: 'finish', reason: 'stop' }]))).rejects.toBeInstanceOf(InvalidModelStreamError)
  })

  it('requires terminal tool-calls reason to match the presence of tool-call chunks', async () => {
    await expect(collectModelAttempt(chunks([
      { type: 'tool-call', toolCallId: 'tc-1', toolName: 'lookup', input: {} },
      { type: 'usage', inputTokens: 1, outputTokens: 1 },
      { type: 'finish', reason: 'stop' }
    ]))).rejects.toMatchObject({ code: 'INVALID_MODEL_STREAM' })
    await expect(collectModelAttempt(chunks([
      { type: 'usage', inputTokens: 1, outputTokens: 1 },
      { type: 'finish', reason: 'tool-calls' }
    ]))).rejects.toMatchObject({ code: 'INVALID_MODEL_STREAM' })
  })

  it('rejects empty or repeated canonical tool-call identities', async () => {
    for (const calls of [
      [{ type: 'tool-call', toolCallId: '', toolName: 'lookup', input: {} } as const],
      [
        { type: 'tool-call', toolCallId: 'same', toolName: 'lookup', input: {} } as const,
        { type: 'tool-call', toolCallId: 'same', toolName: 'lookup', input: {} } as const
      ]
    ]) {
      await expect(collectModelAttempt(chunks([
        ...calls,
        { type: 'usage', inputTokens: 1, outputTokens: 1 },
        { type: 'finish', reason: 'tool-calls' }
      ]))).rejects.toMatchObject({ code: 'INVALID_MODEL_STREAM' })
    }
  })

  it('requires usage before exactly one terminal finish', async () => {
    const result = await collectModelStream(chunks([
      { type: 'text-delta', text: 'hello' },
      { type: 'usage', inputTokens: 2, outputTokens: 1 },
      { type: 'finish', reason: 'stop' }
    ]))
    expect(result.finish.reason).toBe('stop')
  })

  it('rejects missing usage, duplicate finish, and events after finish', async () => {
    await expect(collectModelStream(chunks([{ type: 'finish', reason: 'stop' }]))).rejects.toBeInstanceOf(InvalidModelStreamError)
    await expect(collectModelStream(chunks([
      { type: 'usage', inputTokens: 0, outputTokens: 0 }, { type: 'finish', reason: 'stop' }, { type: 'finish', reason: 'stop' }
    ]))).rejects.toBeInstanceOf(InvalidModelStreamError)
    await expect(collectModelStream(chunks([
      { type: 'usage', inputTokens: 0, outputTokens: 0 }, { type: 'finish', reason: 'stop' }, { type: 'text-delta', text: 'late' }
    ]))).rejects.toBeInstanceOf(InvalidModelStreamError)
  })

  it('freezes route and request data while preserving the invocation AbortSignal identity', () => {
    const controller = new AbortController()
    const call = prepareModelCall({
      route: { routeId: 'r', protocol: 'anthropic-messages', dialect: 'v1', adapterVersion: '1', modelId: 'm' },
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 10, signal: controller.signal, credentials: { apiKey: 'ephemeral-key' } }
    })
    expect(call.request.signal).toBe(controller.signal)
    expect(Object.isFrozen(call.route)).toBe(true)
    expect(Object.isFrozen(call.request.messages[0])).toBe(true)
  })

  it('freezes tool schemas and thinking options in the prepared request snapshot', () => {
    const call = prepareModelCall({
      route: { routeId: 'r', protocol: 'anthropic-messages', dialect: 'v1', adapterVersion: '1', modelId: 'm' },
      request: {
        messages: [], maxTokens: 100,
        tools: [{ name: 'read_file', description: 'Read file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
        thinking: { enabled: true, budgetTokens: 500 }
      }
    })
    expect(Object.isFrozen(call.request.tools)).toBe(true)
    expect(Object.isFrozen(call.request.tools?.[0]?.inputSchema)).toBe(true)
    expect(call.request.thinking).toEqual({ enabled: true, budgetTokens: 500 })
  })
})
