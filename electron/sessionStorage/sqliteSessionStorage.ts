import type { AppDatabase } from '../database/sqliteStore'
import { getDbConnection } from '../database/sqliteStore'
import { getSession } from '../database/operations'
import { createSpillStoreForDatabase } from '../storage/spillStore'
import { collectSpillDescriptorsStrict, type SpillDescriptor } from '../storage/spillProtocol'
import { randomUUID } from 'node:crypto'
import type { SessionStorage, SessionStorageHost, SessionStorageStartupCoordination } from './host/ports'
import { createSessionCommands } from './commands'
import { createSessionQueries } from './queries'
import { createSessionExecutionStore } from './execution'
import { createSessionCommitService } from './application/sessionCommitService'
import { createSessionStorageContextRouter } from './contextPortRegistry'
import { getSessionEventSink, readCompactionReplay, readSessionEvents } from '../sessionEvents'
import type { CompactionReplay } from '../../src/shared/compactionEvents'
import type { CanonicalContextMeterEvent, PreparedChatBodyView } from './public/model'
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
import { readProjectionSourceIdentity } from './infrastructure/sqlite/projectionSourceIdentity'
import { readProjectionPageSourceSpills } from './infrastructure/sqlite/projectionSourceDependencyReader'
import { readProjectionHistoryChunkInWorker } from './infrastructure/sqlite/projectionHistoryChunkWorkerClient'
import { reduceProjectionHistoryChunkInWorker } from './infrastructure/sqlite/projectionHistoryReducerWorkerClient'
import { materializeProjectionFinalViewInWorker } from './infrastructure/sqlite/projectionFinalViewWorkerClient'
import { createSessionProjectionBlobStore } from './infrastructure/sqlite/sessionProjectionBlobStore'
import { buildSessionProjectionMigrationInventory } from './infrastructure/sqlite/sessionProjectionMigrationInventory'
import { cancelSessionProjectionMigration, getSessionProjectionMigrationRun, pauseSessionProjectionMigration,
  resumeSessionProjectionMigration, runSessionProjectionMigrationBatch, startSessionProjectionMigration } from './infrastructure/sqlite/sessionProjectionMigration'
import { createSqliteSessionCleanupPort } from './maintenance'
import { createSessionLedgerCompactionDependencyGuard, createCanonicalSessionProjectionRetentionPreparer } from './infrastructure/sqlite/sessionEventRetentionAdapter'
import { clearSessionProjectionCaches } from './infrastructure/sqlite/sessionProjectionCacheMaintenance'
import { createProjectionScopeHistoryReducer } from './infrastructure/sqlite/projectionScopeHistoryReducer'
import { createProjectionService } from './application/projectionService'
import { createSessionBodySourceBackfillTask } from './infrastructure/sqlite/sessionBodySourceBackfillTask'
import { checkpointSessionTranscriptProjection, startSessionProjectionRevalidationDrain } from './infrastructure/sqlite/sessionProjectionRevalidation'
import { CHAT_BODY_PROJECTION_SPEC_VERSION, projectionScopeKind, projectionScopeSpecVersion } from './domain/scopeKey'
import { createProjectionBuildLifecycleTask } from './host/projectionBuildTask'
import { createEnsureView } from './application/ensureView'
import { invalidatePreparedChatBodyView, preparedChatBodyViewFromSnapshot, readProjectionChatBodyCacheManifest } from './application/projectionChatBodyCacheReader'
import { encodeProjectionScopeKey } from './domain/scopeKey'
import type { LifecycleTaskRegistration } from './host/ports'
import type { ProjectionBuildSupervisorOptions } from './application/projectionBuildSupervisor'
import { readPreparedChatBodiesInWorker, searchPreparedChatBodiesInWorker } from './infrastructure/sqlite/projectionChatBodyCacheWorkerClient'
import { readProjectionSourceChatBodiesInWorker } from './infrastructure/sqlite/projectionSourceChatBodyWorkerClient'
import { readLegacyProjectionMessages } from './infrastructure/sqlite/sessionLegacyQueryAdapter'
import { buildToolChatMessagesFromSource } from '../chatMessageBuild'
import { applyCommittedSurfaceShadow, computeReplaySurfaceFingerprint, projectReplaySurfaceWithSources, surfaceItemIdentitiesForProjectionSubset } from '../../src/shared/surfaceReplay'

export { createSessionBodySourceBackfillTask }
import { createSqliteStartupHistoryRecoveryBindings } from './infrastructure/sqlite/sessionHistoryRecoveryHost'
import { createProjectionBlobGcTask } from './infrastructure/sqlite/projectionBlobGcTask'
export { createSessionLedgerRecoveryBindings } from './infrastructure/sqlite/sessionLedgerRecoveryBindings'
export { createSqliteStartupHistoryRecoveryBindings }
export { startSessionProjectionRevalidationDrain }

