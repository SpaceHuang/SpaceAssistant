import type { AppDatabase } from '../database'
import { getSession } from '../database'
import type { PlanConfig } from '../../src/shared/domainTypes'
import type { PlanExecutionMeta, PlanExecutionRunState } from '../../src/shared/planTypes'
import {
  SESSION_META_PLAN_EXECUTION,
  getPlanExecutionMeta,
  normalizePlanExecutionMeta
} from '../../src/shared/planTypes'
import { mergePlanMetadata, saveSessionMetadata } from './planManager'

const pauseRequests = new Set<string>()

export function requestPlanPause(sessionId: string): void {
  pauseRequests.add(sessionId)
}

export function clearPlanPauseRequest(sessionId: string): void {
  pauseRequests.delete(sessionId)
}

export function isPlanPauseRequested(sessionId: string): boolean {
  return pauseRequests.has(sessionId)
}

export function createPlanExecutionSnapshot(planConfig: PlanConfig): PlanExecutionMeta {
  return {
    runState: 'idle',
    executionMode: planConfig.executionMode,
    toolConfirmPolicy: planConfig.toolConfirmPolicy,
    startedAt: null,
    pausedAt: null,
    activeRunRequestId: null
  }
}

export function updatePlanExecutionMeta(
  db: AppDatabase,
  sessionId: string,
  patch: Partial<PlanExecutionMeta>
): PlanExecutionMeta | undefined {
  const session = getSession(db, sessionId)
  if (!session) return undefined
  const current = getPlanExecutionMeta(session.metadata) ?? {
    runState: 'idle' as const,
    executionMode: 'auto' as const,
    toolConfirmPolicy: 'confirm_high_risk' as const,
    startedAt: null,
    pausedAt: null
  }
  const next: PlanExecutionMeta = { ...current, ...patch }
  const metadata = mergePlanMetadata(session.metadata, { plan_execution: next })
  saveSessionMetadata(db, sessionId, metadata)
  return next
}

export function markPlanRunState(
  db: AppDatabase,
  sessionId: string,
  runState: PlanExecutionRunState,
  extra?: Partial<PlanExecutionMeta>
): void {
  updatePlanExecutionMeta(db, sessionId, {
    runState,
    ...extra,
    ...(runState.startsWith('paused') ? { pausedAt: Date.now() } : {}),
    ...(runState === 'running' ? { pausedAt: null, pauseReason: undefined } : {})
  })
}

export function readPlanExecutionMetaFromDb(
  db: AppDatabase,
  sessionId: string
): PlanExecutionMeta | undefined {
  const session = getSession(db, sessionId)
  if (!session) return undefined
  return getPlanExecutionMeta(session.metadata)
}

/** mergePlanMetadata 需支持 plan_execution */
export function patchPlanExecutionInMetadata(
  metadata: Record<string, unknown>,
  exec: PlanExecutionMeta | null
): Record<string, unknown> {
  return mergePlanMetadata(metadata, { plan_execution: exec })
}
