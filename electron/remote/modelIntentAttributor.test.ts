import { beforeEach, describe, expect, it, vi } from 'vitest'

const createAnthropicClient = vi.fn()
vi.mock('../anthropicClientFactory', () => ({ createAnthropicClient: (...args: unknown[]) => createAnthropicClient(...args) }))

import { createModelIntentAttributor } from './modelIntentAttributor'

describe('model intent attributor', () => {
  beforeEach(() => createAnthropicClient.mockReset())

  it('sends only message and bounded Track summaries to a tool-free classification request', async () => {
    const messagesCreate = vi.fn(async () => ({ content: [{ type: 'text', text: '{"scores":[{"trackId":"track-a","score":0.91}]}' }],
      usage: { input_tokens: 120, output_tokens: 15, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }))
    createAnthropicClient.mockReturnValue({ messages: { create: messagesCreate } })
    const estimateCostUsd = Object.assign(vi.fn(() => 0.00042), { pricingEvidence: {
      sourceUrl: 'https://provider.example.test/pricing', effectiveAt: '2026-10-01', verifiedAt: '2026-10-10', verifiedBy: 'operator-1'
    } })
    const attributor = createModelIntentAttributor({ getApiKey: async () => 'secret', getBaseUrl: () => 'https://api.test', getModel: () => 'model', estimateCostUsd })
    const controller = new AbortController()
    await expect(attributor.classify({ text: '继续查上一项', deadlineMs: 100, candidates: [
      { trackId: 'track-a', state: 'processing', summary: '知乎检索', updatedAt: 1 }
    ], signal: controller.signal })).resolves.toMatchObject({ kind: 'scores', scores: [{ trackId: 'track-a', score: 0.91 }],
      metering: { providerCallMade: true, inputTokens: 120, outputTokens: 15, estimatedCostUsd: 0.00042,
        pricingEvidence: { sourceUrl: 'https://provider.example.test/pricing', effectiveAt: '2026-10-01', verifiedAt: '2026-10-10', verifiedBy: 'operator-1' } } })
    expect(estimateCostUsd).toHaveBeenCalledWith({ inputTokens: 120, outputTokens: 15, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
    expect(createAnthropicClient).toHaveBeenCalledWith('secret', 'https://api.test')
    expect(messagesCreate.mock.calls[0]?.[0]).toMatchObject({ model: 'model', max_tokens: 300 })
    expect(messagesCreate.mock.calls[0]?.[1]).toEqual({ signal: controller.signal })
    expect(messagesCreate.mock.calls[0][0]).not.toHaveProperty('tools')
  })

  it('fails closed for missing credentials, provider errors, and classifier output outside candidate IDs', async () => {
    const missing = createModelIntentAttributor({ getApiKey: async () => null, getBaseUrl: () => '', getModel: () => 'model' })
    await expect(missing.classify({ text: 'x', candidates: [], deadlineMs: 1 })).resolves.toMatchObject({ kind: 'unavailable', reasonCode: 'provider-error',
      metering: { providerCallMade: false, inputTokens: null, outputTokens: null, estimatedCostUsd: null } })
    createAnthropicClient.mockReturnValue({ messages: { create: vi.fn(async () => ({ content: [{ type: 'text', text: '{"scores":[{"trackId":"foreign","score":1}]}' }] })) } })
    const attributor = createModelIntentAttributor({ getApiKey: async () => 'secret', getBaseUrl: () => '', getModel: () => 'model' })
    await expect(attributor.classify({ text: 'x', candidates: [{ trackId: 'track-a', state: 'open', summary: '', updatedAt: 1 }], deadlineMs: 1 }))
      .resolves.toMatchObject({ kind: 'unavailable', reasonCode: 'invalid-output', metering: { providerCallMade: true } })
  })

  it('exposes a stable opaque classifier version that changes with model endpoint configuration', () => {
    const first = createModelIntentAttributor({ getApiKey: async () => 'secret-a', getBaseUrl: () => 'https://api.test', getModel: () => 'model-a' })
    const retry = createModelIntentAttributor({ getApiKey: async () => 'secret-b', getBaseUrl: () => 'https://api.test', getModel: () => 'model-a' })
    const changed = createModelIntentAttributor({ getApiKey: async () => 'secret-a', getBaseUrl: () => 'https://other.test', getModel: () => 'model-a' })
    expect(first.classifierVersion).toMatch(/^chat-[a-f0-9]{16}$/)
    expect(retry.classifierVersion).toBe(first.classifierVersion)
    expect(changed.classifierVersion).not.toBe(first.classifierVersion)
    expect(first.classifierVersion).not.toContain('https://')
  })
})
