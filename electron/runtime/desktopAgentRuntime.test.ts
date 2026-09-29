import { describe, expect, it, vi } from 'vitest'
import { ModelProviderRegistry } from '../../packages/agent-sdk/src/model'
import type { ModelBaselineEntry } from '../../src/shared/modelBaseline'
import { createDesktopAgentRuntime } from './desktopAgentRuntime'
import { createDesktopAnthropicRouteProfile, registerDesktopAnthropicRoute } from '../piAiAnthropicBridge'
import { PiAiAnthropicProvider } from '../../packages/agent-provider-pi-ai/src'

vi.mock('../../src/shared/modelBaseline', () => ({
  MODEL_BASELINE: {
    'anthropic-supported': { maximumContext: 200_000, maxTokens: 8_192, isVision: true, reasoning: true, sourceProvider: 'anthropic' },
    'openai-known': { maximumContext: 128_000, maxTokens: 16_000, isVision: true, reasoning: true, sourceProvider: 'openai' }
  }
}))

describe('desktop Agent SDK provider composition', () => {
  it('owns one provider registry per runtime and only registers explicit Anthropic baseline routes', async () => {
    const { MODEL_BASELINE } = await import('../../src/shared/modelBaseline')
    const anthropicModel = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')
    expect(anthropicModel).toBeDefined()
    const [modelId, baseline] = anthropicModel!
    const first = createDesktopAgentRuntime()
    const second = createDesktopAgentRuntime()

    expect(first.modelProviders).toBeInstanceOf(ModelProviderRegistry)
    expect(first.modelProviders).not.toBe(second.modelProviders)
    expect(first.modelProviders.getRoute(`desktop-anthropic-${modelId}`)).toMatchObject({
      profile: { routeId: `desktop-anthropic-${modelId}`, protocol: 'anthropic-messages',
      dialect: 'anthropic-messages-2023-06-01', adapterVersion: 'pi-ai@0.87.1',
      modelId, endpoint: 'https://api.anthropic.com' }
    })
    expect(first.modelProviders.getRoute(`desktop-anthropic-${modelId}`)?.providerId).toBe('pi-ai-anthropic-messages')
    expect(first.modelProviders.getRoute('desktop-anthropic-openai-known')).toBeUndefined()
    expect(baseline.maximumContext).toBeGreaterThan(0)
    expect(baseline.maxTokens).toBeGreaterThan(0)
  })

  it('binds an explicitly selected Anthropic gateway endpoint and credential reference into a distinct immutable route', () => {
    const input = {
      modelId: 'claude-sonnet-4-6', endpoint: 'https://gateway.example/v1', credentialRef: 'llm-service:svc-7',
      contextWindow: 200_000, maxOutputTokens: 16_000, reasoning: true
    }
    const route = createDesktopAnthropicRouteProfile(input)
    const repeated = createDesktopAnthropicRouteProfile(input)
    const otherCredential = createDesktopAnthropicRouteProfile({ ...input, credentialRef: 'llm-service:svc-8' })

    expect(route).toMatchObject({
      protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01',
      adapterVersion: 'pi-ai@0.87.1', modelId: input.modelId, endpoint: input.endpoint,
      credentialRef: input.credentialRef
    })
    expect(route.routeId).toBe(repeated.routeId)
    expect(route.routeId).not.toBe(otherCredential.routeId)
    const registry = createDesktopAgentRuntime().modelProviders
    expect(registerDesktopAnthropicRoute(registry, route)).toBe(route.routeId)
    expect(registry.getRoute(route.routeId)).toMatchObject({ profile: { endpoint: input.endpoint, modelId: input.modelId }, providerId: 'pi-ai-anthropic-messages' })
    expect(() => new PiAiAnthropicProvider({ profiles: [route] })).not.toThrow()
  })

  it('does not guess a protocol for models missing an explicit provider baseline', async () => {
    const { MODEL_BASELINE } = await import('../../src/shared/modelBaseline')
    const baseline = MODEL_BASELINE as Record<string, ModelBaselineEntry | undefined>
    baseline['unknown-provider'] = { maximumContext: 100_000, maxTokens: 4_000, isVision: false, reasoning: false, sourceProvider: '' }
    try {
      const runtime = createDesktopAgentRuntime()
      expect(runtime.modelProviders.getRoute('desktop-anthropic-unknown-provider')).toBeUndefined()
    } finally {
      delete baseline['unknown-provider']
    }
  })
})
