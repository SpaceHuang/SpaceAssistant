import { DEFAULT_MODEL_MAX_CONTEXT } from './domainTypes'
import { estimateTokensFromUtf8Text } from './contextUsageEstimate'

export type RequestContextPayload = {
  requestId: string
  provider: string
  model: string
  contextWindow: { tokens: number; source: 'config' | 'adapter' }
  maxTokensEffective: number
  outputReserveTokens: number
  outputAccounting: 'shared' | 'separate'
  schemaVersion: 1
}

export type RequestHeaderPayload = {
  schemaVersion: 1
  requestId: string
  surfaceSnapshot: { schemaVersion: 1; fingerprint: string; systemFingerprint: string; toolsFingerprint: string; surfaceTokens: number; systemTokens: number; toolsTokens: number; messageTokens: number }
  stablePrefixFingerprint: string
  system: string
  tools: unknown[]
}

function fingerprint(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function buildRequestHeaderPayload(args: { requestId: string; system: string; tools: unknown[]; messages: unknown[] }): RequestHeaderPayload {
  const systemTokens = estimateTokensFromUtf8Text(args.system)
  const toolsTokens = estimateTokensFromUtf8Text(JSON.stringify(args.tools))
  const messageTokens = estimateTokensFromUtf8Text(JSON.stringify(args.messages))
  const systemFingerprint = fingerprint(args.system)
  const toolsFingerprint = fingerprint(JSON.stringify(args.tools))
  const surfaceFingerprint = fingerprint(JSON.stringify({ system: args.system, tools: args.tools, messages: args.messages }))
  return { schemaVersion: 1, requestId: args.requestId, system: args.system, tools: args.tools, stablePrefixFingerprint: fingerprint(`${systemFingerprint}:${toolsFingerprint}`), surfaceSnapshot: { schemaVersion: 1, fingerprint: surfaceFingerprint, systemFingerprint, toolsFingerprint, surfaceTokens: systemTokens + toolsTokens + messageTokens, systemTokens, toolsTokens, messageTokens } }
}

export function buildRequestContextPayload(args: {
  requestId: string
  provider: string
  model: string
  contextWindow?: number
  maxTokensEffective: number
  outputAccounting?: 'shared' | 'separate'
}): RequestContextPayload {
  const outputAccounting = args.outputAccounting ?? 'shared'
  const contextWindow = Number.isFinite(args.contextWindow) && args.contextWindow! > 0 ? args.contextWindow! : DEFAULT_MODEL_MAX_CONTEXT
  return {
    requestId: args.requestId,
    provider: args.provider,
    model: args.model,
    contextWindow: { tokens: contextWindow, source: 'config' },
    maxTokensEffective: Math.max(0, args.maxTokensEffective),
    outputReserveTokens: outputAccounting === 'shared' ? Math.max(0, args.maxTokensEffective) : 0,
    outputAccounting,
    schemaVersion: 1
  }
}
