import type { AppDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import {
  beginSessionMessageContentCleanup,
  clearNextSessionMessageContentBatch,
  markSessionMessageContentWriteStopped,
  verifyAndCompleteSessionMessageContentCleanup,
  type SessionMessageContentCleanupBatchResult,
} from '../sessionStorage/maintenance'
import { certifyCanonicalSessionApiRead } from '../sessionStorage/certification'
import {
  evaluateSessionStorageCleanupReleaseGate,
  type SessionStorageCleanupReleaseGateResult,
} from './sessionStorageCleanupReleaseGate'
import {
  readSessionStorageCleanupReleaseGateInput,
  type ReadSessionStorageCleanupReleaseGateInputOptions,
} from './sessionStorageCleanupReleaseConfig'
import {
  getActiveSessionStorageCleanupScope,
  getSessionStorageCleanupScopeAuthorization,
  type SessionStorageCleanupScopeAuthorization,
} from './sessionStorageCleanupAuthorization'

export type SessionStorageCleanupProductionStep =
  | Readonly<{ kind: 'certify' }>
  | Readonly<{ kind: 'write-stop' }>
  | Readonly<{ kind: 'begin' }>
  | Readonly<{ kind: 'batch'; batchSize?: number }>
  | Readonly<{ kind: 'verify-complete' }>

export type SessionStorageCleanupProductionResult =
  | Readonly<{ status: 'blocked'; gate: SessionStorageCleanupReleaseGateResult; scopeReason?: string }>
  | Readonly<{
      status: 'executed'
      gate: SessionStorageCleanupReleaseGateResult
      result: boolean | SessionMessageContentCleanupBatchResult
  }>

export type SessionStorageCleanupProductionBoundary = (
  (db: AppDatabase, sessionId: string, step: SessionStorageCleanupProductionStep) => SessionStorageCleanupProductionResult
) & Readonly<{
  checkGate: () => SessionStorageCleanupReleaseGateResult
  checkAuthorizationScope: (db: AppDatabase, now?: number) => ReturnType<typeof getActiveSessionStorageCleanupScope>
  checkSessionAuthorization: (db: AppDatabase, sessionId: string, now?: number) => SessionStorageCleanupScopeAuthorization
}>

type LoadSessionStorageCleanupReleaseGateInput = () => ReturnType<typeof readSessionStorageCleanupReleaseGateInput>

function runSessionStorageCleanupProductionStep(
  db: AppDatabase,
  sessionId: string,
  loadGateInput: LoadSessionStorageCleanupReleaseGateInput,
  step: SessionStorageCleanupProductionStep,
): SessionStorageCleanupProductionResult {
  const initialGate = evaluateSessionStorageCleanupReleaseGate(loadGateInput())
  if (!initialGate.allowed) return { status: 'blocked', gate: initialGate }
  return runInTransaction(getDbConnection(db), () => {
    const gate = evaluateSessionStorageCleanupReleaseGate(loadGateInput())
    if (!gate.allowed) return { status: 'blocked', gate }
    const authorization = getSessionStorageCleanupScopeAuthorization(db, sessionId)
    if (!authorization.allowed) return { status: 'blocked', gate, scopeReason: authorization.reason }

    switch (step.kind) {
      case 'certify':
        return { status: 'executed', gate, result: certifyCanonicalSessionApiRead(db, sessionId).status === 'eligible' }
      case 'write-stop':
        return { status: 'executed', gate, result: markSessionMessageContentWriteStopped(db, sessionId) }
      case 'begin':
        return { status: 'executed', gate, result: beginSessionMessageContentCleanup(db, sessionId) }
      case 'batch':
        return { status: 'executed', gate, result: clearNextSessionMessageContentBatch(db, sessionId, step.batchSize) }
      case 'verify-complete':
        return { status: 'executed', gate, result: verifyAndCompleteSessionMessageContentCleanup(db, sessionId) }
    }
  })
}

/** 创建唯一生产清理边界；每个破坏性步骤都会重读 bundle release 配置并重新验证 gate。 */
export function createSessionStorageCleanupProductionBoundary(
  releaseConfig: ReadSessionStorageCleanupReleaseGateInputOptions,
): SessionStorageCleanupProductionBoundary {
  const loadGateInput = () => readSessionStorageCleanupReleaseGateInput(releaseConfig)
  const run = ((db: AppDatabase, sessionId: string, step: SessionStorageCleanupProductionStep) => runSessionStorageCleanupProductionStep(
    db,
    sessionId,
    loadGateInput,
    step,
  )) as SessionStorageCleanupProductionBoundary
  return Object.assign(run, {
    checkGate: () => evaluateSessionStorageCleanupReleaseGate(loadGateInput()),
    checkAuthorizationScope: (db: AppDatabase, now?: number) => getActiveSessionStorageCleanupScope(db, now),
    checkSessionAuthorization: (db: AppDatabase, sessionId: string, now?: number) =>
      getSessionStorageCleanupScopeAuthorization(db, sessionId, now),
  })
}
