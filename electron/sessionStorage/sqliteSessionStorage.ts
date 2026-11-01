import type { AppDatabase } from '../database/sqliteStore'
import { getDbConnection } from '../database/sqliteStore'
import { getSession } from '../database/operations'
import { createSpillStoreForDatabase } from '../storage/spillStore'
import { collectSpillDescriptorsStrict, type SpillDescriptor } from '../storage/spillProtocol'
import { createHash, randomUUID } from 'node:crypto'
import type { SessionStorage, SessionStorageHost, SessionStorageStartupCoordination } from './host/ports'
import { createSessionCommands } from './commands'
import { createSessionQueries } from './queries'
import { createSessionExecutionStore } from './execution'
import { createSessionCommitService } from './host/sessionCommitService'
import { createSessionStorageContextRouter } from './contextPortRegistry'
import { getSessionEventSink, notifySessionEventLedgerFailure, readCompactionReplay, readSessionEvents, replayCompactionEvents,
  withSessionEventWriterDrain } from '../sessionEvents'
import { sessionLedgerLocationIdentity } from '../sessionLedgerIdentity'
import { markLegacyLedgerMergeCompleted, readSessionLedgerReadiness } from '../sessionLedgerReadiness'
import { withSessionLedgerLifecycleLock } from '../sessionLedgerLifecycle'
import type { CompactionReplay } from '../../src/shared/compactionEvents'
import type { CanonicalContextMeterEvent, PreparedChatBodyView } from './public/model'
import { createStorageSessionContextAdapter } from './contextAdapter'
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
import type { HistoryEvent } from '../../packages/agent-sdk/src/history'
import { invalidatePreparedChatBodyView, preparedChatBodyViewFromSnapshot, readProjectionChatBodyCacheManifest } from './application/projectionChatBodyCacheReader'
import { encodeProjectionScopeKey } from './domain/scopeKey'
import type { LifecycleTaskRegistration } from './host/ports'
import type { ProjectionBuildSupervisorOptions } from './application/projectionBuildSupervisor'
import { readPreparedChatBodiesInWorker, searchPreparedChatBodiesInWorker } from './infrastructure/sqlite/projectionChatBodyCacheWorkerClient'
import { readProjectionSourceChatBodiesInWorker } from './infrastructure/sqlite/projectionSourceChatBodyWorkerClient'
import { readLegacyProjectionMessages } from './infrastructure/sqlite/sessionLegacyQueryAdapter'
import { buildToolChatMessagesFromSource } from '../chatMessageBuild'
import { applyCommittedSurfaceShadow, computeReplaySurfaceFingerprint, projectReplaySurfaceWithSources, surfaceItemIdentities, surfaceItemIdentitiesForProjectionSubset } from '../../src/shared/surfaceReplay'

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
  ensureSessionLedgerReady?: (input: { session: import('../../src/shared/domainTypes').Session; workDir: string; retryBlocked?: boolean }) =>
    Promise<boolean | { ready: boolean; canonicalReadVersion: number | null }>
  inspectMaintenance?: () => readonly MaintenanceState[]
} = {}): SessionStorage {
  const ledgerCheckReady = (result: boolean | { ready: boolean; canonicalReadVersion: number | null }): boolean =>
    typeof result === 'boolean' ? result : result.ready
  const ledgerCheckReadVersion = (result: boolean | { ready: boolean; canonicalReadVersion: number | null }): number | null | undefined =>
    typeof result === 'boolean' ? undefined : result.canonicalReadVersion
  const isCanonicalReadLocation = (location: { workDir: string; sessionId: string; createdAt: number }, sessionGeneration: string): boolean => {
    const identity = sessionLedgerLocationIdentity(location)
    const readiness = readSessionLedgerReadiness(getDbConnection(db), identity.key)
    return readiness?.canonicalReadVersion === 1 && readiness.workDirIdentity === identity.workDirIdentity &&
      readiness.sessionId === location.sessionId && readiness.sessionGeneration === sessionGeneration
  }
  const readCompactionReplayForLocation = async (sessionId: string, workDir: string, sourceRetry = 0): Promise<{
    replay: CompactionReplay; sink?: ReturnType<typeof getSessionEventSink>; canPersist: boolean
  }> => {
    const session = queries.readSession(sessionId)
    if (!session) throw new Error('SESSION_NOT_FOUND')
    const location = { workDir, sessionId: session.id, createdAt: session.createdAt }
    return withSessionLedgerLifecycleLock(sessionLedgerLocationIdentity(location).key, async () => {
    // Session-switch marker hydration is read-only: reuse a blocked verdict rather than rescanning
    // all canonical history on every switch. Write paths keep the default retry behavior.
    const readinessResult = options.ensureSessionLedgerReady
      ? await options.ensureSessionLedgerReady({ session, workDir, retryBlocked: false }) : true
    const canPersist = ledgerCheckReady(readinessResult)
    if (!canPersist) return { replay: queries.readCanonicalCompactionReplay(sessionId) ?? { committed: [], rejected: [] }, canPersist: false }
    const readVersion = ledgerCheckReadVersion(readinessResult)
    if (readVersion === 1 || (readVersion === undefined && isCanonicalReadLocation(location, session.generation))) {
      return { replay: queries.readCanonicalCompactionReplay(sessionId) ?? { committed: [], rejected: [] }, canPersist: true }
    }
    const sink = (options.getSessionEventSink ?? getSessionEventSink)(workDir, session.id, session.createdAt)
    const conversion = await withSessionEventWriterDrain(workDir, session.id, async () => {
    let sourceEvents: Awaited<ReturnType<typeof readSessionEvents>> = []
    let sourceReadable = true
    try { sourceEvents = await readSessionEvents(sink.eventsPath) }
    catch (error) {
      if (!options.readCompactionReplay) {
        notifySessionEventLedgerFailure({ workDir, sessionId: session.id, createdAt: session.createdAt }, error)
        throw error
      }
      sourceReadable = false
    }
    const sourceRevision = sessionLedgerSourceRevision(sourceEvents)
    let fileReplay: CompactionReplay
    try {
      fileReplay = options.readCompactionReplay
        ? await options.readCompactionReplay(sink.eventsPath) : replayCompactionEvents(sourceEvents)
    } catch (error) {
      notifySessionEventLedgerFailure({ workDir, sessionId: session.id, createdAt: session.createdAt }, error)
      throw error
    }
    const canonicalReplay = queries.readCanonicalCompactionReplay(sessionId) ?? { committed: [], rejected: [] }
    const canonicalIds = new Set(canonicalReplay.committed.map(({ compactionId }) => compactionId))
    const rejectedIds = new Set(canonicalReplay.rejected.flatMap(({ compactionId }) => compactionId ? [compactionId] : []))
    const collidesWithRejectedCanonical = fileReplay.committed.some(({ compactionId }) => rejectedIds.has(compactionId))
    const hasLegacyOnlyCompaction = fileReplay.committed.some(({ compactionId }) => !canonicalIds.has(compactionId) && !rejectedIds.has(compactionId))
    const backfillPrefix = `legacy-compaction-backfill:${sessionId}:`
    const readBackfillCompletionState = (committed: CompactionReplay['committed']) => {
      const hasPartialCanonicalBackfill = Boolean(getDbConnection(db).prepare(`SELECT 1
        FROM agent_history_streams streams
        JOIN agent_history_events events ON events.invocation_id=streams.invocation_id
        WHERE streams.session_id=? AND streams.version=1 AND substr(streams.invocation_id,1,length(?))=?
          AND events.kind='transcript-compacted' LIMIT 1`).get(sessionId, backfillPrefix, backfillPrefix))
      const backfillEvents = getDbConnection(db).prepare(`SELECT streams.invocation_id,events.payload_json
        FROM agent_history_streams streams
        JOIN agent_history_events events ON events.invocation_id=streams.invocation_id
        WHERE streams.session_id=? AND events.kind='transcript-compacted' AND substr(streams.invocation_id,1,length(?))=?`)
        .all(sessionId, backfillPrefix, backfillPrefix) as Array<{ invocation_id: string; payload_json: string }>
      const versionedBackfills = new Set<string>()
      const sessionSnapshotBackfills = new Set<string>()
      for (const row of backfillEvents) {
        try {
          const payload = JSON.parse(row.payload_json) as { backfillSnapshotVersion?: unknown; sourceCompactionIds?: unknown }
          if (payload.backfillSnapshotVersion !== 2) continue
          versionedBackfills.add(row.invocation_id)
          if (Array.isArray(payload.sourceCompactionIds)) {
            for (const compactionId of payload.sourceCompactionIds) if (typeof compactionId === 'string') sessionSnapshotBackfills.add(compactionId)
          }
        } catch { /* Invalid snapshots are handled by canonical History validation when read. */ }
      }
      const hasBackfillWithoutCurrentSnapshot = committed.some(({ compactionId }) => {
        const invocationId = `${backfillPrefix}${compactionId}`
        if (!backfillEvents.some((row) => row.invocation_id === invocationId)) return false
        return !sessionSnapshotBackfills.has(compactionId) && !versionedBackfills.has(invocationId) && !backfillEvents.some((row) =>
          row.invocation_id.startsWith(`${invocationId}:transcript-snapshot:`) && versionedBackfills.has(row.invocation_id))
      })
      return { hasPartialCanonicalBackfill, hasBackfillWithoutCurrentSnapshot }
    }
    const { hasPartialCanonicalBackfill, hasBackfillWithoutCurrentSnapshot } = readBackfillCompletionState(canonicalReplay.committed)
    const backfillRecords = [...fileReplay.committed, ...canonicalReplay.committed.filter(({ compactionId }) =>
      !fileReplay.committed.some((record) => record.compactionId === compactionId))]
    if (collidesWithRejectedCanonical) throw new Error('CANONICAL_COMPACTION_REPLAY_INVALID')
    if (hasLegacyOnlyCompaction || hasPartialCanonicalBackfill || hasBackfillWithoutCurrentSnapshot) {
      const sessionMessages = readLegacyProjectionMessages(db, sessionId)
      const latestUser = [...sessionMessages].reverse().find((message) => message.role === 'user')
      if (latestUser) {
        const built = await buildToolChatMessagesFromSource({ userDataDir: options.getUserDataDir?.() ?? '', workDir,
          sourceMessages: sessionMessages, currentUserMessageId: latestUser.id, sessionId })
        const projection = projectReplaySurfaceWithSources(built)
        const identities = surfaceItemIdentitiesForProjectionSubset(projection, projection)
        let surface = projection.messages.map((message, index) => ({ ...message, id: message.id ?? identities[index]! }))
        const needsSessionSnapshot: string[] = []
        const canonicalizeJson = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalizeJson)
          : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonicalizeJson(item)])) : value
        const stableJson = (value: unknown): string => JSON.stringify(canonicalizeJson(value))
        for (const record of backfillRecords) {
          const canonicalRecord = canonicalReplay.committed.find(({ compactionId }) => compactionId === record.compactionId)
          if (canonicalRecord) {
            if (stableJson(canonicalRecord.start.payload) !== stableJson(record.start.payload) ||
              stableJson(canonicalRecord.summary.payload) !== stableJson(record.summary.payload)) {
              throw new Error('CANONICAL_COMPACTION_REPLAY_INVALID')
            }
          }
          if (rejectedIds.has(record.compactionId)) continue
          const windowId = [record.summary, record.end].map((event) => event.payload.outputWindowId)
            .find((value): value is string => typeof value === 'string') ??
            [record.end, record.summary, record.start].map((event) => event.payload.windowId)
              .find((value): value is string => typeof value === 'string') ?? `session:${sessionId}`
          const inputSurface = surface
          const nextSurface = applyCommittedSurfaceShadow(surface, { committed: [record], rejected: [] }, [latestUser.id], windowId,
            (items) => computeReplaySurfaceFingerprint('', items))
          const boundaryId = typeof record.start.payload.surfaceBoundaryId === 'string' ? record.start.payload.surfaceBoundaryId : undefined
          const currentIdentities = surfaceItemIdentities(inputSurface)
          const boundaryIndex = boundaryId ? inputSurface.findIndex(({ id }, index) => id === boundaryId || currentIdentities[index] === boundaryId) : -1
          const historicalIds = boundaryIndex >= 0 ? new Set(inputSurface.slice(0, boundaryIndex + 1).map(({ id }) => id)) : undefined
          const candidate = record.summary.payload.candidate
          const checkpoint = candidate && typeof candidate === 'object'
            ? (candidate as { checkpointMessage?: unknown }).checkpointMessage : undefined
          const checkpointId = checkpoint && typeof checkpoint === 'object' && typeof (checkpoint as { id?: unknown }).id === 'string'
            ? (checkpoint as { id: string }).id : undefined
          const historicalOutput = historicalIds
            ? nextSurface.filter(({ id }) => historicalIds.has(id) || id === checkpointId)
            : nextSurface
          if (typeof record.summary.payload.outputSurfaceFingerprint !== 'string' ||
            computeReplaySurfaceFingerprint('', historicalOutput) !== record.summary.payload.outputSurfaceFingerprint) continue
          if (canonicalRecord) {
            surface = nextSurface
            // The canonical compaction commit and compatibility backfill stream are separate
            // writes. A crash between them leaves a one-event backfill to close on retry.
            const backfillId = `legacy-compaction-backfill:${sessionId}:${record.compactionId}`
            const partialBackfill = await execution.historyFor({ sessionId }).read(backfillId)
            if (partialBackfill.version === 0) continue
          }
          const start = record.start.payload
          const summary = record.summary.payload
          const invocationId = `legacy-compaction-backfill:${sessionId}:${record.compactionId}`
          const eventId = `${invocationId}:transcript-compacted`
          const completedEventId = `${invocationId}:completed`
          const history = execution.historyFor({ sessionId })
          const stored = await history.read(invocationId)
          const payload = { compactionId: record.compactionId,
            // A completed backfill is also a candidate Hosted transcript snapshot. Keep
            // post-compaction turns so cutover does not mistake them for an untrusted tail.
            messages: nextSurface.map((message) => ({ ...message })), backfillSnapshotVersion: 2,
            sessionLedger: { location: { workDir, sessionId, createdAt: session.createdAt }, start, summary },
            surfaceReplay: { windowId, inputFingerprint: start.inputSurfaceFingerprint,
              outputFingerprint: summary.outputSurfaceFingerprint,
              checkpointReplayIdentity: (summary.candidate as { checkpointReplayIdentity?: unknown } | undefined)?.checkpointReplayIdentity } }
          const completedEvent = { invocationId, turnId: invocationId, sequence: 2, schemaVersion: 1,
            eventId: completedEventId, idempotencyKey: completedEventId, kind: 'invocation-completed' as const,
            payload: { status: 'completed', completedAt: Date.now() } }
          if (stored.version > 0) {
            const existing = stored.events.find(({ kind }) => kind === 'transcript-compacted')
            const existingPayload = existing?.payload as typeof payload | undefined
            const existingMessages = existingPayload && Array.isArray(existingPayload.messages) ? existingPayload.messages : undefined
            const expectedMessages = payload.messages
            let expectedIndex = 0
            const storedMessagesAreKnown = existingMessages?.every((message) => {
              const messageId = message && typeof message === 'object' ? (message as { id?: unknown }).id : undefined
              if (typeof messageId !== 'string') return false
              const expectedIndexForStoredMessage = expectedMessages.findIndex((candidate, index) => index >= expectedIndex &&
                (candidate as { id?: unknown }).id === messageId && stableJson(candidate) === stableJson(message))
              if (expectedIndexForStoredMessage < 0) return false
              expectedIndex = expectedIndexForStoredMessage + 1
              return true
            })
            const metadataMatches = existingPayload && stableJson({ ...existingPayload, messages: undefined, backfillSnapshotVersion: undefined }) ===
              stableJson({ ...payload, messages: undefined, backfillSnapshotVersion: undefined })
            if (!existing || !existingMessages || !storedMessagesAreKnown || !metadataMatches) {
              throw new Error('LEGACY_COMPACTION_BACKFILL_IDEMPOTENCY_CONFLICT')
            }
            if (stableJson(existingMessages) !== stableJson(expectedMessages) || existingPayload?.backfillSnapshotVersion !== 2) {
              // Do not publish an intermediate snapshot here: a later canonical manual
              // compaction in this same replay chain may supersede this surface.
              needsSessionSnapshot.push(record.compactionId)
            }
            const terminal = stored.events.at(-1)
            if (stored.version === 1 && terminal?.kind === 'transcript-compacted') {
              await history.appendBatch([completedEvent], stored.version)
            } else if (stored.version !== 2 || terminal?.kind !== 'invocation-completed' ||
              (terminal.payload as { status?: unknown }).status !== 'completed') {
              throw new Error('LEGACY_COMPACTION_BACKFILL_IDEMPOTENCY_CONFLICT')
            }
          } else {
            await history.appendBatch([{ invocationId, turnId: invocationId, sequence: 1, schemaVersion: 1,
              eventId, idempotencyKey: eventId, kind: 'transcript-compacted', payload }, completedEvent], 0)
          }
          surface = nextSurface
        }
        if (needsSessionSnapshot.length > 0) {
          const sourceCompactionIds = [...new Set(needsSessionSnapshot)].sort()
          const transcriptVersion = createHash('sha256').update(stableJson({ sourceCompactionIds, messages: surface })).digest('hex').slice(0, 24)
          const snapshotInvocationId = `${backfillPrefix}session-transcript-snapshot:${transcriptVersion}`
          const snapshotEventId = `${snapshotInvocationId}:transcript-compacted`
          const snapshotCompletedEventId = `${snapshotInvocationId}:completed`
          const snapshotPayload = { messages: surface.map((message) => ({ ...message })), backfillSnapshotVersion: 2, sourceCompactionIds }
          const existingSnapshot = await execution.historyFor({ sessionId }).read(snapshotInvocationId)
          if (existingSnapshot.version === 0) {
            await execution.historyFor({ sessionId }).appendBatch([
              { invocationId: snapshotInvocationId, turnId: snapshotInvocationId, sequence: 1, schemaVersion: 1,
                eventId: snapshotEventId, idempotencyKey: snapshotEventId, kind: 'transcript-compacted', payload: snapshotPayload },
              { invocationId: snapshotInvocationId, turnId: snapshotInvocationId, sequence: 2, schemaVersion: 1,
                eventId: snapshotCompletedEventId, idempotencyKey: snapshotCompletedEventId, kind: 'invocation-completed',
                payload: { status: 'completed', completedAt: Date.now() } }
            ], 0)
          } else {
            const snapshot = existingSnapshot.events.find(({ kind }) => kind === 'transcript-compacted')
            if (!snapshot || stableJson(snapshot.payload) !== stableJson(snapshotPayload)) throw new Error('LEGACY_COMPACTION_BACKFILL_IDEMPOTENCY_CONFLICT')
            const terminal = existingSnapshot.events.at(-1)
            if (existingSnapshot.version === 1 && terminal?.kind === 'transcript-compacted') {
              await execution.historyFor({ sessionId }).appendBatch([{ invocationId: snapshotInvocationId, turnId: snapshotInvocationId,
                sequence: 2, schemaVersion: 1, eventId: snapshotCompletedEventId, idempotencyKey: snapshotCompletedEventId,
                kind: 'invocation-completed', payload: { status: 'completed', completedAt: Date.now() } }], existingSnapshot.version)
            } else if (existingSnapshot.version !== 2 || terminal?.kind !== 'invocation-completed' ||
              (terminal.payload as { status?: unknown }).status !== 'completed') throw new Error('LEGACY_COMPACTION_BACKFILL_IDEMPOTENCY_CONFLICT')
          }
        }
      }
    }
    const refreshedCanonicalReplay = queries.readCanonicalCompactionReplay(sessionId) ?? canonicalReplay
    const finalBackfillState = readBackfillCompletionState(refreshedCanonicalReplay.committed)
    const refreshedCanonicalIds = new Set(refreshedCanonicalReplay.committed.map(({ compactionId }) => compactionId))
    const stillHasLegacyOnlyCompaction = fileReplay.committed.some(({ compactionId }) => !refreshedCanonicalIds.has(compactionId) && !rejectedIds.has(compactionId))
    // Keep the file replay as the ordered compatibility source while it contains pre-canonical facts.
    // Once every file fact has a canonical owner, History supplies the replay without a JSONL dependency.
    const replay = stillHasLegacyOnlyCompaction ? fileReplay : refreshedCanonicalReplay
    const replayCommittedIds = new Set(replay.committed.map(({ compactionId }) => compactionId))
    const rejectedByIdentity = new Map<string, CompactionReplay['rejected'][number]>()
    for (const rejected of [...refreshedCanonicalReplay.rejected, ...(fileReplay.rejected ?? [])]) {
      if (rejected.compactionId && replayCommittedIds.has(rejected.compactionId)) throw new Error('CANONICAL_COMPACTION_REPLAY_INVALID')
      rejectedByIdentity.set(`${rejected.compactionId ?? ''}\u0000${rejected.reason}`, rejected)
    }
    const canonicalCompactions = new Map(refreshedCanonicalReplay.committed.map((record) => [record.compactionId, record]))
    const compactionsCovered = fileReplay.committed.every((record) => {
      const canonical = canonicalCompactions.get(record.compactionId)
      return canonical !== undefined && stableLedgerJson(canonical.start.payload) === stableLedgerJson(record.start.payload) &&
        stableLedgerJson(canonical.summary.payload) === stableLedgerJson(record.summary.payload)
    })
    let canCompleteMerge = false
    let sourceDrift = false
    if (!stillHasLegacyOnlyCompaction && !finalBackfillState.hasPartialCanonicalBackfill && !finalBackfillState.hasBackfillWithoutCurrentSnapshot &&
      compactionsCovered && (fileReplay.rejected?.length ?? 0) === 0) {
      const fileMeterEvents = sourceEvents.filter(({ type }) =>
        type === 'request_header' || type === 'request_context' || type === 'request_usage' || type === 'request_retry')
        .map(({ seq, type, payload }) => ({ seq, type, payload })) as CanonicalContextMeterEvent[]
      const canonicalMeterEvents = queries.readCanonicalContextMeterEvents(sessionId) ?? []
      const canonicalByIdentity = new Map(canonicalMeterEvents.map((event) => [contextMeterEventIdentity(event), event]))
      const meterFactsCovered = fileMeterEvents.every((event) => {
        const canonical = canonicalByIdentity.get(contextMeterEventIdentity(event))
        return canonical !== undefined && stableLedgerJson(canonical.payload) === stableLedgerJson(event.payload)
      })
      const sourceStillSame = sourceReadable && sourceRevision === await readSessionLedgerSourceRevision(sink.eventsPath)
      sourceDrift = sourceReadable && !sourceStillSame
      canCompleteMerge = meterFactsCovered && sourceStillSame
    }
    return { replay: { ...replay, rejected: [...rejectedByIdentity.values()] }, sourceRevision, canCompleteMerge, sourceDrift }
    })
    if (conversion.sourceDrift && sourceRetry < 2) return readCompactionReplayForLocation(sessionId, workDir, sourceRetry + 1)
    if (conversion.canCompleteMerge && options.ensureSessionLedgerReady) {
      let mergeReady = false
      try { mergeReady = ledgerCheckReady(await options.ensureSessionLedgerReady({ session, workDir })) }
      catch { mergeReady = false }
      let sourceStable = true
      if (mergeReady) await withSessionEventWriterDrain(workDir, session.id, async () => {
        sourceStable = conversion.sourceRevision === await readSessionLedgerSourceRevision(sink.eventsPath)
        if (sourceStable) {
          markLegacyLedgerMergeCompleted(getDbConnection(db), location, session.generation)
        }
      })
      if (mergeReady && !sourceStable && sourceRetry < 2) return readCompactionReplayForLocation(sessionId, workDir, sourceRetry + 1)
    }
    return { replay: conversion.replay, sink, canPersist: true }
    })
  }
  const readContextMeterEventsForLocation = async (sessionId: string, workDir: string): Promise<readonly CanonicalContextMeterEvent[]> => {
    const session = queries.readSession(sessionId)
    if (!session) throw new Error('SESSION_NOT_FOUND')
    const location = { workDir, sessionId: session.id, createdAt: session.createdAt }
    return withSessionLedgerLifecycleLock(sessionLedgerLocationIdentity(location).key, async () => {
    let readinessResult: boolean | { ready: boolean; canonicalReadVersion: number | null } = true
    if (options.ensureSessionLedgerReady) {
      try {
        readinessResult = await options.ensureSessionLedgerReady({ session, workDir })
        if (!ledgerCheckReady(readinessResult)) {
          return queries.readCanonicalContextMeterEvents(sessionId) ?? []
        }
      } catch {
        return queries.readCanonicalContextMeterEvents(sessionId) ?? []
      }
    }
    const readVersion = ledgerCheckReadVersion(readinessResult)
    if (readVersion === 1 || (readVersion === undefined && isCanonicalReadLocation(location, session.generation))) {
      return queries.readCanonicalContextMeterEvents(sessionId) ?? []
    }
    const sink = (options.getSessionEventSink ?? getSessionEventSink)(workDir, session.id, session.createdAt)
    const fileEvents = (await readSessionEvents(sink.eventsPath)).filter(({ type }) =>
      type === 'request_header' || type === 'request_context' || type === 'request_usage' || type === 'request_retry')
      .map(({ seq, time, type, payload }) => ({ seq, time, type, payload })) as Array<CanonicalContextMeterEvent & { time: number }>
    const canonicalEvents = queries.readCanonicalContextMeterEvents(sessionId) ?? []
    const importPlan = buildLegacyMeterImportEvents(location, fileEvents, canonicalEvents)
    if (!importPlan.complete) return fileEvents
    if (importPlan.events.length > 0) {
      const history = execution.historyFor({ sessionId })
      const existing = await history.read(importPlan.invocationId)
      if (existing.version === 0) await history.appendBatch(importPlan.events, 0)
      else if (stableLedgerJson(existing.events) !== stableLedgerJson(importPlan.events)) {
        throw new Error('SESSION_LEDGER_LEGACY_METER_IMPORT_CONFLICT')
      }
    }
    const mergedEvents = queries.readCanonicalContextMeterEvents(sessionId)
    if (!mergedEvents) return fileEvents
    const mergedByIdentity = new Map(mergedEvents.map((event) => [contextMeterEventIdentity(event), event]))
    const allFactsMerged = fileEvents.every((event) => {
      const merged = mergedByIdentity.get(contextMeterEventIdentity(event))
      return merged !== undefined && stableLedgerJson(merged.payload) === stableLedgerJson(event.payload)
    })
    if (allFactsMerged) {
      // The replay path also imports any legacy-only compression record and is the single place
      // that can certify the location-wide canonical read cutover.
      await readCompactionReplayForLocation(sessionId, workDir)
      if (isCanonicalReadLocation(location, session.generation)) return queries.readCanonicalContextMeterEvents(sessionId) ?? []
      const currentFileEvents = await withSessionEventWriterDrain(workDir, session.id, () => readSessionEvents(sink.eventsPath))
        .then((events) => events.filter(({ type }) => type === 'request_header' || type === 'request_context' || type === 'request_usage' || type === 'request_retry')
          .map(({ seq, time, type, payload }) => ({ seq: time * 4096 + (seq % 4096), type, payload })) as CanonicalContextMeterEvent[])
      return mergeCanonicalAndLegacyMeterEvents(queries.readCanonicalContextMeterEvents(sessionId) ?? [], currentFileEvents)
    }
    return fileEvents
    })
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
  const availability = Object.freeze({
    inspect: (sessionId: string) => runInTransaction(getDbConnection(db), () => {
      const session = queries.readSession(sessionId)
      const maintenanceTasks = (options.inspectMaintenance?.() ?? []).map(({ taskId, category, status }) => ({ taskId, category, status }))
      const maintenanceState = maintenanceTasks.some(({ status }) => status === 'failed') ? 'blocked' as const
        : maintenanceTasks.some(({ status }) => status === 'paused') ? 'paused' as const : 'available' as const
      const maintenanceSource = Object.freeze(maintenanceTasks.map(({ taskId, status }) => Object.freeze({ taskId, status })))
      if (!session) return Object.freeze({
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
      let executionState: 'ready' | 'busy' | 'commit-uncertain' | 'blocked'
      if (transcript.status === 'commit_uncertain') executionState = 'commit-uncertain'
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
    if (!session || !workDir || !options.ensureSessionLedgerReady) return !options.ensureSessionLedgerReady
    const ready = await options.ensureSessionLedgerReady({ session, workDir })
    return ledgerCheckReady(ready)
  }
  const readCompactionReplayForSession = async (input: Readonly<{ sessionId: string; workDir: string }>): Promise<CompactionReplay> =>
    (await readCompactionReplayForLocation(input.sessionId, input.workDir)).replay
  const readContextMeterEventsForSession = async (input: Readonly<{ sessionId: string; workDir: string }>): Promise<readonly CanonicalContextMeterEvent[]> =>
    readContextMeterEventsForLocation(input.sessionId, input.workDir)
  const storagePorts: SessionStorage = {
    queries, commands: createSessionCommands(db), execution, contexts, availability, ensureLedgerReady,
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

function mergeCanonicalAndLegacyMeterEvents(canonicalEvents: readonly CanonicalContextMeterEvent[],
  fileEvents: readonly CanonicalContextMeterEvent[]): CanonicalContextMeterEvent[] {
  const merged = new Map(canonicalEvents.map((event) => [contextMeterEventIdentity(event), event]))
  for (const event of fileEvents) {
    const identity = contextMeterEventIdentity(event)
    const canonical = merged.get(identity)
    if (canonical && stableLedgerJson(canonical.payload) !== stableLedgerJson(event.payload)) {
      throw new Error('SESSION_LEDGER_LEGACY_METER_CONFLICT')
    }
    if (!canonical) merged.set(identity, event)
  }
  return [...merged.values()].sort((left, right) => left.seq - right.seq)
}

function stableLedgerJson(value: unknown): string {
  const canonicalize = (item: unknown): unknown => Array.isArray(item) ? item.map(canonicalize)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, canonicalize(nested)])) : item
  return JSON.stringify(canonicalize(value))
}

async function readSessionLedgerSourceRevision(eventsPath: string): Promise<string> {
  const events = await readSessionEvents(eventsPath)
  return sessionLedgerSourceRevision(events)
}

function sessionLedgerSourceRevision(events: readonly unknown[]): string {
  return createHash('sha256').update(stableLedgerJson(events)).digest('hex')
}

function buildLegacyMeterImportEvents(location: { workDir: string; sessionId: string; createdAt: number },
  fileEvents: readonly CanonicalContextMeterEvent[], canonicalEvents: readonly CanonicalContextMeterEvent[]):
  { invocationId: string; events: HistoryEvent[]; complete: boolean } {
  type Source = { seq: number; time: number }
  type Fact = { kind: 'model-request-started' | 'provider-retry-scheduled' | 'provider-attempt-result';
    requestId: string; attempt: number; source: Source; payload: Record<string, unknown> }
  const invocationId = `legacy-meter-import:${sessionLedgerLocationIdentity(location).key}`
  const facts: Fact[] = []
  const headers = new Map<string, CanonicalContextMeterEvent>()
  const contexts = new Map<string, CanonicalContextMeterEvent>()
  const canonicalByIdentity = new Map(canonicalEvents.map((event) => [contextMeterEventIdentity(event), event]))
  const fileByIdentity = new Map<string, CanonicalContextMeterEvent>()
  for (const event of fileEvents) {
    const identity = contextMeterEventIdentity(event)
    const previous = fileByIdentity.get(identity)
    if (previous && stableLedgerJson(previous.payload) !== stableLedgerJson(event.payload)) return { invocationId, events: [], complete: false }
    fileByIdentity.set(identity, event)
    const canonical = canonicalByIdentity.get(identity)
    if (canonical && stableLedgerJson(canonical.payload) !== stableLedgerJson(event.payload)) {
      throw new Error('SESSION_LEDGER_LEGACY_METER_CONFLICT')
    }
    const requestId = event.payload.requestId
    const attempt = event.payload.attempt
    if (event.type !== 'request_usage' && (typeof requestId !== 'string' || !requestId || !Number.isInteger(attempt) || Number(attempt) < 1)) {
      return { invocationId, events: [], complete: false }
    }
    const key = `${String(requestId ?? '')}\u0000${String(attempt ?? 1)}`
    if (event.type === 'request_header') headers.set(key, event)
    else if (event.type === 'request_context' && event.payload.projectionStage !== 'final') contexts.set(key, event)
  }
  const source = (event: CanonicalContextMeterEvent): Source => {
    const raw = event as CanonicalContextMeterEvent & { time?: unknown }
    return { seq: event.seq, time: typeof raw.time === 'number' && Number.isSafeInteger(raw.time) ? raw.time : Date.now() }
  }
  const accounted = new Set<string>()
  for (const [key, header] of headers) {
    const context = contexts.get(key)
    if (!context) return { invocationId, events: [], complete: false }
    const headerCovered = canonicalByIdentity.has(contextMeterEventIdentity(header))
    const contextCovered = canonicalByIdentity.has(contextMeterEventIdentity(context))
    if (headerCovered !== contextCovered) return { invocationId, events: [], complete: false }
    if (!headerCovered) {
      const requestId = String(header.payload.requestId)
      const attempt = Number(header.payload.attempt)
      const contextSource = source(context)
      facts.push({ kind: 'model-request-started', requestId, attempt,
        source: source(header).seq <= contextSource.seq ? source(header) : contextSource,
        payload: { requestId, modelTurn: 1, attempt, legacyMeterImport: true,
          sessionLedger: { location, requestHeader: header.payload, requestContext: context.payload,
            legacyMeterSources: { requestHeader: source(header), requestContext: contextSource } } } })
    }
    accounted.add(contextMeterEventIdentity(header))
    accounted.add(contextMeterEventIdentity(context))
  }
  for (const event of fileEvents) {
    const identity = contextMeterEventIdentity(event)
    if (accounted.has(identity) || canonicalByIdentity.has(identity)) continue
    const requestId = String(event.payload.requestId ?? '')
    const attempt = Number(event.payload.attempt ?? 1)
    if (!requestId) return { invocationId, events: [], complete: false }
    if (event.type === 'request_retry') {
      facts.push({ kind: 'provider-retry-scheduled', requestId, attempt, source: source(event),
        payload: { requestId, modelTurn: 1, retryAttempt: attempt, legacyMeterImport: true,
          sessionLedger: { location, requestRetry: event.payload, legacyMeterSource: source(event) } } })
    } else if (event.type === 'request_usage') {
      facts.push({ kind: 'provider-attempt-result', requestId, attempt, source: source(event),
        payload: { requestId, modelTurn: 1, attempt, legacyMeterImport: true,
          sessionLedger: { location, requestUsage: event.payload, legacyMeterSource: source(event) } } })
    } else if (event.type === 'request_context' && event.payload.projectionStage === 'final') {
      facts.push({ kind: 'provider-attempt-result', requestId, attempt, source: source(event),
        payload: { requestId, modelTurn: 1, attempt, legacyMeterImport: true,
          sessionLedger: { location, requestFinalContext: event.payload, legacyMeterSource: source(event) } } })
    }
  }
  facts.sort((a, b) => a.source.seq - b.source.seq || a.source.time - b.source.time || a.kind.localeCompare(b.kind))
  const events = facts.map((fact, index) => {
    const sequence = index + 1
    const eventId = `${invocationId}:fact:${createHash('sha256').update(stableLedgerJson({ fact, sequence })).digest('hex').slice(0, 24)}`
    return { invocationId, turnId: invocationId, sequence, schemaVersion: 1,
      eventId, idempotencyKey: eventId, kind: fact.kind, payload: fact.payload } as HistoryEvent
  })
  if (events.length > 0) {
    const sequence = events.length + 1
    const eventId = `${invocationId}:completed`
    events.push({ invocationId, turnId: invocationId, sequence, schemaVersion: 1, eventId,
      idempotencyKey: eventId, kind: 'invocation-completed', payload: { status: 'completed',
        completedAt: facts.reduce((latest, fact) => Math.max(latest, fact.source.time), 0), legacyMeterImport: true } })
  }
  return { invocationId, events, complete: fileByIdentity.size === fileEvents.length }
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
      storage.execution.invalidateHostedContext(sessionId)
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