function hasCurrentPriorChatBodyAuthority(conn: ReturnType<typeof getDbConnection>, sessionId: string): boolean {
  const session = conn.prepare('SELECT generation FROM sessions WHERE id=?').get(sessionId) as { generation: string } | undefined
  if (!session) return false
  const cutover = conn.prepare('SELECT write_mode FROM session_message_content_cutover WHERE session_id=?')
    .get(sessionId) as { write_mode: string } | undefined
  if (!cutover || !['legacy', 'canonical'].includes(cutover.write_mode)) return false
  const sourceIdentityJson = readProjectionSourceIdentity(conn, sessionId, session.generation)
  if (!sourceIdentityJson) return false
  const parityScopeKey = encodeProjectionScopeKey({ scope: 'transcriptParityV1', specVersion: 1 })
  const proof = conn.prepare(`SELECT status,source_identity_json FROM session_projection_state WHERE session_id=? AND scope_key=?`)
    .get(sessionId, parityScopeKey) as { status: string; source_identity_json: string | null } | undefined
  return proof?.status === 'valid' && proof.source_identity_json === sourceIdentityJson
}

/** Host composition binds the private SQLite TurnStorage to the process TurnRuntime. */
export function createSessionTurnRuntime(storage: SessionStorage, options: Omit<TurnRuntimeOptions, 'storage'>): TurnRuntime {
  return createTurnRuntimeForSessionExecution(storage.execution, options)
}

