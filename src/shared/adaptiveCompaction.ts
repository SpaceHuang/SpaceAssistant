import { planCompaction, type CompactionActionResult, type CompactionPlanResult, type CompactionProjection } from './contextCompaction'

export type CompactionPhase = 'tool_loop' | 'turn_boundary' | 'any'
export type CompactionReason = 'provider_overflow' | 'user_reset' | 'user_compact' | 'should_compact'
export type AdaptiveRule = { id: string; phase: CompactionPhase; reason: CompactionReason; action: 'prune' | 'summarize' | 'reset'; minSummaryCount?: number }
export const adaptiveRules: readonly AdaptiveRule[] = [
  { id: 'overflow-reset', phase: 'any', reason: 'provider_overflow', action: 'reset' },
  { id: 'user-reset', phase: 'any', reason: 'user_reset', action: 'reset' },
  { id: 'user-summary', phase: 'any', reason: 'user_compact', action: 'summarize' },
  { id: 'tool-loop-prune', phase: 'tool_loop', reason: 'should_compact', action: 'prune' },
  { id: 'turn-reset-after-summaries', phase: 'turn_boundary', reason: 'should_compact', action: 'reset', minSummaryCount: 3 },
  { id: 'turn-prune', phase: 'turn_boundary', reason: 'should_compact', action: 'prune' },
  { id: 'turn-summary', phase: 'turn_boundary', reason: 'should_compact', action: 'summarize' },
  { id: 'turn-reset-fallback', phase: 'turn_boundary', reason: 'should_compact', action: 'reset' }
]
export const classicRules: readonly AdaptiveRule[] = [
  { id: 'classic-prune', phase: 'any', reason: 'should_compact', action: 'prune' },
  { id: 'classic-summary', phase: 'any', reason: 'should_compact', action: 'summarize' }
]
export const resetFirstRules: readonly AdaptiveRule[] = [
  { id: 'reset-first', phase: 'any', reason: 'should_compact', action: 'reset' },
  { id: 'reset-first-summary', phase: 'any', reason: 'should_compact', action: 'summarize' }
]
export const compactionPresets = { adaptive: adaptiveRules, classic: classicRules, 'reset-first': resetFirstRules } as const
export function getCompactionRules(preset: keyof typeof compactionPresets = 'adaptive'): readonly AdaptiveRule[] {
  return compactionPresets[preset]
}

export function selectCompactionRules(
  rules: readonly AdaptiveRule[],
  context: { phase: Exclude<CompactionPhase, 'any'>; reason: CompactionReason; summaryCount?: number }
): readonly AdaptiveRule[] {
  return rules.filter((rule) =>
    (rule.phase === 'any' || rule.phase === context.phase) &&
    rule.reason === context.reason &&
    (rule.minSummaryCount == null || (context.summaryCount ?? 0) >= rule.minSummaryCount)
  )
}

export function planAdaptiveCompaction(args: {
  projection: CompactionProjection
  preset?: keyof typeof compactionPresets
  phase: Exclude<CompactionPhase, 'any'>
  reason: CompactionReason
  summaryCount?: number
  actions: Record<'prune' | 'summarize' | 'reset', (projection: CompactionProjection) => CompactionActionResult>
  maxSteps: number
}): CompactionPlanResult {
  return planCompaction({
    projection: args.projection,
    rules: selectCompactionRules(getCompactionRules(args.preset), { phase: args.phase, reason: args.reason, summaryCount: args.summaryCount }),
    actions: args.actions,
    maxSteps: args.maxSteps
  })
}

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
