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
  provider?: string
  model?: string
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
  if ((input.provider && input.provider !== anchor.provider) || (input.model && input.model !== anchor.model)) return 'mismatch'
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

/** 唯一生产适配器：从 append-only 事件流重建可复用的 usage anchor。 */
export function computeContextPressureFromEvents(
  events: ReadonlyArray<{ seq: number; type: string; payload: Record<string, unknown> }>,
  input: Omit<ContextInput, 'anchor'> & { anchor?: ContextInput['anchor'] }
): ContextPressureProjection {
  const requestId = typeof input.anchor?.requestId === 'string' ? input.anchor.requestId : undefined
  const headers = events.filter((event) => event.type === 'request_header' && event.payload.schemaVersion === 1)
  const candidates = headers
    .map((header) => {
      const id = typeof header.payload.requestId === 'string' ? header.payload.requestId : undefined
      const snapshot = header.payload.surfaceSnapshot
      if (!id || !snapshot || typeof snapshot !== 'object') return undefined
      const context = [...events].reverse().find((event) => event.type === 'request_context' && event.payload.schemaVersion === 1 && event.payload.requestId === id)
      const usage = events.find((event) => event.type === 'request_usage' && event.payload.schemaVersion === 1 && event.payload.requestId === id)
      if (!context || !usage || !context.payload.contextWindow || !usage.payload.usage) return undefined
      const contextWindow = context.payload.contextWindow
      const windowTokens = typeof contextWindow === 'object' && contextWindow !== null && typeof (contextWindow as { tokens?: unknown }).tokens === 'number' ? (contextWindow as { tokens: number }).tokens : typeof contextWindow === 'number' ? contextWindow : undefined
      if (!windowTokens) return undefined
      const s = snapshot as Partial<SurfaceSnapshot> & { surfaceFingerprint?: string }
      if (s.schemaVersion !== 1 || typeof s.surfaceFingerprint !== 'string' && typeof s.fingerprint !== 'string') return undefined
      return { id, snapshot: { ...s, schemaVersion: 1, fingerprint: s.fingerprint ?? s.surfaceFingerprint!, systemFingerprint: s.systemFingerprint ?? '', toolsFingerprint: s.toolsFingerprint ?? '', surfaceTokens: s.surfaceTokens ?? 0, systemTokens: s.systemTokens ?? 0, toolsTokens: s.toolsTokens ?? 0, messageTokens: s.messageTokens ?? 0 } as SurfaceSnapshot, context, usage, windowTokens }
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
  const candidate = requestId ? candidates.find((item) => item.id === requestId) : candidates[candidates.length - 1]
  if (!candidate) return computeContextPressure({ ...input, anchor: undefined })
  const contextWindow = candidate.context.payload.contextWindow
  const anchor = { requestId: candidate.id, surfaceTokens: candidate.snapshot.surfaceTokens, surfaceFingerprint: candidate.snapshot.fingerprint, systemFingerprint: candidate.snapshot.systemFingerprint, toolsFingerprint: candidate.snapshot.toolsFingerprint, provider: String(candidate.context.payload.provider ?? ''), model: String(candidate.context.payload.model ?? ''), estimatorVersion: String(candidate.context.payload.estimatorVersion ?? input.budget.estimatorVersion), serializationVersion: String(candidate.context.payload.serializationVersion ?? input.budget.serializationVersion), realUsage: candidate.usage.payload.usage as ContextUsageRaw, contextWindow: typeof contextWindow === 'number' ? contextWindow : (contextWindow as { tokens: number }).tokens }
  return computeContextPressure({ ...input, anchor })
}