/** SQLite composition root. Consumers receive bound ports and never receive the database handle. */
export function createSqliteSessionStorage(db: AppDatabase, options: {
  prepareProjection?: NonNullable<SessionStorage['prepareProjection']>
  requestBodySourceBackfill?: () => boolean | void
  sourceBackfillWaitMs?: number
  projectionBlobRoot?: string
  getTurnRuntime?: () => import('../turnRuntime').TurnRuntime
  getWorkDirForSession?: (sessionId: string) => string | undefined
  getUserDataDir?: () => string
  getSessionEventSink?: typeof getSessionEventSink
  readCompactionReplay?: typeof readCompactionReplay
  ensureSessionLedgerReady?: (input: { session: import('../../src/shared/domainTypes').Session; workDir: string; retryBlocked?: boolean }) => Promise<boolean>
  inspectMaintenance?: () => readonly MaintenanceState[]
  recoveryStages?: Partial<Pick<SessionRecoveryDependencies, 'history' | 'snapshots' | 'coordinator' | 'reconcile' | 'continuations' | 'ledgerRepairs'>>
} = {}): SessionStorage {
  const readCompactionReplayForLocation = async (sessionId: string, workDir: string): Promise<{
    replay: CompactionReplay; sink?: ReturnType<typeof getSessionEventSink>; canPersist: boolean
  }> => {
    const session = queries.readSession(sessionId)
    if (!session) throw new Error('SESSION_NOT_FOUND')
    // Session-switch marker hydration is read-only: reuse a blocked verdict rather than rescanning
    // all canonical history on every switch. Write paths keep the default retry behavior.
    const canPersist = !options.ensureSessionLedgerReady || await options.ensureSessionLedgerReady({ session, workDir, retryBlocked: false })
    if (!canPersist) return { replay: queries.readCanonicalCompactionReplay(sessionId) ?? { committed: [], rejected: [] }, canPersist: false }
    const sink = (options.getSessionEventSink ?? getSessionEventSink)(workDir, session.id, session.createdAt)
    const fileReplay = await (options.readCompactionReplay ?? readCompactionReplay)(sink.eventsPath)
    const canonicalReplay = queries.readCanonicalCompactionReplay(sessionId) ?? { committed: [], rejected: [] }
    const canonicalIds = new Set(canonicalReplay.committed.map(({ compactionId }) => compactionId))
    const rejectedIds = new Set(canonicalReplay.rejected.flatMap(({ compactionId }) => compactionId ? [compactionId] : []))
    const collidesWithRejectedCanonical = fileReplay.committed.some(({ compactionId }) => rejectedIds.has(compactionId))
    const hasLegacyOnlyCompaction = fileReplay.committed.some(({ compactionId }) => !canonicalIds.has(compactionId) && !rejectedIds.has(compactionId))
    if (collidesWithRejectedCanonical) throw new Error('CANONICAL_COMPACTION_REPLAY_INVALID')
    if (hasLegacyOnlyCompaction) {
      const sessionMessages = readLegacyProjectionMessages(db, sessionId)
      const latestUser = [...sessionMessages].reverse().find((message) => message.role === 'user')
      if (latestUser) {
        const built = await buildToolChatMessagesFromSource({ userDataDir: options.getUserDataDir?.() ?? '', workDir,
          sourceMessages: sessionMessages, currentUserMessageId: latestUser.id, sessionId })
        const projection = projectReplaySurfaceWithSources(built)
        const identities = surfaceItemIdentitiesForProjectionSubset(projection, projection)
        let surface = projection.messages.map((message, index) => ({ ...message, id: message.id ?? identities[index]! }))
        const canonicalizeJson = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalizeJson)
          : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonicalizeJson(item)])) : value
        const stableJson = (value: unknown): string => JSON.stringify(canonicalizeJson(value))
        for (const record of fileReplay.committed) {
          const canonicalRecord = canonicalReplay.committed.find(({ compactionId }) => compactionId === record.compactionId)
          if (canonicalRecord) {
            if (stableJson(canonicalRecord.start.payload) !== stableJson(record.start.payload) ||
              stableJson(canonicalRecord.summary.payload) !== stableJson(record.summary.payload)) {
              throw new Error('CANONICAL_COMPACTION_REPLAY_INVALID')
            }
          }
          if (rejectedIds.has(record.compactionId)) continue
          const windowId = typeof record.start.payload.windowId === 'string' ? record.start.payload.windowId : `session:${sessionId}`
          const nextSurface = applyCommittedSurfaceShadow(surface, { committed: [record], rejected: [] }, [latestUser.id], windowId,
            (items) => computeReplaySurfaceFingerprint('', items))
          if (typeof record.summary.payload.outputSurfaceFingerprint !== 'string' ||
            computeReplaySurfaceFingerprint('', nextSurface) !== record.summary.payload.outputSurfaceFingerprint) continue
          if (canonicalRecord) {
            surface = nextSurface
            continue
          }
          const start = record.start.payload
          const summary = record.summary.payload
          const invocationId = `legacy-compaction-backfill:${sessionId}:${record.compactionId}`
          const eventId = `${invocationId}:transcript-compacted`
          const history = execution.historyFor({ sessionId })
          const stored = await history.read(invocationId)
          const payload = { compactionId: record.compactionId,
            messages: nextSurface.map((message) => ({ ...message })),
            sessionLedger: { location: { workDir, sessionId, createdAt: session.createdAt }, start, summary },
            surfaceReplay: { windowId, inputFingerprint: start.inputSurfaceFingerprint,
              outputFingerprint: summary.outputSurfaceFingerprint,
              checkpointReplayIdentity: (summary.candidate as { checkpointReplayIdentity?: unknown } | undefined)?.checkpointReplayIdentity } }
          if (stored.version > 0) {
            const existing = stored.events.find(({ kind }) => kind === 'transcript-compacted')
            if (!existing || stableJson(existing.payload) !== stableJson(payload)) throw new Error('LEGACY_COMPACTION_BACKFILL_IDEMPOTENCY_CONFLICT')
          } else {
            await history.appendBatch([{ invocationId, turnId: invocationId, sequence: 1, schemaVersion: 1,
              eventId, idempotencyKey: eventId, kind: 'transcript-compacted', payload }], 0)
          }
          surface = nextSurface
        }
      }
    }
    const refreshedCanonicalReplay = queries.readCanonicalCompactionReplay(sessionId) ?? canonicalReplay
    const refreshedCanonicalIds = new Set(refreshedCanonicalReplay.committed.map(({ compactionId }) => compactionId))
    const stillHasLegacyOnlyCompaction = fileReplay.committed.some(({ compactionId }) => !refreshedCanonicalIds.has(compactionId) && !rejectedIds.has(compactionId))
    // Keep the file replay as the ordered compatibility source while it contains pre-canonical facts.
    // Once every file fact has a canonical owner, History supplies the replay without a JSONL dependency.
    return { replay: stillHasLegacyOnlyCompaction ? fileReplay : refreshedCanonicalReplay, sink, canPersist: true }
  }
  const readContextMeterEventsForLocation = async (sessionId: string, workDir: string): Promise<readonly CanonicalContextMeterEvent[]> => {
    const session = queries.readSession(sessionId)
    if (!session) throw new Error('SESSION_NOT_FOUND')
    if (options.ensureSessionLedgerReady) {
      try {
        if (!(await options.ensureSessionLedgerReady({ session, workDir }))) {
          return queries.readCanonicalContextMeterEvents(sessionId) ?? []
        }
      } catch {
        return queries.readCanonicalContextMeterEvents(sessionId) ?? []
      }
    }
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
  const readSourceBodies = async (input: Readonly<{ sessionId: string; sessionGeneration: string; sourceIdentityJson: string;
    messageIds: readonly string[]; expectedSequences: readonly Readonly<{ id: string; sequence: number }>[];
    recordStage?: (name: string, durationMs: number) => void }>) => {
    if (!cacheBlobs || input.messageIds.length === 0) return undefined
    const conn = getDbConnection(db)
    const source = runInTransaction(conn, () => {
      if (readProjectionSourceIdentity(conn, input.sessionId, input.sessionGeneration) !== input.sourceIdentityJson) return undefined
      let identity: { sourceRevision?: unknown }
      try { identity = JSON.parse(input.sourceIdentityJson) as typeof identity } catch { return undefined }
      if (!Number.isSafeInteger(identity.sourceRevision) || (identity.sourceRevision as number) < 0) return undefined
      const sourceRevision = identity.sourceRevision as number
      const state = conn.prepare('SELECT source_revision,status FROM session_body_source_state WHERE session_id=?')
        .get(input.sessionId) as { source_revision: number; status: string } | undefined
      if (!state || state.status !== 'complete' || state.source_revision !== sourceRevision) return undefined
      const fragments: Array<{ id: string; sequence: number; locator: string; byteLength: number; sha256: string }> = []
      for (let start = 0; start < input.messageIds.length; start += 400) {
        const batch = input.messageIds.slice(start, start + 400)
        const marks = batch.map(() => '?').join(',')
        fragments.push(...conn.prepare(`SELECT locator.message_id AS id,locator.sequence,locator.fragment_locator AS locator,
          locator.byte_length AS byteLength,locator.sha256 FROM session_message_body_locator locator
          WHERE locator.session_id=? AND locator.message_id IN (${marks})`).all(input.sessionId, ...batch) as typeof fragments)
      }
      if (fragments.length !== input.messageIds.length || new Set(fragments.map(({ id }) => id)).size !== input.messageIds.length) {
        throw new Error('PROJECTION_SOURCE_LOCATOR_UNAVAILABLE')
      }
      const expectedSequenceById = new Map(input.expectedSequences.map(({ id, sequence }) => [id, sequence]))
      if (fragments.some(({ id, sequence }) => expectedSequenceById.get(id) !== sequence)) throw new Error('PROJECTION_SOURCE_LOCATOR_SEQUENCE_MISMATCH')
      const sourceSpillStartedAt = performance.now()
      const sourceTruthSpills = readProjectionPageSourceSpills(conn, input.sessionId, sourceRevision, input.messageIds)
      try { input.recordStage?.('source-spill-discovery', performance.now() - sourceSpillStartedAt) } catch { /* Diagnostics must not alter the read. */ }
      const sourceSpillStore = sourceTruthSpills.length ? createSpillStoreForDatabase(conn) : undefined
      if (sourceTruthSpills.length && !sourceSpillStore) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
      return { sourceRevision, fragments: input.messageIds.map((id) => fragments.find((fragment) => fragment.id === id)!),
        sourceTruthSpills, sourceSpillRoot: sourceSpillStore?.root }
    })
    if (!source) return undefined
    const workerStartedAt = performance.now()
    const result = await readProjectionSourceChatBodiesInWorker({ root: cacheBlobs.root, sessionId: input.sessionId,
      sessionGeneration: input.sessionGeneration, sourceRevision: source.sourceRevision, fragments: source.fragments,
      sourceSpillRoot: source.sourceSpillRoot, sourceTruthSpills: source.sourceTruthSpills, expectedMessageIds: input.messageIds,
      ...(input.recordStage ? { onQueueWait: (durationMs) => input.recordStage?.('worker-queue', durationMs) } : {}) })
    try { input.recordStage?.('worker-read', performance.now() - workerStartedAt) } catch { /* Diagnostics must not alter the read. */ }
    return result
  }
  const readSourceTruthSpillsForPreparedView = (sessionId: string, sessionGeneration: string, expectedIdentity: string,
    messageIds?: readonly string[]):
    Readonly<{ root?: string; descriptors: readonly SpillDescriptor[] }> => {
    const conn = getDbConnection(db)
    if (messageIds && messageIds.length > 0) {
      let sourceRevision: number | undefined
      try {
        const identity = JSON.parse(expectedIdentity) as { sourceRevision?: unknown }
        if (Number.isSafeInteger(identity.sourceRevision) && (identity.sourceRevision as number) >= 0) sourceRevision = identity.sourceRevision as number
      } catch { /* The existing identity comparison below reports unavailable evidence. */ }
      const locatorState = conn.prepare('SELECT source_revision,status FROM session_body_source_state WHERE session_id=?')
        .get(sessionId) as { source_revision: number; status: string } | undefined
      if (sourceRevision !== undefined && locatorState?.status === 'complete' && locatorState.source_revision === sourceRevision) {
        if (readProjectionSourceIdentity(conn, sessionId, sessionGeneration) !== expectedIdentity) throw new Error('PROJECTION_SOURCE_IDENTITY_CHANGED')
        const descriptors = readProjectionPageSourceSpills(conn, sessionId, sourceRevision, messageIds)
        if (!descriptors.length) return { descriptors }
        const sourceSpillStore = createSpillStoreForDatabase(conn)
        if (!sourceSpillStore) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
        return { root: sourceSpillStore.root, descriptors }
      }
      throw new Error('PROJECTION_SOURCE_LOCATOR_NOT_READY')
    }
    const evidence = runInTransaction(conn, () => {
      if (readProjectionSourceIdentity(conn, sessionId, sessionGeneration) !== expectedIdentity) return undefined
      const state = conn.prepare(`SELECT status,verified_generation FROM spill_reference_backfill_state
        WHERE owner_table='agent_history_events'`).get() as { status: string; verified_generation: number | null } | undefined
      const generation = conn.prepare("SELECT meta_value FROM spill_reference_meta WHERE meta_key='canonical_change_generation'")
        .get() as { meta_value: number } | undefined
      if (!state || !generation || !Number.isSafeInteger(generation.meta_value) ||
        (state.status === 'complete' && (!Number.isSafeInteger(state.verified_generation) || state.verified_generation! > generation.meta_value))) return undefined
      if (state.status !== 'complete') {
        const hasSpillMarker = conn.prepare(`SELECT 1 AS present FROM agent_history_events
          WHERE session_id=? AND payload_json LIKE '%__spaceassistant_%spill%' LIMIT 1`).get(sessionId)
        if (hasSpillMarker) return undefined
        return [] as SpillDescriptor[]
      }
      const rows = conn.prepare(`SELECT refs.owner_revision AS ownerRevision,events.spill_reference_revision AS currentRevision,
          refs.descriptor_json AS descriptorJson
        FROM agent_history_events events JOIN spill_reference_index refs
          ON refs.owner_table='agent_history_events' AND refs.owner_key=json_array(events.invocation_id,events.event_id)
        WHERE events.session_id=? AND refs.kind='source-of-truth' ORDER BY events.session_seq,refs.descriptor_path`).all(sessionId) as
        Array<{ ownerRevision: string; currentRevision: number; descriptorJson: string }>
      if (rows.some(({ ownerRevision, currentRevision }) => ownerRevision !== String(currentRevision))) return undefined
      const descriptors: SpillDescriptor[] = []
      for (const { descriptorJson } of rows) {
        let parsed: unknown
        try { parsed = JSON.parse(descriptorJson) } catch { return undefined }
        const found = collectSpillDescriptorsStrict({ __spaceassistant_spill_v1: parsed })
        if (found.length !== 1 || found[0]?.kind !== 'source-of-truth') return undefined
        descriptors.push(found[0])
      }
      return descriptors
    })
    if (!evidence) throw new Error('PROJECTION_SOURCE_SPILL_INDEX_UNAVAILABLE')
    if (!evidence.length) return { descriptors: evidence }
    const sourceSpillStore = createSpillStoreForDatabase(conn)
    if (!sourceSpillStore) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    return { root: sourceSpillStore.root, descriptors: evidence }
  }
  const queries = createSessionQueries(db, {
    ...(cacheBlobs && options.requestBodySourceBackfill ? { readSourceBodies,
      requestSourceBackfill: (sessionId) => {
        const state = getDbConnection(db).prepare(`SELECT source_revision,terminal_source_revision,terminal_reducer_spec_version
          FROM session_body_source_state WHERE session_id=?`).get(sessionId) as
          { source_revision: number; terminal_source_revision: number | null; terminal_reducer_spec_version: number | null } | undefined
        if (state && state.terminal_source_revision === state.source_revision &&
          state.terminal_reducer_spec_version === CHAT_BODY_PROJECTION_SPEC_VERSION) return false
        return options.requestBodySourceBackfill?.() === false ? false : true
      },
      waitForSourceBackfill: async ({ sessionId, sessionGeneration, sourceRevision }) => {
        const timeoutMs = options.sourceBackfillWaitMs ?? 10 * 60_000
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error('PROJECTION_SOURCE_BACKFILL_WAIT_BUDGET_INVALID')
        const deadline = Date.now() + timeoutMs
        for (;;) {
          const state = runInTransaction(getDbConnection(db), () => getDbConnection(db).prepare(`SELECT sessions.generation,
            state.source_revision,state.status FROM sessions LEFT JOIN session_body_source_state state ON state.session_id=sessions.id
            WHERE sessions.id=?`).get(sessionId) as { generation: string; source_revision: number | null; status: string | null } | undefined)
          if (!state) return 'missing' as const
          if (state.generation !== sessionGeneration || state.source_revision !== sourceRevision) return 'changed' as const
          if (state.status === 'complete') return 'complete' as const
          if (Date.now() >= deadline) return 'timeout' as const
          await new Promise<void>((resolve) => setTimeout(resolve, 100))
        }
      } } : {}),
    currentSourceIdentity: (sessionId, sessionGeneration) => {
      const snapshot = cacheStore.readSnapshot(sessionId, bodyScopeKey)
      return snapshot?.sessionGeneration === sessionGeneration && snapshot.currentSessionGeneration === sessionGeneration
        ? snapshot.currentSourceIdentityJson ?? undefined : undefined
    },
    currentAuthoritySourceIdentity: (sessionId, sessionGeneration) => readProjectionSourceIdentity(getDbConnection(db), sessionId, sessionGeneration) ?? undefined,
    readBodies: (view, messageIds, signal, recordWorkerTiming) => {
      const sourceStartedAt = performance.now()
      const source = readSourceTruthSpillsForPreparedView(view.sessionId, view.sessionGeneration, view.sourceIdentityJson, messageIds)
      try { recordWorkerTiming?.('source-spill-discovery', performance.now() - sourceStartedAt) } catch { /* Diagnostics must not affect the read. */ }
      return readPreparedChatBodiesInWorker({ root: cacheBlobs?.root ?? '', sourceSpillRoot: source.root,
        sourceTruthSpills: source.descriptors, view, messageIds, signal, onWorkerTiming: recordWorkerTiming })
    },
    searchBodies: (view, query, limit, candidateFacts) => {
      const source = readSourceTruthSpillsForPreparedView(view.sessionId, view.sessionGeneration, view.sourceIdentityJson)
      return searchPreparedChatBodiesInWorker({ root: cacheBlobs?.root ?? '', sourceSpillRoot: source.root,
        sourceTruthSpills: source.descriptors, view, query, limit, candidateFacts })
    },
    invalidate: (view) => invalidatePreparedChatBodyView(view, cacheStore)
  })
  const ensureView = createEnsureView()
  const readPreparedChatBodyV1: NonNullable<SessionStorage['readPreparedChatBodyV1']> = ({ sessionId }) => {
    const result = readProjectionChatBodyCacheManifest({ sessionId, scopeKey: bodyScopeKey,
      specVersion: CHAT_BODY_PROJECTION_SPEC_VERSION }, cacheStore)
    return result.kind === 'ready' ? preparedChatBodyViewFromSnapshot(result.snapshot) : undefined
  }
  const canReadChatBodyBeforePreparation: NonNullable<SessionStorage['canReadChatBodyBeforePreparation']> = (sessionId) => {
    const conn = getDbConnection(db)
    return runInTransaction(conn, () => hasCurrentPriorChatBodyAuthority(conn, sessionId))
  }
  const readChatMessagesBeforePreparation: NonNullable<SessionStorage['readChatMessagesBeforePreparation']> =
    ({ sessionId, limit, offset }) => {
      const conn = getDbConnection(db)
      const authorized = runInTransaction(conn, () => hasCurrentPriorChatBodyAuthority(conn, sessionId))
      // The parity proof only makes the cold read eligible. Materialize through
      // the canonical authority reader outside the proof transaction so source
      // spill files are checked without holding a WAL snapshot open.
      return authorized ? queries.readMessages({ sessionId, limit: limit ?? 500, offset: offset ?? 0 }) : undefined
    }
  const ensureChatBodyV1: NonNullable<SessionStorage['ensureChatBodyV1']> = ({ sessionId, signal }) => {
    if (!options.prepareProjection) return Promise.reject(new Error('PROJECTION_PREPARATION_UNAVAILABLE'))
    return ensureView<PreparedChatBodyView>({ sessionId, scopeKey: bodyScopeKey, signal,
      read: async () => {
        const value = readPreparedChatBodyV1({ sessionId })
        return value ? { ready: true as const, value } : { ready: false as const }
      },
      prepare: () => options.prepareProjection!({ sessionId, scopeKey: bodyScopeKey, specVersion: CHAT_BODY_PROJECTION_SPEC_VERSION }) })
  }
  const requestChatBodyV1: NonNullable<SessionStorage['requestChatBodyV1']> = async ({ sessionId }) => {
    await ensureChatBodyV1({ sessionId })
  }
  const execution = createSessionExecutionStore(db, queries, { getTurnRuntime: options.getTurnRuntime, ensureChatBodyV1,
    requestBodySourceBackfill: options.requestBodySourceBackfill })
  const contexts = createSessionStorageContextRouter(async ({ sessionId, isBusy }) => {
    const session = queries.readSession(sessionId)
    const workDir = options.getWorkDirForSession?.(sessionId)
    const userDataDir = options.getUserDataDir?.()
    if (!session || !workDir || !userDataDir) throw new Error('SESSION_CONTEXT_RESOURCES_UNAVAILABLE')
    const { sink, replay, canPersist } = await readCompactionReplayForLocation(sessionId, workDir)
    return createStorageSessionContextAdapter({ sessionId, session, queries, ensureChatBodyV1, workDir, userDataDir, replay, sink, canPersist, isBusy,
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
        ledger: Object.freeze({ state: 'degraded' as const, readinessState: 'unknown' as const, reasonCode: 'readiness-missing' as const,
          reason: 'readiness-missing' as const, source: Object.freeze({ sessionId }) }),
        maintenance: Object.freeze({ state: maintenanceState, tasks: Object.freeze(maintenanceTasks), source: maintenanceSource })
      })
      const conn = getDbConnection(db)
      const cutover = conn.prepare('SELECT session_generation,message_revision,write_mode FROM session_message_content_cutover WHERE session_id=?')
        .get(sessionId) as { session_generation: string; message_revision: number; write_mode: string } | undefined
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
      let ledger: { state: 'ready' | 'degraded'; readinessState: 'uninitialized' | 'initializing' | 'unknown' | 'checking' | 'ready' | 'dirty' | 'blocked'; reasonCode?: 'location-unavailable' | 'readiness-missing' | 'ledger-uninitialized' | 'ledger-initializing' | 'ledger-unknown' | 'ledger-checking' | 'ledger-dirty' | 'ledger-blocked'; reason?: 'location-unavailable' | 'readiness-missing'; source: { sessionId: string; locationKey?: string; ledgerGeneration?: number; canonicalWatermark?: string | null; failureClass?: string | null } }
      if (!workDir) ledger = { state: 'degraded', readinessState: 'unknown', reason: 'location-unavailable', reasonCode: 'location-unavailable', source: { sessionId } }
      else {
        const location = { workDir, sessionId, createdAt: session.createdAt }
        const readiness = readSessionLedgerAvailability(conn, location)
        const reasonCode = readiness.state === 'ready' ? undefined : readiness.reason ?? `ledger-${readiness.state}` as NonNullable<typeof ledger['reasonCode']>
        ledger = { state: readiness.state === 'ready' ? 'ready' : 'degraded', readinessState: readiness.state,
          ...(reasonCode ? { reasonCode } : {}), ...(readiness.reason ? { reason: readiness.reason } : {}), source: { sessionId, locationKey: readiness.locationKey,
          ...(readiness.ledgerGeneration !== undefined ? { ledgerGeneration: readiness.ledgerGeneration } : {}),
          ...(readiness.canonicalWatermark !== undefined ? { canonicalWatermark: readiness.canonicalWatermark } : {}),
          ...(readiness.failureClass !== undefined ? { failureClass: readiness.failureClass } : {}) } }
      }
      return Object.freeze({
        globalFence,
        content: Object.freeze({ state: contentReadable ? 'readable' as const : 'unavailable' as const,
          ...(!contentReadable ? { reason: 'content-unavailable' as const } : {}),
          source: Object.freeze({ sessionGeneration: session.generation, messageRevision: cutover?.message_revision ?? 0,
            authority: cutover?.write_mode ?? 'legacy' }) }),
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
  const storagePorts: SessionStorage = {
    queries, commands: createSessionCommands(db), execution, contexts, recovery, availability, ensureLedgerReady,
    readPreparedChatBodyV1, canReadChatBodyBeforePreparation, requestChatBodyV1, readChatMessagesBeforePreparation,
    cleanup: createSqliteSessionCleanupPort(db),
    projectionMigration: Object.freeze({
      getRun: (runId: string) => getSessionProjectionMigrationRun(db, runId),
      createOrReuseRun: (input: { runId?: string; knownSessionIds?: readonly string[]; now: number }) => {
        const requestedId = input.runId
        if (requestedId) {
          const existing = getDbConnection(db).prepare('SELECT 1 AS present FROM session_projection_migration_runs WHERE run_id=?')
            .get(requestedId)
          if (existing) return getSessionProjectionMigrationRun(db, requestedId)
        } else {
          const row = getDbConnection(db).prepare(`SELECT run_id FROM session_projection_migration_runs
            WHERE status IN ('running','paused','needs_retry') AND cancelled_at IS NULL ORDER BY created_at DESC,run_id DESC LIMIT 1`)
            .get() as { run_id: string } | undefined
          if (row) return getSessionProjectionMigrationRun(db, row.run_id)
        }
        const runId = requestedId ?? randomUUID()
        const inventory = buildSessionProjectionMigrationInventory(db,
          input.knownSessionIds ? { knownSessionIds: input.knownSessionIds } : {})
        try {
          return startSessionProjectionMigration(db, inventory, { runId, now: input.now })
        } catch (error) {
          if (!requestedId) {
            const row = getDbConnection(db).prepare(`SELECT run_id FROM session_projection_migration_runs
              WHERE status IN ('running','paused','needs_retry') AND cancelled_at IS NULL ORDER BY created_at DESC,run_id DESC LIMIT 1`)
              .get() as { run_id: string } | undefined
            if (row) return getSessionProjectionMigrationRun(db, row.run_id)
          }
          throw error
        }
      },
      runBatch: (runId: string, input: { batchSize: number; rateLimitMs: number; now: number }) =>
        runSessionProjectionMigrationBatch(db, runId, input),
      pause: (runId: string, now: number) => pauseSessionProjectionMigration(db, runId, now),
      resume: (runId: string, now: number) => resumeSessionProjectionMigration(db, runId, now),
      cancel: (runId: string, now: number) => cancelSessionProjectionMigration(db, runId, now),
    }),
    checkpointProjection: (sessionId: string) => checkpointSessionTranscriptProjection(db, sessionId),
    clearProjectionCaches: () => clearSessionProjectionCaches(db),
    shouldRetainSessionEventDirectory: createSessionLedgerCompactionDependencyGuard(db),
    readCompactionReplay: readCompactionReplayForSession,
    readContextMeterEvents: readContextMeterEventsForSession,
    ...(options.prepareProjection ? { ensureChatBodyV1 } : {}),
    ...(options.prepareProjection ? { prepareProjection: options.prepareProjection } : {})
  }
  return Object.freeze({ ...storagePorts,
    prepareSessionEventRetentionProjection: createCanonicalSessionProjectionRetentionPreparer(db, storagePorts) })
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
  const blobGcTask = input.storage.projectionBlobRoot ? createProjectionBlobGcTask(db, input.storage.projectionBlobRoot) : undefined
  const lifecycle = createStorageLifecycleControl({
    tasks: [...(input.maintenanceTasks ?? []), ...(blobGcTask ? [blobGcTask] : [])],
    quiesce: input.quiesceMaintenance
  })
  const storage = createSqliteSessionStorage(db, {
    ...input.storage,
    requestBodySourceBackfill: () => {
      const request = lifecycle.requestMaintenance({ reason: 'scope-changed', taskId: 'session-body-source-backfill' })
      const task = lifecycle.inspectMaintenance().find(({ taskId }) => taskId === 'session-body-source-backfill')
      return request.status !== 'not-needed' && task?.status === 'scheduled'
    },
    inspectMaintenance: () => lifecycle.inspectMaintenance(),
    prepareProjection: async (request) => {
      await lifecycle.prepareProjection(request)
      lifecycle.requestMaintenance({ reason: 'scope-changed', category: 'pending-reclamation' })
    },
    recoveryStages: {
      ...input.storage.recoveryStages,
      history: input.startup.recoverHistory,
      ledgerRepairs: async () => (await input.startup.recoverSessionLedgers()).repairFailureCount
    }
  })
  const hostStorage: SessionStorage = Object.freeze({ ...storage,
    prepareProjection: async (request: Parameters<NonNullable<SessionStorage['prepareProjection']>>[0]) => {
      await lifecycle.prepareProjection(request)
      lifecycle.requestMaintenance({ reason: 'scope-changed', category: 'pending-reclamation' })
    },
    ...(storage.clearProjectionCaches ? { clearProjectionCaches: async () => {
      const result = await storage.clearProjectionCaches!()
      lifecycle.requestMaintenance({ reason: 'policy-changed', category: 'pending-reclamation' })
      return result
    } } : {}),
    commands: Object.freeze({ ...storage.commands, deleteSession: (sessionId: string) => {
      const result = storage.commands.deleteSession(sessionId)
      lifecycle.requestMaintenance({ reason: 'scope-changed', category: 'pending-reclamation' })
      return result
    } })
  })
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
  onSlice?: ProjectionBuildSupervisorOptions['onSlice']
  onResult?: ProjectionBuildSupervisorOptions['onResult']
  onFailure?: ProjectionBuildSupervisorOptions['onFailure']
}>): LifecycleTaskRegistration {
  const stateStore = createSqliteProjectionStateStore(input.db)
  const service = createProjectionService(stateStore, { processGeneration: input.processGeneration,
    connectionEpoch: input.connectionEpoch, createToken: randomUUID, now: input.now })
  const blobStore = createSessionProjectionBlobStore(input.blobRoot)
  const blobs = Object.freeze({ ...blobStore,
    materializeFinalView: (output: Parameters<NonNullable<ProjectionBuildSupervisorOptions['blobs']['materializeFinalView']>>[0],
      identity: Parameters<NonNullable<ProjectionBuildSupervisorOptions['blobs']['materializeFinalView']>>[1], historyWatermarkJson: unknown, signal?: AbortSignal) =>
      blobStore.withWorkerStaging(async (promote) => {
        const result = await materializeProjectionFinalViewInWorker({ root: blobStore.root, output, identity, historyWatermarkJson, signal })
        if (result.pagedArtifacts) {
          const promoted: Array<Awaited<ReturnType<typeof promote>>> = []
          for (const staged of result.pagedArtifacts.stagedBlobs) {
            promoted.push(await promote({ tempLocator: staged.tempLocator, locator: staged.locator,
              byteLength: staged.byteLength, payloadDigest: staged.payloadDigest }))
          }
          const manifestIndex = result.pagedArtifacts.stagedBlobs.findIndex(({ kind }) => kind === 'body-manifest')
          return { ...(result.payload === undefined ? {} : { payload: result.payload }),
            ...(manifestIndex < 0 ? {} : { blob: promoted[manifestIndex] }), byteLength: result.byteLength, payloadDigest: result.payloadDigest,
            ...(result.pagedArtifacts.blobReferences.length ? { blobReferences: result.pagedArtifacts.blobReferences.map((reference) => ({ ...reference })) } : {}),
            releaseArtifacts: async () => { await promoted[0]?.release() } }
        }
        if (!result.stagedBlob) return result
        const blob = await promote(result.stagedBlob)
        return { byteLength: result.byteLength, payloadDigest: result.payloadDigest, blob }
      }) })
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
    reduceChunk: reduceProjectionHistoryChunkInWorker,
    blobs, limits: input.limits ?? { maxRows: 200, maxBytes: 256 * 1024 },
    maxChunksPerSlice: input.maxChunksPerSlice ?? 4, sliceBudgetMs: 8, maintenancePromotionAgeMs: 250,
    now: input.now, onResult: input.onResult,
    onSlice: input.onSlice, onFailure: input.onFailure })
}
