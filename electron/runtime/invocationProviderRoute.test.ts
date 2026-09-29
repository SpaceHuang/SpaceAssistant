import { describe, expect, it } from 'vitest'
import { ModelProviderRegistry } from '../../packages/agent-sdk/src/model'
import { MODEL_BASELINE } from '../../src/shared/modelBaseline'
import { registerInvocationAnthropicRoute, requireInvocationAnthropicRoute } from './invocationProviderRoute'

describe('registerInvocationAnthropicRoute', () => {
  it('registers only baseline Anthropic models with the resolved endpoint and credential identity', () => {
    const registry = new ModelProviderRegistry()
    const modelId = Object.entries(MODEL_BASELINE).find(([, baseline]) => baseline.sourceProvider === 'anthropic')?.[0]
    expect(modelId).toBeTruthy()
    const routeId = registerInvocationAnthropicRoute({
      modelId: modelId!,
      endpoint: 'https://gateway.example/v1',
      credentialRef: 'llm-service:svc-7'
    }, registry)

    expect(routeId).toBeTruthy()
    expect(registry.getRoute(routeId!)).toMatchObject({
      profile: {
        routeId,
        protocol: 'anthropic-messages',
        dialect: 'anthropic-messages-2023-06-01',
        adapterVersion: 'pi-ai@0.87.1',
        modelId: modelId!,
        endpoint: 'https://gateway.example/v1'
      },
      providerId: 'pi-ai-anthropic-messages'
    })
  })

  it('does not infer a provider for an unknown model', () => {
    const registry = new ModelProviderRegistry()
    expect(registerInvocationAnthropicRoute({
      modelId: 'custom-unlisted-model', endpoint: 'https://gateway.example', credentialRef: 'llm-service:svc-7'
    }, registry)).toBeUndefined()
    expect(registry.getRoute('custom-unlisted-model')).toBeUndefined()
  })

  it('fails closed when a production invocation has no explicitly supported Anthropic route', () => {
    const registry = new ModelProviderRegistry()
    expect(() => requireInvocationAnthropicRoute({
      modelId: 'custom-unlisted-model', endpoint: 'https://gateway.example', credentialRef: 'llm-service:svc-7'
    }, registry)).toThrow('PROVIDER_ROUTE_UNSUPPORTED')
    expect(() => requireInvocationAnthropicRoute({
      modelId: 'custom-unlisted-model', endpoint: 'https://gateway.example', credentialRef: ''
    }, registry)).toThrow('PROVIDER_ROUTE_CREDENTIAL_IDENTITY_REQUIRED')
  })
})
