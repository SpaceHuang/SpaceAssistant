import type { AppDatabase } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import type { SessionCleanupPort, SessionMessageContentCleanupBatch } from '../sessionStorage/host/ports'
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
      result: boolean | SessionMessageContentCleanupBatch
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
  cleanup: SessionCleanupPort,
  sessionId: string,
  loadGateInput: LoadSessionStorageCleanupReleaseGateInput,
  step: SessionStorageCleanupProductionStep,
): SessionStorageCleanupProductionResult {
  const initialGate = evaluateSessionStorageCleanupReleaseGate(loadGateInput())
  if (!initialGate.allowed) return { status: 'blocked', gate: initialGate }
  return runInTransaction(getDbConnection(db), () => {
    const gate = evaluateSessionStorageCleanupReleaseGate(loadGateInput())
    if (!gate.allowed) return { status: 'blocked', gate }
    const authorization = getSessionStorageCleanupScopeAuthorization(db, sessionId, cleanup)
    if (!authorization.allowed) return { status: 'blocked', gate, scopeReason: authorization.reason }

    switch (step.kind) {
      case 'certify':
        return { status: 'executed', gate, result: cleanup.certifyCanonicalRead(sessionId) }
      case 'write-stop':
        return { status: 'executed', gate, result: cleanup.markWriteStopped(sessionId) }
      case 'begin':
        return { status: 'executed', gate, result: cleanup.begin(sessionId) }
      case 'batch':
        return { status: 'executed', gate, result: cleanup.clearNextBatch(sessionId, step.batchSize) }
      case 'verify-complete':
        return { status: 'executed', gate, result: cleanup.verifyAndComplete(sessionId) }
    }
  })
}

/** 创建唯一生产清理边界；每个破坏性步骤都会重读 bundle release 配置并重新验证 gate。 */
export function createSessionStorageCleanupProductionBoundary(
  releaseConfig: ReadSessionStorageCleanupReleaseGateInputOptions,
  cleanupForDatabase: (db: AppDatabase) => SessionCleanupPort,
): SessionStorageCleanupProductionBoundary {
  const loadGateInput = () => readSessionStorageCleanupReleaseGateInput(releaseConfig)
  const run = ((db: AppDatabase, sessionId: string, step: SessionStorageCleanupProductionStep) =>
    runSessionStorageCleanupProductionStep(db, cleanupForDatabase(db), sessionId, loadGateInput, step)) as SessionStorageCleanupProductionBoundary
  return Object.assign(run, {
    checkGate: () => evaluateSessionStorageCleanupReleaseGate(loadGateInput()),
    checkAuthorizationScope: (db: AppDatabase, now?: number) => getActiveSessionStorageCleanupScope(db, now),
    checkSessionAuthorization: (db: AppDatabase, sessionId: string, now?: number) =>
      getSessionStorageCleanupScopeAuthorization(db, sessionId, cleanupForDatabase(db), now),
  })
}
