import type { AppDatabase } from '../../../database/sqliteStore'
import { getDbConnection } from '../../../database/sqliteStore'
import { getSession } from '../../../database/operations'
import { SqliteAgentHistory } from '../../../runtime/sqliteAgentHistory'
import { ensureCompactionTransaction, ensureFinalRequestContextEvent, ensureRequestProjectionEvents, ensureRequestRetryEvent,
  ensureRequestUsageEvent, ensureToolCallEvent, ensureToolResultEvent, ensureTurnEndEvent, ensureTurnStartEvent,
  getSessionEventSink, reconcileInterruptedSessionEventLedger } from '../../../sessionEvents'
import type { SessionHistoryLedgerLocation, SessionHistoryRecoveryOptions } from '../../public/ports'
import type { SessionLedgerRecoveryBindings } from '../../host/ports'

/** Startup-only History operations; the SQLite adapter instance and connection remain private. */
export function createSqliteStartupHistoryRecoveryBindings(
  db: AppDatabase,
  spillStore?: ConstructorParameters<typeof SqliteAgentHistory>[4]
) {
  const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, undefined, spillStore)
  return Object.freeze({
    classifyLegacyProjectionRepairs: (batchSize = 100) => history.classifyLegacyProjectionRepairs(batchSize),
    getStartupRecoveryWorkSummary: () => history.getStartupRecoveryWorkSummary(),
    recoverInterruptedInvocations: (options?: SessionHistoryRecoveryOptions) =>
      history.recoverInterruptedInvocations(options),
    recoverInterruptedInvocationsWithLedger: async (input: Readonly<{
      ledgerRecovery: SessionLedgerRecoveryBindings
      allowedRoots: readonly string[]
      configuredWorkDir: string
      activeProfileId?: string
      profilesJson?: string
      ensureSessionLedgerReady(input: { location: SessionHistoryLedgerLocation; sessionGeneration: string }): Promise<boolean>
      onLocationResolveError?(error: unknown, invocationId: string, sessionId: string): void
      onRepairFailure?(kind: string, error: unknown, invocationId?: string, sessionId?: string): void
    }>) => {
      let repairFailureCount = 0
      const sessionFailures: Array<{ sessionId: string; invocationId: string; capability: 'execution' | 'ledger'; failureClass: 'history-stream-corrupt' | 'ledger-repair-failed' | 'ledger-repair-pending' }> = []
      const recordSessionFailure = (sessionId: string | null, invocationId: string, capability: 'execution' | 'ledger', failureClass: 'history-stream-corrupt' | 'ledger-repair-failed' | 'ledger-repair-pending') => {
        if (sessionId) sessionFailures.push({ sessionId, invocationId, capability, failureClass })
      }
      const sessionIdForInvocation = (invocationId: string) =>
        (getDbConnection(db).prepare('SELECT session_id FROM agent_history_streams WHERE invocation_id=?').get(invocationId) as { session_id: string | null } | undefined)?.session_id ?? null
      const withAcceptedSessionLedger = async <T>(location: SessionHistoryLedgerLocation, operation: () => Promise<T>): Promise<T> => {
        if (!input.ledgerRecovery.isLocationAllowed({ location, allowedRoots: input.allowedRoots })) {
          throw new Error('canonical session ledger location does not match a configured workspace root')
        }
        const session = getSession(db, location.sessionId)
        if (!session) throw new Error('SESSION_LEDGER_SESSION_MISSING')
        if (!(await input.ensureSessionLedgerReady({ location, sessionGeneration: session.generation }))) {
          throw new Error('session ledger repair deferred because readiness is unavailable')
        }
        return operation()
      }
      const recordInvocationRepairFailure = (kind: string, error: unknown, invocationId: string) => {
        repairFailureCount += 1
        const sessionId = sessionIdForInvocation(invocationId)
        recordSessionFailure(sessionId, invocationId, 'ledger', 'ledger-repair-failed')
        input.onRepairFailure?.(kind, error, invocationId, sessionId ?? undefined)
      }
      const resolveSessionLedgerLocation = (sessionId: string): SessionHistoryLedgerLocation | undefined => {
        const session = getSession(db, sessionId)
        if (!session) return undefined
        const location = input.ledgerRecovery.resolveLocation({ sessionId, createdAt: session.createdAt,
          workDirProfileId: session.workDirProfileId, activeProfileId: input.activeProfileId,
          configuredWorkDir: input.configuredWorkDir, profilesJson: input.profilesJson })
        return location && input.ledgerRecovery.isLocationAllowed({ location, allowedRoots: input.allowedRoots }) ? location : undefined
      }
      const repair = async (location: SessionHistoryLedgerLocation, operation: (sink: ReturnType<typeof getSessionEventSink>) => Promise<unknown>) =>
        withAcceptedSessionLedger(location, async () => {
          const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
          try { await operation(sink) }
          finally { await sink.close() }
        })
      const interrupted = await history.recoverInterruptedInvocations({
        onSessionRecoveryFailure: (error, invocationId, sessionId) => {
          repairFailureCount += 1
          recordSessionFailure(sessionId, invocationId, 'execution', 'history-stream-corrupt')
        },
        resolveSessionLedgerLocation,
        onSessionLocationResolveError: (error, invocationId, sessionId) => {
          repairFailureCount += 1
          recordSessionFailure(sessionId, invocationId, 'ledger', 'ledger-repair-failed')
          input.onLocationResolveError?.(error, invocationId, sessionId)
        },
        repairCompaction: (location, start, summary) => repair(location, (sink) => ensureCompactionTransaction(sink, start, summary)),
        repairToolLedger: (location, result) => repair(location, (sink) => ensureToolResultEvent(sink,
          input.ledgerRecovery.toToolResultProjection(result as unknown as Parameters<SessionLedgerRecoveryBindings['toToolResultProjection']>[0]))),
        repairToolCallLedger: (location, toolCall) => repair(location, (sink) => ensureToolCallEvent(sink,
          input.ledgerRecovery.toToolCallProjection(toolCall as unknown as Parameters<SessionLedgerRecoveryBindings['toToolCallProjection']>[0]))),
        repairModelRequestLedger: (location, projection) => repair(location, (sink) => ensureRequestProjectionEvents(sink, projection)),
        repairProviderRetryLedger: (location, retry) => repair(location, (sink) => ensureRequestRetryEvent(sink, retry)),
        repairUsageLedger: (location, requestUsage) => repair(location, (sink) => ensureRequestUsageEvent(sink, requestUsage)),
        repairFinalRequestContextLedger: (location, requestContext) => repair(location, (sink) => ensureFinalRequestContextEvent(sink, requestContext)),
        repairInvocationTerminal: (location, terminal) => withAcceptedSessionLedger(location, async () => {
          const sink = getSessionEventSink(location.workDir, location.sessionId, location.createdAt)
          try {
            await ensureTurnStartEvent(sink, String(terminal.turnId))
            await ensureTurnEndEvent(sink, String(terminal.turnId), String(terminal.reason))
          } finally { await sink.close() }
          if (typeof terminal.canonicalTerminalEventId === 'string') await reconcileInterruptedSessionEventLedger({
            ...location, turnId: String(terminal.turnId), canonicalTerminalEventId: terminal.canonicalTerminalEventId,
            toolUseIds: Array.isArray(terminal.toolUseIds) ? terminal.toolUseIds.filter((value): value is string => typeof value === 'string') : []
          })
        }),
        onCompactionRepairError: (error, invocationId) => recordInvocationRepairFailure('compaction', error, invocationId),
        onToolLedgerRepairError: (error, invocationId) => recordInvocationRepairFailure('tool-ledger', error, invocationId),
        onModelRequestLedgerRepairError: (error, invocationId) => recordInvocationRepairFailure('model-request', error, invocationId),
        onProviderRetryLedgerRepairError: (error, invocationId) => recordInvocationRepairFailure('provider-retry', error, invocationId),
        onUsageLedgerRepairError: (error, invocationId) => recordInvocationRepairFailure('usage', error, invocationId),
        onFinalRequestContextLedgerRepairError: (error, invocationId) => recordInvocationRepairFailure('final-request-context', error, invocationId),
        onInvocationTerminalRepairError: (error, invocationId) => recordInvocationRepairFailure('invocation-terminal', error, invocationId)
      })
      const pendingRepairRows = getDbConnection(db).prepare(`SELECT repairs.session_id,repairs.invocation_id
        FROM canonical_projection_repairs repairs
        LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=repairs.session_id
        WHERE repairs.status='pending' AND repairs.terminal_failed=0 AND (cutover.cleanup_state IS NULL OR
          cutover.cleanup_state NOT IN ('write-stopped','pending','complete'))`).all() as Array<{ session_id: string | null; invocation_id: string }>
      const pendingRepairCount = pendingRepairRows.length
      for (const row of pendingRepairRows) {
        if (row.session_id) recordSessionFailure(row.session_id, row.invocation_id, 'ledger', 'ledger-repair-pending')
      }
      return Object.freeze({ interrupted, interruptedCount: interrupted.length, pendingRepairCount,
        repairFailureCount, sessionFailures: Object.freeze(sessionFailures) })
    }
  })
}
