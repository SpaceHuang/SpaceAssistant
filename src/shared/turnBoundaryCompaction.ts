import { resetSurface, summarizeSurface, type CompactableItem } from './compactionActions'
import { planAdaptiveCompaction, planTurnBoundaryCompaction } from './adaptiveCompaction'
import { computeShadowedRanges } from './surfaceReplay'
import type { CompactionProjection } from './contextCompaction'

export type TurnBoundaryCompactionInput = {
  projection: CompactionProjection
  items: readonly CompactableItem[]
  shouldCompact: boolean
  summaryCount?: number
  checkpointId: string
  checkpointTokens: number
}

export type TurnBoundaryCompactionResult = ReturnType<typeof planTurnBoundaryCompaction> & {
  items: CompactableItem[]
  facts: CompactableItem[]
  record?: { checkpointId: string; shadowedRanges: Array<{ start: string; end: string }> }
}

export function planTurnBoundarySurfaceCompaction(input: TurnBoundaryCompactionInput): TurnBoundaryCompactionResult {
  let currentItems = [...input.items]
  let facts = [...input.items]
  let record: TurnBoundaryCompactionResult['record']
  const result = planTurnBoundaryCompaction({
    projection: input.projection,
    shouldCompact: input.shouldCompact,
    summaryCount: input.summaryCount,
    actions: {
      prune: (projection) => ({ projection, status: 'no-op' }),
      summarize: (projection) => {
        const action = summarizeSurface(currentItems, { checkpointId: input.checkpointId, checkpointTokens: input.checkpointTokens })
        currentItems = action.items
        facts = action.facts
        record = action.record
        return { projection: { ...projection, surfaceTokens: action.items.reduce((sum, item) => sum + item.tokens, 0), bodyTokens: Math.max(0, action.items.reduce((sum, item) => sum + item.tokens, 0) - projection.requiredTokens) }, status: action.status }
      },
      reset: (projection) => {
        const action = resetSurface(currentItems, { checkpointId: input.checkpointId, checkpointTokens: input.checkpointTokens })
        currentItems = action.items
        facts = action.facts
        record = action.record
        return { projection: { ...projection, surfaceTokens: action.items.reduce((sum, item) => sum + item.tokens, 0), bodyTokens: Math.max(0, action.items.reduce((sum, item) => sum + item.tokens, 0) - projection.requiredTokens) }, status: action.status }
      }
    },
    maxSteps: 3
  })
  const finalRanges = computeShadowedRanges(input.items, currentItems)
  const finalRecord = finalRanges.length && record ? { checkpointId: input.checkpointId, shadowedRanges: finalRanges } : record
  return { ...result, items: currentItems, facts, ...(finalRecord ? { record: finalRecord } : {}) }
}

export function planUserCompactionSurface(input: {
  items: readonly CompactableItem[]
  checkpointId: string
  checkpointTokens: number
  totalInputBudget: number
}): TurnBoundaryCompactionResult {
  let currentItems = [...input.items]
  let facts = [...input.items]
  let record: TurnBoundaryCompactionResult['record']
  const surfaceTokens = input.items.reduce((sum, item) => sum + item.tokens, 0)
  const requiredTokens = input.items.filter((item) => item.required).reduce((sum, item) => sum + item.tokens, 0)
  const bodyBudget = Math.max(1, input.totalInputBudget)
  const result = planAdaptiveCompaction({
    projection: { surfaceTokens, bodyTokens: surfaceTokens, requiredTokens, totalInputBudget: bodyBudget, bodyBudget, targetBodyRatio: 0 },
    phase: 'turn_boundary', reason: 'user_compact', maxSteps: 1,
    actions: {
      prune: (projection) => ({ projection, status: 'no-op' }),
      summarize: (projection) => {
        const action = summarizeSurface(currentItems, { checkpointId: input.checkpointId, checkpointTokens: input.checkpointTokens })
        currentItems = action.items
        facts = action.facts
        record = action.record
        const nextTokens = action.items.reduce((sum, item) => sum + item.tokens, 0)
        return { projection: { ...projection, surfaceTokens: nextTokens, bodyTokens: Math.max(0, nextTokens - requiredTokens) }, status: action.status }
      },
      reset: (projection) => ({ projection, status: 'no-op' })
    }
  })
  const shadowedRanges = computeShadowedRanges(input.items, currentItems)
  const finalRecord = shadowedRanges.length && record ? { checkpointId: input.checkpointId, shadowedRanges } : record
  return { ...result, items: currentItems, facts, ...(finalRecord ? { record: finalRecord } : {}) }
}
