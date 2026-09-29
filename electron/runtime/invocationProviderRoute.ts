import type { ModelProviderRegistry } from '../../packages/agent-sdk/src/model'
import { MODEL_BASELINE } from '../../src/shared/modelBaseline'
import { createDesktopAnthropicRouteProfile, registerDesktopAnthropicRoute } from '../piAiAnthropicBridge'

/** Register a provider route only when the product baseline explicitly identifies Anthropic semantics. */
export function registerInvocationAnthropicRoute(input: {
  modelId: string
  endpoint?: string
  credentialRef: string
}, registry: ModelProviderRegistry): string | undefined {
  const baseline = MODEL_BASELINE[input.modelId]
  if (!baseline || baseline.sourceProvider !== 'anthropic') return undefined
  const profile = createDesktopAnthropicRouteProfile({
    modelId: input.modelId,
    endpoint: input.endpoint || 'https://api.anthropic.com',
    credentialRef: input.credentialRef,
    contextWindow: baseline.maximumContext,
    maxOutputTokens: baseline.maxTokens,
    reasoning: baseline.reasoning
  })
  return registerDesktopAnthropicRoute(registry, profile)
}

/** Production composition roots must not fall back to an inferred wire protocol. */
export function requireInvocationAnthropicRoute(input: {
  modelId: string
  endpoint?: string
  credentialRef: string
}, registry: ModelProviderRegistry): string {
  if (!input.credentialRef.trim()) throw new Error('PROVIDER_ROUTE_CREDENTIAL_IDENTITY_REQUIRED')
  const routeId = registerInvocationAnthropicRoute(input, registry)
  if (!routeId) throw new Error('PROVIDER_ROUTE_UNSUPPORTED')
  return routeId
}
