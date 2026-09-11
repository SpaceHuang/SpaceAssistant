import { DEFAULT_MODEL_MAX_CONTEXT } from './domainTypes'

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
