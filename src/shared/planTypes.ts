/** Plan 模式迁移：会话 metadata 键常量与 strip 辅助（Plan 子系统已移除） */

export const SESSION_META_PLAN = 'plan'
export const SESSION_META_PENDING_PLAN = 'pending_plan'
export const SESSION_META_DISPLAY_PLANS = 'display_plans'
export const SESSION_META_PLAN_DRAFTING = 'plan_drafting'
export const SESSION_META_PLAN_VERSIONS = 'plan_versions'
export const SESSION_META_PLAN_ABORT = 'plan_abort'
export const SESSION_META_PLAN_ABORT_DISMISSED = 'plan_abort_dismissed'
export const SESSION_META_PLAN_STEP_RESULTS = 'plan_step_results'
export const SESSION_META_PLAN_EXECUTION = 'plan_execution'

/** 会话 metadata 中所有 Plan 相关键（供 strip 与迁移使用） */
export const SESSION_PLAN_METADATA_KEYS = [
  SESSION_META_PLAN,
  SESSION_META_PENDING_PLAN,
  SESSION_META_DISPLAY_PLANS,
  SESSION_META_PLAN_DRAFTING,
  SESSION_META_PLAN_VERSIONS,
  SESSION_META_PLAN_ABORT,
  SESSION_META_PLAN_ABORT_DISMISSED,
  SESSION_META_PLAN_STEP_RESULTS,
  SESSION_META_PLAN_EXECUTION
] as const

export function hasPlanMetadataKeys(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata) return false
  return SESSION_PLAN_METADATA_KEYS.some((key) => key in metadata)
}

/** 从会话 metadata 移除 Plan 键；幂等 */
export function stripPlanFieldsFromSessionMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!metadata || !hasPlanMetadataKeys(metadata)) {
    return metadata ? { ...metadata } : {}
  }
  const next = { ...metadata }
  for (const key of SESSION_PLAN_METADATA_KEYS) {
    delete next[key]
  }
  return next
}
