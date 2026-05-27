import type { PlanDisplayEntry, PlanPanelMainState } from '../../../shared/planTypes'
import { derivePlanPanelMainState } from '../../../shared/planTypes'

export { derivePlanPanelMainState }
export type { PlanPanelMainState } from '../../../shared/planTypes'

/** 下半区「引用文件」占比（不含底部飞书状态栏固定行）；上半区 Plan 随状态自动调节 */
export const PLAN_PANEL_HEIGHT_BY_STATE = {
  empty: 0.64,
  plans: 0.45,
  pending_approval: 0.55
} as const

export function planPanelBadgeLabel(state: PlanPanelMainState): string {
  switch (state) {
    case 'pending_approval':
      return '待审批'
    case 'plans':
      return '计划列表'
    default:
      return '无计划'
  }
}

export function buildPlanApprovalImpactText(displayPlans: PlanDisplayEntry[]): string {
  if (displayPlans.length === 0) {
    return '批准后：将新增 1 个计划并等待您确认执行。'
  }
  const executing = displayPlans.filter((p) => p.status === 'executing')
  const completed = displayPlans.filter((p) => p.status === 'completed')
  if (executing.length === 1) {
    const e = executing[0]!
    const step = Math.min(e.currentStepIndex + 1, Math.max(e.stepsTotal, 1))
    return `当前有 1 个执行中计划「${e.title}」（第 ${step}/${e.stepsTotal || '?'} 步）。批准后新计划将列在其下方，不会自动开始执行；旧计划保持执行中直至您取消或完成。`
  }
  if (executing.length > 1) {
    return `当前列表有 ${displayPlans.length} 个计划（含 ${executing.length} 个执行中）。批准后新计划将追加在列表最下方。`
  }
  if (completed.length === 1 && displayPlans.length === 1) {
    return `当前已完成计划「${completed[0]!.title}」将折叠保留在列表底部，新计划显示在上方。`
  }
  if (displayPlans.length === 1) {
    const p = displayPlans[0]!
    return `当前有 1 个计划「${p.title}」（${statusLabel(p.status)}）。批准后新计划将追加在列表最下方。`
  }
  return `当前列表有 ${displayPlans.length} 个计划。批准后新计划将追加在列表最下方。`
}

function statusLabel(status: PlanDisplayEntry['status']): string {
  switch (status) {
    case 'executing':
      return '执行中'
    case 'completed':
      return '已完成'
    case 'cancelled':
      return '已取消'
    case 'approved':
      return '已批准'
    default:
      return status
  }
}

export function hasExecutingDisplayPlan(displayPlans: PlanDisplayEntry[]): boolean {
  return displayPlans.some((p) => p.status === 'executing')
}
