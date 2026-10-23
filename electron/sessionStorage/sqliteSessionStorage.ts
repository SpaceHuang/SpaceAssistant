import type { AppDatabase } from '../database/sqliteStore'
import { getDbConnection } from '../database/sqliteStore'
import { getSession } from '../database/operations'
import { randomUUID } from 'node:crypto'
import type { SessionStorage, SessionStorageHost, SessionStorageStartupCoordination } from './host/ports'
import { createSessionCommands } from './commands'
import { createSessionQueries } from './queries'
import { createSessionExecutionStore } from './execution'
import { createSessionCommitService } from './application/sessionCommitService'
import { createSessionStorageContextRouter } from './contextPortRegistry'
import { getSessionEventSink, readCompactionReplay, readSessionEvents } from '../sessionEvents'
import type { CompactionReplay } from '../../src/shared/compactionEvents'
import type { CanonicalContextMeterEvent } from './public/model'
import { createStorageSessionContextAdapter } from './contextAdapter'
import { createSqliteSessionRecoveryPort, type SessionRecoveryDependencies } from './recovery'
import { createStorageLifecycleControl } from './lifecycle'
import { createSessionLedgerRecoveryBindings } from './infrastructure/sqlite/sessionLedgerRecoveryBindings'
import { readSessionLedgerAvailability } from './infrastructure/sqlite/sessionLedgerAvailabilityReader'
import { runInTransaction } from '../database/transaction'
import type { MaintenanceState } from './host/ports'
import type { TurnRuntime, TurnRuntimeOptions } from '../turnRuntime'
import { createTurnRuntimeForSessionExecution } from './execution'
import { createSqliteProjectionStateStore } from './infrastructure/sqlite/sessionProjectionStateStore'
import { createSqliteProjectionChatBodyCacheStore } from './infrastructure/sqlite/sessionProjectionStateStore'
import { readProjectionHistoryChunkInWorker } from './infrastructure/sqlite/projectionHistoryChunkWorkerClient'
import { createSessionProjectionBlobStore } from './infrastructure/sqlite/sessionProjectionBlobStore'
import { createProjectionScopeHistoryReducer } from './infrastructure/sqlite/projectionScopeHistoryReducer'
import { createProjectionService } from './application/projectionService'
import { CHAT_BODY_PROJECTION_SPEC_VERSION, projectionScopeKind, projectionScopeSpecVersion } from './domain/scopeKey'
import { createProjectionBuildLifecycleTask } from './host/projectionBuildTask'
import { createEnsureView } from './application/ensureView'
import { readProjectionChatBodyCache, type ProjectionChatBodyMessage } from './application/projectionChatBodyCacheReader'
import { encodeProjectionScopeKey } from './domain/scopeKey'
import type { LifecycleTaskRegistration } from './host/ports'
import type { ProjectionBuildSupervisorOptions } from './application/projectionBuildSupervisor'
export { createSessionLedgerRecoveryBindings } from './infrastructure/sqlite/sessionLedgerRecoveryBindings'

/** Host composition binds the private SQLite TurnStorage to the process TurnRuntime. */
export function createSessionTurnRuntime(storage: SessionStorage, options: Omit<TurnRuntimeOptions, 'storage'>): TurnRuntime {
  return createTurnRuntimeForSessionExecution(storage.execution, options)
}

