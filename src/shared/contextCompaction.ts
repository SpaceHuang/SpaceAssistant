export type CompactionProjection = { surfaceTokens: number; bodyTokens: number; requiredTokens: number; totalInputBudget: number; bodyBudget: number; targetBodyRatio: number }
export type CompactionActionStatus = 'applied' | 'no-op' | 'uncompressible'
export type CompactionPlanStatus = 'target_reached' | 'fits_without_headroom' | 'exhausted' | 'uncompressible'
export type CompactionRule<A extends string> = { id: string; action: A }
export type CompactionActionResult = { projection: CompactionProjection; status: CompactionActionStatus }
export type CompactionPlanResult = { status: CompactionPlanStatus; projection: CompactionProjection; actions: Array<{ ruleId: string; action: string; status: CompactionActionStatus }> }

export function planCompaction<A extends string>(args: {
  projection: CompactionProjection
  rules: readonly CompactionRule<A>[]
  actions: Record<A, (projection: CompactionProjection) => CompactionActionResult>
  maxSteps: number
}): CompactionPlanResult {
  let projection = args.projection
  const applied: CompactionPlanResult['actions'] = []
  if (projection.requiredTokens > projection.bodyBudget) return { status: 'uncompressible', projection, actions: applied }
  const target = projection.bodyBudget * Math.max(0, projection.targetBodyRatio)
  if (projection.bodyTokens <= target) return { status: 'target_reached', projection, actions: applied }
  for (const rule of args.rules.slice(0, Math.max(0, args.maxSteps))) {
    const result = args.actions[rule.action](projection)
    applied.push({ ruleId: rule.id, action: rule.action, status: result.status })
    if (result.status === 'uncompressible') return { status: 'uncompressible', projection: result.projection, actions: applied }
    if (result.projection.surfaceTokens >= projection.surfaceTokens && result.status !== 'applied') {
      projection = result.projection
      continue
    }
    projection = result.projection
    if (projection.requiredTokens > projection.bodyBudget) return { status: 'uncompressible', projection, actions: applied }
    if (projection.bodyTokens <= projection.bodyBudget * Math.max(0, projection.targetBodyRatio)) return { status: 'target_reached', projection, actions: applied }
  }
  return { status: projection.surfaceTokens <= projection.totalInputBudget ? 'fits_without_headroom' : 'exhausted', projection, actions: applied }
}
