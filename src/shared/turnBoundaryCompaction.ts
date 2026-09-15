import { resetSurface, summarizeSurface, type CompactableItem } from './compactionActions'
import { planTurnBoundaryCompaction } from './adaptiveCompaction'
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
