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
  budget: { totalInputBudget: number; bodyBudget: number; inputBudget: number; prefixTokens: number; requiredTokens: number; outputReserveTokens: number; safetyReserveTokens: number; triggerRatio: number; targetBodyRatio: number; estimatorVersion: string; serializationVersion: string }
  contextUsage: { pressureTokens: number | null; projectedTokens: number | null; surfaceTokens: number; hardFit: boolean; bodyFit: boolean }
  decisionId: string
  phase: string
  reason: string
  ruleVersion: string
  decisionFingerprint: string
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
  surfaceSnapshot?: { surfaceTokens: number; systemTokens: number; toolsTokens?: number }
  decision?: { decisionId: string; phase: string; reason: string; ruleVersion: string }
}): RequestContextPayload {
  const outputAccounting = args.outputAccounting ?? 'shared'
  const contextWindow = Number.isFinite(args.contextWindow) && args.contextWindow! > 0 ? args.contextWindow! : DEFAULT_MODEL_MAX_CONTEXT
  const prefixTokens = Math.max(0, (args.surfaceSnapshot?.systemTokens ?? 0) + (args.surfaceSnapshot?.toolsTokens ?? 0))
  const rawInputWindow = Math.max(0, contextWindow - (outputAccounting === 'shared' ? Math.max(0, args.maxTokensEffective) : 0))
  const totalInputBudget = Math.max(0, Math.floor(rawInputWindow * 0.95))
  const bodyBudget = Math.max(0, totalInputBudget - prefixTokens)
  const surfaceTokens = args.surfaceSnapshot?.surfaceTokens ?? prefixTokens
  const decision = args.decision ?? { decisionId: args.requestId, phase: 'turn_boundary', reason: 'proactive', ruleVersion: 'adaptive-v1' }
  const decisionFingerprint = fingerprint(JSON.stringify({ ...decision, surfaceTokens, prefixTokens, totalInputBudget, bodyBudget, triggerRatio: 0.9, targetBodyRatio: 0.8, contextWindow }))
  return {
    requestId: args.requestId,
    provider: args.provider,
    model: args.model,
    contextWindow: { tokens: contextWindow, source: 'config' },
    maxTokensEffective: Math.max(0, args.maxTokensEffective),
    outputReserveTokens: outputAccounting === 'shared' ? Math.max(0, args.maxTokensEffective) : 0,
    outputAccounting,
    schemaVersion: 1,
    budget: { totalInputBudget, bodyBudget, inputBudget: bodyBudget, prefixTokens, requiredTokens: 0, outputReserveTokens: outputAccounting === 'shared' ? Math.max(0, args.maxTokensEffective) : 0, safetyReserveTokens: 0, triggerRatio: 0.9, targetBodyRatio: 0.8, estimatorVersion: 'default-v1', serializationVersion: 'anthropic-wire-v1' },
    contextUsage: { pressureTokens: null, projectedTokens: null, surfaceTokens, hardFit: surfaceTokens <= totalInputBudget, bodyFit: Math.max(0, surfaceTokens - prefixTokens) <= bodyBudget },
    ...decision,
    decisionFingerprint
  }
}