/** SQLite composition root. Consumers receive bound ports and never receive the database handle. */
export function createSqliteSessionStorage(db: AppDatabase, options: {
  prepareProjection?: NonNullable<SessionStorage['prepareProjection']>
  projectionBlobRoot?: string
  getTurnRuntime?: () => import('../turnRuntime').TurnRuntime
  getWorkDirForSession?: (sessionId: string) => string | undefined
  getUserDataDir?: () => string
  getSessionEventSink?: typeof getSessionEventSink
  readCompactionReplay?: typeof readCompactionReplay
  ensureSessionLedgerReady?: (input: { session: import('../../src/shared/domainTypes').Session; workDir: string }) => Promise<boolean>
  inspectMaintenance?: () => readonly MaintenanceState[]
  recoveryStages?: Partial<Pick<SessionRecoveryDependencies, 'history' | 'snapshots' | 'coordinator' | 'reconcile' | 'continuations' | 'ledgerRepairs'>>
} = {}): SessionStorage {
  const queries = createSessionQueries(db)
  const readCompactionReplayForLocation = async (sessionId: string, workDir: string): Promise<{ replay: CompactionReplay; sink: ReturnType<typeof getSessionEventSink> }> => {
    const session = queries.readSession(sessionId)
    if (!session) throw new Error('SESSION_NOT_FOUND')
    if (options.ensureSessionLedgerReady && !(await options.ensureSessionLedgerReady({ session, workDir }))) throw new Error('SESSION_LEDGER_BLOCKED')
    const sink = (options.getSessionEventSink ?? getSessionEventSink)(workDir, session.id, session.createdAt)
    const fileReplay = await (options.readCompactionReplay ?? readCompactionReplay)(sink.eventsPath)
    const canonicalReplay = queries.readCanonicalCompactionReplay(sessionId)
    if (!canonicalReplay) return { replay: fileReplay, sink }
    const canonicalIds = new Set(canonicalReplay.committed.map(({ compactionId }) => compactionId))
    const rejectedIds = new Set(canonicalReplay.rejected.flatMap(({ compactionId }) => compactionId ? [compactionId] : []))
    const collidesWithRejectedCanonical = fileReplay.committed.some(({ compactionId }) => rejectedIds.has(compactionId))
    const hasLegacyOnlyCompaction = fileReplay.committed.some(({ compactionId }) => !canonicalIds.has(compactionId) && !rejectedIds.has(compactionId))
    if (collidesWithRejectedCanonical) throw new Error('CANONICAL_COMPACTION_REPLAY_INVALID')
    // Keep the file replay as the ordered compatibility source while it contains pre-canonical facts.
    // Once every file fact has a canonical owner, History supplies the replay without a JSONL dependency.
    return { replay: hasLegacyOnlyCompaction ? fileReplay : canonicalReplay, sink }
  }
  const readContextMeterEventsForLocation = async (sessionId: string, workDir: string): Promise<readonly CanonicalContextMeterEvent[]> => {
    const session = queries.readSession(sessionId)
    if (!session) throw new Error('SESSION_NOT_FOUND')
    if (options.ensureSessionLedgerReady && !(await options.ensureSessionLedgerReady({ session, workDir }))) throw new Error('SESSION_LEDGER_BLOCKED')
    const sink = (options.getSessionEventSink ?? getSessionEventSink)(workDir, session.id, session.createdAt)
    const fileEvents = (await readSessionEvents(sink.eventsPath)).filter(({ type }) =>
      type === 'request_header' || type === 'request_context' || type === 'request_usage' || type === 'request_retry')
      .map(({ seq, type, payload }) => ({ seq, type, payload })) as CanonicalContextMeterEvent[]
    const canonicalEvents = queries.readCanonicalContextMeterEvents(sessionId)
    if (!canonicalEvents) return fileEvents
    const identities = new Set(canonicalEvents.map(contextMeterEventIdentity))
    const hasLegacyOnlyFacts = fileEvents.some((event) => !identities.has(contextMeterEventIdentity(event)))
    return hasLegacyOnlyFacts ? fileEvents : canonicalEvents
  }
  const bodyScopeKey = encodeProjectionScopeKey({ scope: 'chatBodyV1', specVersion: CHAT_BODY_PROJECTION_SPEC_VERSION })
  const cacheStore = createSqliteProjectionChatBodyCacheStore(db)
  const cacheBlobs = options.projectionBlobRoot ? createSessionProjectionBlobStore(options.projectionBlobRoot) : undefined
  const ensureView = createEnsureView()
  const ensureChatBodyV1: NonNullable<SessionStorage['ensureChatBodyV1']> = ({ sessionId, signal }) => {
    if (!options.prepareProjection) return Promise.reject(new Error('PROJECTION_PREPARATION_UNAVAILABLE'))
    return ensureView<readonly ProjectionChatBodyMessage[]>({ sessionId, scopeKey: bodyScopeKey, signal,
      read: async () => {
        const result = await readProjectionChatBodyCache({ sessionId, scopeKey: bodyScopeKey, specVersion: CHAT_BODY_PROJECTION_SPEC_VERSION }, cacheStore, cacheBlobs)
        return result.kind === 'ready' ? { ready: true as const, value: result.messages } : { ready: false as const }
      },
      prepare: () => options.prepareProjection!({ sessionId, scopeKey: bodyScopeKey, specVersion: CHAT_BODY_PROJECTION_SPEC_VERSION }) })
  }
  const execution = createSessionExecutionStore(db, queries, options)
  const contexts = createSessionStorageContextRouter(async ({ sessionId, isBusy }) => {
    const session = queries.readSession(sessionId)
    const workDir = options.getWorkDirForSession?.(sessionId)
    const userDataDir = options.getUserDataDir?.()
    if (!session || !workDir || !userDataDir) throw new Error('SESSION_CONTEXT_RESOURCES_UNAVAILABLE')
    const { sink, replay } = await readCompactionReplayForLocation(sessionId, workDir)
    return createStorageSessionContextAdapter({ sessionId, session, queries, workDir, userDataDir, replay, sink, isBusy,
      commitCanonicalCompaction: async ({ operationId, compactionId, output, historyPayload }) => {
        const invocationId = operationId
        const turnId = operationId
        const messages = output.items.map(({ replayIdentity, message }) => ({ ...message,
          id: 'id' in message && typeof message.id === 'string' ? message.id : replayIdentity }))
        const eventId = `${operationId}:transcript-compacted`
        const completedEventId = `${operationId}:completed`
        const rawStart = historyPayload.start as Record<string, unknown> | undefined
        const rawSummary = historyPayload.summary as Record<string, unknown> | undefined
        if (!rawStart || !rawSummary) throw new Error('SESSION_CONTEXT_TRANSACTION_REQUIRED')
        const canonicalize = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalize)
          : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)])) : value
        const summaryCandidate = rawSummary.candidate
        let summaryHash = 2166136261
        const summaryText = JSON.stringify(canonicalize(summaryCandidate)) ?? 'null'
        for (let index = 0; index < summaryText.length; index += 1) summaryHash = Math.imul(summaryHash ^ summaryText.charCodeAt(index), 16777619)
        if (rawSummary.summaryHash !== (summaryHash >>> 0).toString(16).padStart(8, '0')) throw new Error('SESSION_CONTEXT_SUMMARY_HASH_MISMATCH')
        const sessionLedger = {
          location: { workDir, sessionId: session.id, createdAt: session.createdAt },
          start: rawStart, summary: rawSummary
        }
        const eventPayload = { compactionId, messages, sessionLedger, surfaceReplay: {
          windowId: historyPayload.windowId,
          inputFingerprint: historyPayload.inputSurfaceFingerprint,
          outputFingerprint: historyPayload.outputSurfaceFingerprint,
          checkpointReplayIdentity: (historyPayload.candidate as { checkpointReplayIdentity?: unknown } | undefined)?.checkpointReplayIdentity
        } }
        const events = [
          { invocationId, turnId, sequence: 1, schemaVersion: 1, eventId, idempotencyKey: eventId,
            kind: 'transcript-compacted' as const, payload: eventPayload },
          { invocationId, turnId, sequence: 2, schemaVersion: 1, eventId: completedEventId, idempotencyKey: completedEventId,
            kind: 'invocation-completed' as const, payload: { status: 'completed', completedAt: Date.now() } }
        ]
        const history = execution.historyFor({ sessionId: session.id })
        const stored = await history.read(invocationId)
        if (stored.version === 0) {
          const commit = createSessionCommitService({ sessionId: session.id, invocationId, turnId, history })
          await commit.commitHistory(events, 0)
        } else {
          const compacted = stored.events.find(({ kind }) => kind === 'transcript-compacted')
          const completed = stored.events.find(({ kind }) => kind === 'invocation-completed')
          const samePayload = compacted && JSON.stringify(canonicalize(compacted.payload)) === JSON.stringify(canonicalize(eventPayload))
          const matchingCompletion = completed?.payload && typeof completed.payload === 'object' &&
            (completed.payload as { status?: unknown }).status === 'completed'
          if (!samePayload || !matchingCompletion || stored.version !== 2 || stored.events[0]?.eventId !== eventId || stored.events[1]?.eventId !== completedEventId) {
            throw new Error('SESSION_CONTEXT_COMPACTION_IDEMPOTENCY_CONFLICT')
          }
        }
      } })
  })
  const recovery = createSqliteSessionRecoveryPort({ db, queries, execution, getTurnRuntime: options.getTurnRuntime, stages: options.recoveryStages })
  const availability = Object.freeze({
    inspect: (sessionId: string) => runInTransaction(getDbConnection(db), () => {
      const session = queries.readSession(sessionId)
      const recoveryStatus = recovery.inspectRecoveryStatus()
      const globalFence = Object.freeze({ state: recoveryStatus.state, source: Object.freeze({ recoveryState: recoveryStatus.state }) })
      const maintenanceTasks = (options.inspectMaintenance?.() ?? []).map(({ taskId, category, status }) => ({ taskId, category, status }))
      const maintenanceState = maintenanceTasks.some(({ status }) => status === 'failed') ? 'blocked' as const
        : maintenanceTasks.some(({ status }) => status === 'paused') ? 'paused' as const : 'available' as const
      const maintenanceSource = Object.freeze(maintenanceTasks.map(({ taskId, status }) => Object.freeze({ taskId, status })))
      if (!session) return Object.freeze({
        globalFence,
        content: Object.freeze({ state: 'unavailable' as const, reason: 'session-missing' as const,
          source: Object.freeze({ sessionGeneration: '', messageRevision: 0, authority: 'unknown' }) }),
        execution: Object.freeze({ state: 'blocked' as const, source: Object.freeze({ sessionId, transcriptVersion: 0 }) }),
        ledger: Object.freeze({ state: 'unknown', reason: 'readiness-missing' as const, source: Object.freeze({ sessionId }) }),
        maintenance: Object.freeze({ state: maintenanceState, tasks: Object.freeze(maintenanceTasks), source: maintenanceSource })
      })
      const conn = getDbConnection(db)
      const cutover = conn.prepare('SELECT session_generation,message_revision,api_read_mode,write_mode FROM session_message_content_cutover WHERE session_id=?')
        .get(sessionId) as { session_generation: string; message_revision: number; api_read_mode: string; write_mode: string } | undefined
      let contentReadable = true
      try { queries.readApiBaseline({ sessionId, limit: 1 }) }
      catch (error) {
        if (error instanceof Error && error.message === 'CANONICAL_SESSION_CONTENT_UNAVAILABLE') contentReadable = false
        else throw error
      }
      const transcript = execution.readTranscriptState(sessionId)
      let executionState: 'ready' | 'busy' | 'pending-recovery' | 'commit-uncertain' | 'blocked'
      if (recoveryStatus.state === 'pending' || recoveryStatus.state === 'blocked' || recovery.inspectReadiness(sessionId).reason === 'recovery-pending') executionState = 'pending-recovery'
      else if (transcript.status === 'commit_uncertain') executionState = 'commit-uncertain'
      else if (transcript.status === 'blocked') executionState = 'blocked'
      else if (execution.hasActiveTurn(sessionId)) executionState = 'busy'
      else executionState = 'ready'
      const workDir = options.getWorkDirForSession?.(sessionId)
      let ledger: { state: 'uninitialized' | 'initializing' | 'unknown' | 'checking' | 'ready' | 'dirty' | 'blocked'; reason?: 'location-unavailable' | 'readiness-missing'; source: { sessionId: string; locationKey?: string; ledgerGeneration?: number; canonicalWatermark?: string | null; failureClass?: string | null } }
      if (!workDir) ledger = { state: 'unknown', reason: 'location-unavailable', source: { sessionId } }
      else {
        const location = { workDir, sessionId, createdAt: session.createdAt }
        const readiness = readSessionLedgerAvailability(conn, location)
        ledger = { state: readiness.state, ...(readiness.reason ? { reason: readiness.reason } : {}), source: { sessionId, locationKey: readiness.locationKey,
          ...(readiness.ledgerGeneration !== undefined ? { ledgerGeneration: readiness.ledgerGeneration } : {}),
          ...(readiness.canonicalWatermark !== undefined ? { canonicalWatermark: readiness.canonicalWatermark } : {}),
          ...(readiness.failureClass !== undefined ? { failureClass: readiness.failureClass } : {}) } }
      }
      return Object.freeze({
        globalFence,
        content: Object.freeze({ state: contentReadable ? 'readable' as const : 'unavailable' as const,
          ...(!contentReadable ? { reason: 'content-unavailable' as const } : {}),
          source: Object.freeze({ sessionGeneration: session.generation, messageRevision: cutover?.message_revision ?? 0,
            authority: `${cutover?.api_read_mode ?? 'legacy'}:${cutover?.write_mode ?? 'legacy'}` }) }),
        execution: Object.freeze({ state: executionState, source: Object.freeze({ sessionId, transcriptVersion: transcript.version,
          ...(transcript.lastTurnId ? { lastTurnId: transcript.lastTurnId } : {}) }) }),
        ledger: Object.freeze({ ...ledger, source: Object.freeze(ledger.source) }),
        maintenance: Object.freeze({ state: maintenanceState, tasks: Object.freeze(maintenanceTasks.map((task) => Object.freeze(task))), source: maintenanceSource })
      })
    })
  })
  const ensureLedgerReady = async (sessionId: string): Promise<boolean> => {
    const session = queries.readSession(sessionId)
    const workDir = options.getWorkDirForSession?.(sessionId)
    return session && workDir && options.ensureSessionLedgerReady
      ? options.ensureSessionLedgerReady({ session, workDir })
      : !options.ensureSessionLedgerReady
  }
  const readCompactionReplayForSession = async (input: Readonly<{ sessionId: string; workDir: string }>): Promise<CompactionReplay> =>
    (await readCompactionReplayForLocation(input.sessionId, input.workDir)).replay
  const readContextMeterEventsForSession = async (input: Readonly<{ sessionId: string; workDir: string }>): Promise<readonly CanonicalContextMeterEvent[]> =>
    readContextMeterEventsForLocation(input.sessionId, input.workDir)
  return Object.freeze({ queries, commands: createSessionCommands(db), execution, contexts, recovery, availability, ensureLedgerReady,
    readCompactionReplay: readCompactionReplayForSession,
    readContextMeterEvents: readContextMeterEventsForSession,
    ...(options.prepareProjection ? { ensureChatBodyV1 } : {}),
    ...(options.prepareProjection ? { prepareProjection: options.prepareProjection } : {}) })
}

