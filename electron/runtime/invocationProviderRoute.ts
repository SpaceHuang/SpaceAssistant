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
  if (!baseline) return undefined
  // 协议由服务 endpoint 明确声明时优先于模型来源厂商。DeepSeek 提供
  // Anthropic Messages 兼容 API；其专用 /anthropic 前缀是现有配置中的协议标记。
  const endpoint = input.endpoint || 'https://api.anthropic.com'
  const anthropicCompatibleEndpoint = isExplicitAnthropicCompatibleEndpoint(endpoint)
  if (baseline.sourceProvider !== 'anthropic' && !anthropicCompatibleEndpoint) return undefined
  const profile = createDesktopAnthropicRouteProfile({
    modelId: input.modelId,
    endpoint,
    credentialRef: input.credentialRef,
    contextWindow: baseline.maximumContext,
    maxOutputTokens: baseline.maxTokens,
    reasoning: baseline.reasoning
  })
  return registerDesktopAnthropicRoute(registry, profile)
}

function isExplicitAnthropicCompatibleEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'api.deepseek.com' &&
      url.pathname.replace(/\/+$/, '') === '/anthropic'
  } catch {
    return false
  }
}

/** Production composition roots must not fall back to an inferred wire protocol. */
export function requireInvocationAnthropicRoute(input: {
  modelId: string
  endpoint?: string
  credentialRef: string
}, registry: ModelProviderRegistry): string {
  if (!input.credentialRef.trim()) throw new Error('PROVIDER_ROUTE_CREDENTIAL_IDENTITY_REQUIRED')
  const routeId = registerInvocationAnthropicRoute(input, registry)
  if (!routeId) {
    const baseline = MODEL_BASELINE[input.modelId]
    const provider = baseline?.sourceProvider
    const providerLabel = provider ? `（服务商：${provider}）` : '（模型不在当前支持的模型能力基线中）'
    throw new Error(`PROVIDER_ROUTE_UNSUPPORTED: 当前对话运行时暂不支持模型「${input.modelId}」${providerLabel}。`)
  }
  return routeId
}
