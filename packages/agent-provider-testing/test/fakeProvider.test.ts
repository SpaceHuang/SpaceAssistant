import { describe, expect, it } from 'vitest'
import { CanonicalFakeProvider, createOpenAiProtocolFixtures } from '../src'
import type { PreparedModelCall } from '../../agent-sdk/src/model'

describe('CanonicalFakeProvider', () => {
  it('records route-bound calls and streams a canonical fixture exactly once', async () => {
    const provider = new CanonicalFakeProvider([{ type: 'usage', inputTokens: 2, outputTokens: 1 }, { type: 'finish', reason: 'stop' }])
    const call: PreparedModelCall = {
      route: { routeId: 'r', protocol: 'openai-responses', dialect: 'responses-v1', adapterVersion: 'fake-1', modelId: 'test-model' },
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 20 }
    }
    const received = []
    for await (const chunk of provider.stream(call)) received.push(chunk)
    expect(received.map((item) => item.type)).toEqual(['usage', 'finish'])
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]?.route.protocol).toBe('openai-responses')
    const again = async () => { for await (const _chunk of provider.stream(call)) void _chunk }
    await expect(again()).rejects.toThrow('fake stream already consumed')
  })

  it('provides independent canonical contract fixtures for Chat Completions and Responses', async () => {
    const fixtures = createOpenAiProtocolFixtures()
    expect(fixtures['openai-chat-completions'].map((chunk) => chunk.type)).toEqual(['text-delta', 'tool-call', 'usage', 'finish'])
    expect(fixtures['openai-responses'].map((chunk) => chunk.type)).toEqual(['thinking-delta', 'text-delta', 'usage', 'finish'])
    for (const protocol of ['openai-chat-completions', 'openai-responses'] as const) {
      const provider = new CanonicalFakeProvider(fixtures[protocol])
      const call: PreparedModelCall = {
        route: { routeId: protocol, protocol, dialect: `${protocol}-fixture-v1`, adapterVersion: 'fake-1', modelId: 'fixture-model' },
        request: { messages: [{ role: 'user', content: 'fixture' }], maxTokens: 16 }
      }
      const received = []
      for await (const chunk of provider.stream(call)) received.push(chunk)
      expect(received).toEqual(fixtures[protocol])
    }
  })
})