function contextMeterEventIdentity(event: CanonicalContextMeterEvent): string {
  const requestId = String(event.payload.requestId ?? '')
  if (event.type === 'request_context') return `${event.type}:${requestId}:${String(event.payload.attempt ?? '')}:${event.payload.projectionStage === 'final' ? 'final' : 'request'}`
  if (event.type === 'request_header' || event.type === 'request_retry') return `${event.type}:${requestId}:${String(event.payload.attempt ?? '')}`
  return `${event.type}:${requestId}`
}

/** Host composition additionally binds existing startup recovery owners without exposing them to business consumers. */
export function createSqliteSessionStorageHost(db: AppDatabase, input: {
  storage: NonNullable<Parameters<typeof createSqliteSessionStorage>[1]>
  startup: SessionStorageStartupCoordination
  ledgerRecovery?: ReturnType<typeof createSessionLedgerRecoveryBindings>
  maintenanceTasks?: Parameters<typeof createStorageLifecycleControl>[0]['tasks']
  quiesceMaintenance?: Parameters<typeof createStorageLifecycleControl>[0]['quiesce']
}): SessionStorageHost {
  const lifecycle = createStorageLifecycleControl({ tasks: input.maintenanceTasks ?? [], quiesce: input.quiesceMaintenance })
  const storage = createSqliteSessionStorage(db, {
    ...input.storage,
    inspectMaintenance: () => lifecycle.inspectMaintenance(),
    prepareProjection: (request) => lifecycle.prepareProjection(request),
    recoveryStages: {
      ...input.storage.recoveryStages,
      history: input.startup.recoverHistory,
      ledgerRepairs: async () => (await input.startup.recoverSessionLedgers()).repairFailureCount
    }
  })
  const hostStorage: SessionStorage = Object.freeze({ ...storage,
    prepareProjection: (request: Parameters<NonNullable<SessionStorage['prepareProjection']>>[0]) => lifecycle.prepareProjection(request) })
  return Object.freeze({ storage: hostStorage, startup: input.startup, ledgerRecovery: input.ledgerRecovery ?? createSessionLedgerRecoveryBindings(), lifecycle })
}

