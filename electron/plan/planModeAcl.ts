import {
  getPlanMeta,
  isPlanExplorationBlocked,
  isSessionPlanExplorationBlocked,
  type PlanMeta
} from '../../src/shared/planTypes'
import { isPlanReadonlyToolName } from '../../src/shared/planToolsFilter'

export const BLOCKED_BY_PLAN_MODE = 'BLOCKED_BY_PLAN_MODE'

export type PlanToolPhaseArg = 'planning' | 'implementation' | null

export function planModeBlockMessage(toolName: string): string {
  return `工具 ${toolName} 在 Plan Mode 探索期不可用。请先完成计划并获得批准。`
}

export function shouldBlockToolInPlanMode(
  toolName: string,
  sessionMetadata: Record<string, unknown> | undefined,
  planToolPhase: PlanToolPhaseArg
): { blocked: boolean; error?: string } {
  if (planToolPhase === 'implementation') {
    return { blocked: false }
  }

  const planMeta = getPlanMeta(sessionMetadata)
  const explorationByPhase = planToolPhase === 'planning'
  const explorationByStatus = isSessionPlanExplorationBlocked(sessionMetadata)

  if (!explorationByPhase && !explorationByStatus) {
    return { blocked: false }
  }

  if (isPlanReadonlyToolName(toolName)) {
    return { blocked: false }
  }

  return {
    blocked: true,
    error: `${BLOCKED_BY_PLAN_MODE}: ${planModeBlockMessage(toolName)}`
  }
}

export function isActivePlanBlockingWrites(planMeta: PlanMeta | undefined): boolean {
  return planMeta ? isPlanExplorationBlocked(planMeta.status) : false
}
