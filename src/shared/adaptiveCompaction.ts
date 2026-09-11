import type { CompactionProjection } from './contextCompaction'

export const adaptiveRules = [
  { id: 'tool-loop-prune', phase: 'tool_loop', action: 'prune' as const },
  { id: 'turn-prune', phase: 'turn_boundary', action: 'prune' as const },
  { id: 'turn-summary', phase: 'turn_boundary', action: 'summarize' as const },
  { id: 'turn-reset', phase: 'turn_boundary', action: 'reset' as const }
] as const

export type PrunableSurfaceItem = { id: string; tokens: number; cacheBoundary: boolean }
export type PruneResult = { status: 'applied' | 'no-op'; items: PrunableSurfaceItem[]; projection: CompactionProjection }

export function pruneSurface(projection: CompactionProjection, items: readonly PrunableSurfaceItem[]): PruneResult {
  const eligible = items.filter((item) => !item.cacheBoundary && item.tokens > 0)
  if (!eligible.length) return { status: 'no-op', items: [...items], projection }
  const target = projection.bodyBudget * projection.targetBodyRatio
  let excess = Math.max(1, projection.bodyTokens - target)
  const next = items.map((item) => {
    if (item.cacheBoundary || excess <= 0) return { ...item }
    const removed = Math.min(item.tokens, excess)
    excess -= removed
    return { ...item, tokens: item.tokens - removed }
  })
  const removed = items.reduce((sum, item, i) => sum + item.tokens - next[i]!.tokens, 0)
  if (removed <= 0) return { status: 'no-op', items: next, projection }
  return { status: 'applied', items: next, projection: { ...projection, surfaceTokens: projection.surfaceTokens - removed, bodyTokens: projection.bodyTokens - removed } }
}
