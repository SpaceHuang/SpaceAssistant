import { describe, expect, it } from 'vitest'
import { ProviderInvocation, UnsupportedReasoningError } from '../src/provider'

describe('Provider Port', () => {
  it('passes reasoning off explicitly and normalizes usage', async () => {
    const calls: unknown[] = []
    const provider = new ProviderInvocation({
      capabilities: { reasoning: ['off'] },
      invoke: async (input) => { calls.push(input); return { content: 'ok', usage: { inputTokens: 2, outputTokens: 1 } }
      }
    })
    await expect(provider.run({ model: 'fast', reasoning: 'off', prompt: '安全检查' })).resolves.toMatchObject({ content: 'ok', usage: { inputTokens: 2, outputTokens: 1 } })
    expect(calls).toEqual([{ model: 'fast', reasoning: 'off', prompt: '安全检查' }])
  })

  it('fails loudly when a requested reasoning capability is unsupported', async () => {
    const provider = new ProviderInvocation({ capabilities: { reasoning: ['off'] }, invoke: async () => ({ content: '' }) })
    await expect(provider.run({ model: 'fast', reasoning: 'low', prompt: 'x' })).rejects.toBeInstanceOf(UnsupportedReasoningError)
  })
})
