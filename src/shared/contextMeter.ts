import { computeTotalRequestInputTokens, type ContextUsageRaw } from './contextUsageEstimate'

export type ContextWindow = { tokens: number; source: 'config' | 'adapter' }
export type SurfaceSnapshot = {
  schemaVersion: number
  fingerprint: string
  systemFingerprint: string
  toolsFingerprint: string
  surfaceTokens: number
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}
export type ContextInput = {
  currentSurface: SurfaceSnapshot
  anchor?: {
    requestId: string
    surfaceTokens: number
    surfaceFingerprint: string
    systemFingerprint: string
    toolsFingerprint: string
    provider: string
    model: string
    estimatorVersion: string
    serializationVersion: string
    realUsage: ContextUsageRaw
    contextWindow: number
  }
  budget: {
    totalInputBudget: number
    bodyBudget: number
    inputBudget: number
    prefixTokens: number
    requiredTokens: number
    outputReserveTokens: number
    safetyReserveTokens: number
    triggerRatio: number
    targetBodyRatio: number
    estimatorVersion: string
    serializationVersion: string
  }
  decision: { decisionId: string; phase: 'tool_loop' | 'turn_boundary' | 'recovery'; reason: 'proactive' | 'provider_overflow' | 'user_compact' | 'user_reset'; ruleVersion: string }
  contextWindow: ContextWindow
}

export type ContextPressureProjection = {
  pressureTokens: number | null
  projectedTokens: number | null
  anchorStatus: 'missing' | 'matched' | 'mismatch' | 'prefix-changed' | 'invalid'
  surfaceTokens: number
  bodyTokens: number
  bodyRatio: number
  hardFit: boolean
  bodyFit: boolean
  contextWindow: ContextWindow
}

export type ContextBreakdownProjection = Pick<SurfaceSnapshot, 'systemTokens' | 'toolsTokens' | 'messageTokens'>

function anchorStatus(input: ContextInput): ContextPressureProjection['anchorStatus'] {
  const anchor = input.anchor
  if (!anchor) return 'missing'
  if (!Number.isFinite(anchor.surfaceTokens) || anchor.contextWindow !== input.contextWindow.tokens) return 'mismatch'
  if (anchor.systemFingerprint === input.currentSurface.systemFingerprint && anchor.toolsFingerprint === input.currentSurface.toolsFingerprint && anchor.estimatorVersion === input.budget.estimatorVersion && anchor.serializationVersion === input.budget.serializationVersion) return 'matched'
  if (anchor.systemFingerprint !== input.currentSurface.systemFingerprint || anchor.toolsFingerprint !== input.currentSurface.toolsFingerprint) return 'prefix-changed'
  return 'mismatch'
}

export function computeContextBreakdown(input: ContextInput): ContextBreakdownProjection {
  const { systemTokens, toolsTokens, messageTokens } = input.currentSurface
  return { systemTokens, toolsTokens, messageTokens }
}

export function computeContextPressure(input: ContextInput): ContextPressureProjection {
  const surfaceTokens = Math.max(0, input.currentSurface.surfaceTokens)
  const status = anchorStatus(input)
  const pressureTokens = status === 'matched' ? computeTotalRequestInputTokens(input.anchor!.realUsage) : null
  const projectedTokens = pressureTokens == null ? null : pressureTokens + (surfaceTokens - input.anchor!.surfaceTokens)
  const bodyTokens = Math.max(0, (projectedTokens ?? surfaceTokens) - input.budget.prefixTokens)
  const bodyRatio = input.budget.bodyBudget > 0 ? bodyTokens / input.budget.bodyBudget : 0
  return { pressureTokens, projectedTokens, anchorStatus: status, surfaceTokens, bodyTokens, bodyRatio, hardFit: surfaceTokens <= input.budget.totalInputBudget, bodyFit: bodyTokens <= input.budget.bodyBudget, contextWindow: input.contextWindow }
}

export function shouldCompact(projection: ContextPressureProjection, budget: ContextInput['budget']): boolean {
  if (projection.projectedTokens == null || budget.bodyBudget <= 0) return false
  const ratio = Math.min(Math.max(0, budget.triggerRatio), 0.9)
  const projectedBodyTokens = Math.max(0, projection.projectedTokens - budget.prefixTokens)
  return projectedBodyTokens / budget.bodyBudget >= ratio
}
