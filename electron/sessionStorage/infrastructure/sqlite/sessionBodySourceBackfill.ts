import { randomUUID } from 'node:crypto'
import type { AppDatabase } from '../../../database/sqliteStore'
import { getDbConnection } from '../../../database/sqliteStore'
import { runInTransaction } from '../../../database/transaction'
import type { ProjectionInvocationBodySources } from './projectionChatBodySourceReducer'
import { readProjectionSourceIdentity } from './projectionSourceIdentity'
import { publishProjectionInvocationSourceArtifacts } from './projectionSourceArtifactPublisher'
import type { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'

type BlobStore = ReturnType<typeof createSessionProjectionBlobStore>
type BackfillCheckpoint = Readonly<{
  formatVersion: 1
  runId: string
  sessionGeneration: string
  sourceRevision: number
  historyWatermarkJson: string
  reducerSpecVersion: number
  lastInvocationId: string | null
  lastSessionSequence: number
}>

/** Background owner for one whole-session locator rebuild. Partial locators remain unreadable until final parity. */
export async function runSessionBodySourceBackfill(input: Readonly<{
  db: AppDatabase
  blobs: BlobStore
  sessionId: string
  reducerSpecVersion: number
  sources: AsyncIterable<ProjectionInvocationBodySources>
  now?: () => number
}>): Promise<Readonly<{ kind: 'complete'; invocationCount: number; messageCount: number }>> {
  if (!input.sessionId || !Number.isSafeInteger(input.reducerSpecVersion) || input.reducerSpecVersion < 1) {
    throw new Error('PROJECTION_SOURCE_BACKFILL_INPUT_INVALID')
  }
  const conn = getDbConnection(input.db)
  const session = conn.prepare('SELECT generation FROM sessions WHERE id=?').get(input.sessionId) as { generation: string } | undefined
  if (!session) throw new Error('SESSION_NOT_FOUND')
  const sessionGeneration = session.generation
  const sourceIdentityJson = readProjectionSourceIdentity(conn, input.sessionId, sessionGeneration)
  if (!sourceIdentityJson) throw new Error('PROJECTION_SOURCE_IDENTITY_UNAVAILABLE')
  const identity = JSON.parse(sourceIdentityJson) as { sourceRevision?: unknown; historyWatermark?: unknown }
  if (!Number.isSafeInteger(identity.sourceRevision) || !(identity.historyWatermark === null ||
    (Array.isArray(identity.historyWatermark) && Number.isSafeInteger(identity.historyWatermark[0])))) {
    throw new Error('PROJECTION_SOURCE_IDENTITY_INVALID')
  }
  const sourceRevision = identity.sourceRevision as number
  const historyWatermarkJson = JSON.stringify(identity.historyWatermark)
  const historyWatermarkSequence = Array.isArray(identity.historyWatermark) ? identity.historyWatermark[0] as number : 0
  const runId = randomUUID()
  let checkpoint: BackfillCheckpoint = Object.freeze({ formatVersion: 1, runId, sessionGeneration, sourceRevision,
    historyWatermarkJson, reducerSpecVersion: input.reducerSpecVersion, lastInvocationId: null, lastSessionSequence: 0 })
  const encodeCheckpoint = () => JSON.stringify(checkpoint)

  runInTransaction(conn, () => {
    if (readProjectionSourceIdentity(conn, input.sessionId, sessionGeneration) !== sourceIdentityJson) {
      throw new Error('PROJECTION_SOURCE_REVISION_CHANGED')
    }
    const state = conn.prepare('SELECT source_revision FROM session_body_source_state WHERE session_id=?').get(input.sessionId) as
      { source_revision: number } | undefined
    if (!state || state.source_revision !== sourceRevision) throw new Error('PROJECTION_SOURCE_REVISION_CHANGED')
    conn.prepare(`UPDATE session_body_source_state SET status='backfilling',checkpoint_json=?,updated_at=? WHERE session_id=?`)
      .run(encodeCheckpoint(), (input.now ?? Date.now)(), input.sessionId)
    conn.prepare('DELETE FROM session_message_body_locator WHERE session_id=?').run(input.sessionId)
    conn.prepare('DELETE FROM session_body_source_manifest WHERE session_id=?').run(input.sessionId)
  })

  let invocationCount = 0
  let previousSessionSequence = 0
  for await (const source of input.sources) {
    if (!source || typeof source.invocationId !== 'string' || !source.invocationId || source.dependencies.length < 1 ||
      !Number.isSafeInteger(source.workerThreadId) || source.workerThreadId! <= 0 || !source.workerSample ||
      source.dependencies[0]!.sessionSequence <= previousSessionSequence) throw new Error('PROJECTION_SOURCE_BACKFILL_ORDER_INVALID')
    const lastSessionSequence = source.dependencies.at(-1)!.sessionSequence
    if (!Number.isSafeInteger(lastSessionSequence) || lastSessionSequence <= previousSessionSequence ||
      lastSessionSequence > historyWatermarkSequence) throw new Error('PROJECTION_SOURCE_BACKFILL_ORDER_INVALID')
    checkpoint = Object.freeze({ ...checkpoint, lastInvocationId: source.invocationId, lastSessionSequence })
    const checkpointJson = encodeCheckpoint()
    await publishProjectionInvocationSourceArtifacts({ db: input.db, blobs: input.blobs, sessionId: input.sessionId,
      sessionGeneration, sourceRevision, sourceIdentityJson, historyWatermarkJson, reducerSpecVersion: input.reducerSpecVersion,
      source, checkpointJson, backfillRunId: runId })
    runInTransaction(conn, () => {
      if (readProjectionSourceIdentity(conn, input.sessionId, sessionGeneration) !== sourceIdentityJson) {
        throw new Error('PROJECTION_SOURCE_REVISION_CHANGED')
      }
      const state = conn.prepare('SELECT source_revision,status,checkpoint_json FROM session_body_source_state WHERE session_id=?')
        .get(input.sessionId) as { source_revision: number; status: string; checkpoint_json: string | null } | undefined
      let storedCheckpoint: BackfillCheckpoint | undefined
      try { storedCheckpoint = JSON.parse(state?.checkpoint_json ?? 'null') as BackfillCheckpoint | undefined } catch { /* rejected below */ }
      if (!state || state.source_revision !== sourceRevision || state.status !== 'backfilling' || storedCheckpoint?.runId !== runId) {
        throw new Error('PROJECTION_SOURCE_BACKFILL_LEASE_LOST')
      }
      if (state.checkpoint_json !== checkpointJson) conn.prepare(`UPDATE session_body_source_state SET checkpoint_json=?,updated_at=?
        WHERE session_id=? AND source_revision=? AND status='backfilling'`).run(checkpointJson, (input.now ?? Date.now)(), input.sessionId, sourceRevision)
    })
    previousSessionSequence = lastSessionSequence
    invocationCount += 1
  }

  let messageCount = 0
  runInTransaction(conn, () => {
    if (readProjectionSourceIdentity(conn, input.sessionId, sessionGeneration) !== sourceIdentityJson) {
      throw new Error('PROJECTION_SOURCE_REVISION_CHANGED')
    }
    const state = conn.prepare('SELECT source_revision,status,checkpoint_json FROM session_body_source_state WHERE session_id=?')
      .get(input.sessionId) as { source_revision: number; status: string; checkpoint_json: string | null } | undefined
    let storedCheckpoint: BackfillCheckpoint | undefined
    try { storedCheckpoint = JSON.parse(state?.checkpoint_json ?? 'null') as BackfillCheckpoint | undefined } catch { /* rejected below */ }
    if (!state || state.source_revision !== sourceRevision || state.status !== 'backfilling' || storedCheckpoint?.runId !== runId) {
      throw new Error('PROJECTION_SOURCE_BACKFILL_LEASE_LOST')
    }
    const canonical = conn.prepare('SELECT id,sequence FROM messages WHERE session_id=? ORDER BY sequence').all(input.sessionId) as
      Array<{ id: string; sequence: number }>
    const locators = conn.prepare('SELECT message_id AS id,sequence FROM session_message_body_locator WHERE session_id=? ORDER BY sequence')
      .all(input.sessionId) as Array<{ id: string; sequence: number }>
    if (canonical.length !== locators.length || canonical.some((message, index) =>
      message.id !== locators[index]?.id || message.sequence !== locators[index]?.sequence)) {
      throw new Error('PROJECTION_SOURCE_BACKFILL_COVERAGE_MISMATCH')
    }
    messageCount = locators.length
    conn.prepare(`UPDATE session_body_source_state SET status='complete',checkpoint_json=NULL,updated_at=?
      WHERE session_id=? AND source_revision=? AND status='backfilling'`).run((input.now ?? Date.now)(), input.sessionId, sourceRevision)
  })
  return Object.freeze({ kind: 'complete', invocationCount, messageCount })
}