/** Production composition for durable projection recovery; consumers register it with the host lifecycle. */
export function createSqliteProjectionBuildTask(input: Readonly<{
  db: AppDatabase
  dbPath: string
  blobRoot: string
  processGeneration(): number
  connectionEpoch(): number
  now(): number
  limits?: ProjectionBuildSupervisorOptions['limits']
  maxChunksPerSlice?: number
  onResult?: ProjectionBuildSupervisorOptions['onResult']
  onFailure?: ProjectionBuildSupervisorOptions['onFailure']
}>): LifecycleTaskRegistration {
  const stateStore = createSqliteProjectionStateStore(input.db)
  const service = createProjectionService(stateStore, { processGeneration: input.processGeneration,
    connectionEpoch: input.connectionEpoch, createToken: randomUUID, now: input.now })
  return createProjectionBuildLifecycleTask({ service,
    listDueWork: () => stateStore.listDueWork(input.now(), 64, input.processGeneration()), dbPath: input.dbPath,
    nextRetryAt: () => stateStore.nextRetryAt(input.now()),
    resolveWorkItem: ({ sessionId, scopeKey, specVersion }) => {
      if (projectionScopeKind(scopeKey) !== 'chatBodyV1' || projectionScopeSpecVersion(scopeKey) !== specVersion) return undefined
      const session = getSession(input.db, sessionId)
      if (!session) return undefined
      let current = stateStore.get(sessionId, scopeKey)
      const sourceIdentityJson = stateStore.readSourceIdentity(sessionId, session.generation)
      if (current?.status === 'valid' && current.sessionGeneration === session.generation && current.sourceIdentityJson === sourceIdentityJson) {
        const cache = getDbConnection(input.db).prepare(`SELECT payload_generation,payload_digest,validated_range_json,source_identity_json
          FROM session_projection_cache WHERE session_id=? AND scope_key=?`).get(sessionId, scopeKey) as
          { payload_generation: string; payload_digest: string; validated_range_json: string; source_identity_json: string } | undefined
        if (cache && cache.payload_generation === current.payloadGeneration && cache.payload_digest === current.payloadDigest &&
          cache.validated_range_json === current.validatedRangeJson && cache.source_identity_json === current.sourceIdentityJson) return undefined
        stateStore.invalidateInTransaction({ sessionId, scopeKey, sessionGeneration: session.generation, now: input.now() })
        current = stateStore.get(sessionId, scopeKey)
      }
      if (current?.status === 'valid' && current.sessionGeneration === session.generation) {
        stateStore.invalidateInTransaction({ sessionId, scopeKey, sessionGeneration: session.generation, now: input.now() })
        current = stateStore.get(sessionId, scopeKey)
      }
      stateStore.ensureInvalid({ sessionId, scopeKey, sessionGeneration: session.generation, now: input.now() })
      return { sessionId, sessionGeneration: session.generation, scopeKey, specVersion }
    },
    readChunk: readProjectionHistoryChunkInWorker, historyReducer: createProjectionScopeHistoryReducer(),
    blobs: createSessionProjectionBlobStore(input.blobRoot), limits: input.limits ?? { maxRows: 200, maxBytes: 256 * 1024 },
    maxChunksPerSlice: input.maxChunksPerSlice ?? 4, now: input.now, onResult: input.onResult, onFailure: input.onFailure })
}
