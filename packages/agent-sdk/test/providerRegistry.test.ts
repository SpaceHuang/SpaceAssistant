import { describe, expect, it } from 'vitest'
import { ModelProviderRegistry, ModelRouteChangedError, UnknownModelRouteError, type ModelProvider } from '../src/model'

const fake = (providerId: string): ModelProvider => ({ providerId, async *stream() {
  yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
  yield { type: 'finish', reason: 'stop' }
} })

const route = { routeId: 'anthropic-prod', protocol: 'anthropic-messages', dialect: 'anthropic-2023-06-01', adapterVersion: '1', modelId: 'claude-sonnet' }

describe('ModelProviderRegistry', () => {
  it('rejects invalid maxTokens when preparing a registered route', () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, fake('fake'))

    expect(() => registry.prepare(route.routeId, { messages: [], maxTokens: 0 })).toThrow('maxTokens must be a positive integer')
  })

  it('requires explicit route identity and atomically replaces a route generation', async () => {
    const registry = new ModelProviderRegistry()
    const firstGeneration = registry.register(route, fake('fake-one'))
    const prepared = registry.prepare('anthropic-prod', { messages: [], maxTokens: 50 })
    const secondGeneration = registry.register(route, fake('fake-two'))
    expect(secondGeneration).toBe(firstGeneration + 1)
    expect(prepared.generation).toBe(firstGeneration)
    expect(() => registry.prepare('model-name-guessed', { messages: [], maxTokens: 50 })).toThrow(UnknownModelRouteError)
    expect(() => registry.getProvider(prepared)).toThrow(ModelRouteChangedError)
  })

  it('rejects a prepared call after its route generation has been replaced', async () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, fake('fake-one'))
    const prepared = registry.prepare(route.routeId, { messages: [], maxTokens: 50 })
    registry.register(route, fake('fake-two'))

    expect(() => registry.getProvider(prepared)).toThrow(ModelRouteChangedError)
  })

  it('keeps a prepared route valid when an unrelated route is registered', () => {
    const registry = new ModelProviderRegistry()
    registry.register(route, fake('fake-one'))
    const prepared = registry.prepare(route.routeId, { messages: [], maxTokens: 50 })
    registry.register({ ...route, routeId: 'unrelated-route', modelId: 'other-model' }, fake('fake-two'))

    expect(registry.getProvider(prepared)).toMatchObject({ providerId: 'fake-one' })
  })

  it('rejects unsupported dialects instead of inferring from endpoint/model name', () => {
    const registry = new ModelProviderRegistry({ supportedProtocols: ['anthropic-messages'] })
    expect(() => registry.register({ ...route, protocol: 'openai-chat-completions' }, fake('fake'))).toThrow('protocol not enabled')
  })
})
