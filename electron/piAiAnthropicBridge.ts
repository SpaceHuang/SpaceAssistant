import { PiAiAnthropicProvider, type AnthropicRouteProfile, type PiAnthropicBridge } from '@spaceassistant/agent-provider-pi-ai'
import { createHash } from 'node:crypto'
import type { ModelProviderRegistry } from '@spaceassistant/agent-sdk/model'

const importNativeModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Record<string, (...args: never[]) => unknown>>

const bridge: PiAnthropicBridge = {
  normalizeContext: (context) => {
    // The provider package owns protocol serialization; loading remains lazy until a route is used.
    return importNativeModule('@earendil-works/pi-ai/utils/transcript').then((transcript) => transcript.normalizeContext(context as never))
  },
  stream: async function* (model, context, options) {
    const api = await importNativeModule('@earendil-works/pi-ai/api/anthropic-messages')
    yield* api.stream(model as never, context as never, options as never) as AsyncIterable<never>
  }
}

export function createDesktopAnthropicProvider(profiles: readonly AnthropicRouteProfile[]): PiAiAnthropicProvider {
  return new PiAiAnthropicProvider({ profiles, bridge })
}

export function registerDesktopAnthropicRoute(registry: ModelProviderRegistry, profile: AnthropicRouteProfile): string {
  const provider = createDesktopAnthropicProvider([profile])
  registry.register({
    routeId: profile.routeId,
    protocol: profile.protocol,
    dialect: profile.dialect,
    adapterVersion: profile.adapterVersion,
    modelId: profile.modelId,
    endpoint: profile.endpoint
  }, provider)
  return profile.routeId
}

export function createDesktopAnthropicRouteProfile(input: {
  modelId: string
  endpoint: string
  credentialRef: string
  contextWindow: number
  maxOutputTokens: number
  reasoning: boolean
  strictJsonSchema?: boolean
}): AnthropicRouteProfile {
  return {
    routeId: `desktop-anthropic:${createRouteIdentity(input.modelId, input.endpoint, input.credentialRef)}`,
    protocol: 'anthropic-messages',
    dialect: 'anthropic-messages-2023-06-01',
    adapterVersion: 'pi-ai@0.87.1',
    modelId: input.modelId,
    endpoint: input.endpoint,
    credentialRef: input.credentialRef,
    modelCapabilities: {
      contextWindow: input.contextWindow,
      maxOutputTokens: input.maxOutputTokens,
      reasoning: input.reasoning,
      strictJsonSchema: input.strictJsonSchema ?? false
    }
  }
}

function createRouteIdentity(modelId: string, endpoint: string, credentialRef: string): string {
  return createHash('sha256').update(`${modelId}\0${endpoint}\0${credentialRef}`).digest('hex').slice(0, 24)
}
