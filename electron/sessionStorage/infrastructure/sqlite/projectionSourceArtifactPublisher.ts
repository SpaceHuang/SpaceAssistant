import { createHash } from 'node:crypto'
import type { AppDatabase } from '../../../database/sqliteStore'
import { getDbConnection } from '../../../database/sqliteStore'
import { runInTransaction } from '../../../database/transaction'
import { readProjectionSourceIdentity } from './projectionSourceIdentity'
import type { ProjectionInvocationBodySources } from './projectionChatBodySourceReducer'

type WrittenBlob = Readonly<{ locator: string; byteLength: number; payloadDigest: string; release(): Promise<void> }>
type BlobWriter = Readonly<{ writeMany(payloads: readonly string[]): Promise<readonly WrittenBlob[]> }>

/** Stage immutable invocation artifacts first, then publish locators only under a constant source fence. */
export async function publishProjectionInvocationSourceArtifacts(input: Readonly<{
  db: AppDatabase
  blobs: BlobWriter
  sessionId: string
  sessionGeneration: string
  sourceRevision: number
  sourceIdentityJson: string
  historyWatermarkJson: string
  reducerSpecVersion: number
  source: ProjectionInvocationBodySources
  checkpointJson?: string
  backfillRunId?: string
}>): Promise<void> {
  if (!input.sessionId || !input.sessionGeneration || !Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 0 ||
    !Number.isSafeInteger(input.reducerSpecVersion) || input.reducerSpecVersion < 1 ||
    input.source.dependencies.length < 1 || input.source.dependencies.some(({ eventId, sequence, schemaVersion, digest }) =>
      !eventId || !Number.isSafeInteger(sequence) || sequence < 1 || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1 ||
      !/^[a-f0-9]{64}$/.test(digest))) throw new Error('PROJECTION_SOURCE_ARTIFACT_INPUT_INVALID')
  const ids = input.source.messages.map(({ id }) => id)
  const sequences = input.source.messages.map(({ sequence }) => sequence)
  if (new Set(ids).size !== ids.length) throw new Error('PROJECTION_SOURCE_MESSAGE_ID_DUPLICATE')
  if (sequences.some((sequence) => !Number.isSafeInteger(sequence) || sequence < 0) || new Set(sequences).size !== sequences.length) {
    throw new Error('PROJECTION_SOURCE_SEQUENCE_DUPLICATE')
  }
  const expectedDependencyManifest = JSON.stringify({ formatVersion: 1, invocationId: input.source.invocationId,
    dependencies: input.source.dependencies })
  if (expectedDependencyManifest !== input.source.dependencyManifestJson ||
    sha256(expectedDependencyManifest) !== input.source.dependencyManifestDigest || ids.some((id) =>
      JSON.stringify(input.source.dependenciesByMessage.get(id)) !== JSON.stringify(input.source.dependencies) ||
      input.source.manifestDigestByMessage.get(id) !== input.source.dependencyManifestDigest)) {
    throw new Error('PROJECTION_SOURCE_DEPENDENCY_MANIFEST_INVALID')
  }
  const identities = JSON.parse(input.sourceIdentityJson) as { sessionGeneration?: unknown; sourceRevision?: unknown; historyWatermark?: unknown;
    messageRevision?: unknown }
  if (identities.sessionGeneration !== input.sessionGeneration || identities.sourceRevision !== input.sourceRevision ||
    JSON.stringify(identities.historyWatermark ?? null) !== input.historyWatermarkJson) throw new Error('PROJECTION_SOURCE_ARTIFACT_INPUT_INVALID')

  if (!input.source.messages.length) {
    if (!input.source.replacesPriorMessages) return
    const conn = getDbConnection(input.db)
    runInTransaction(conn, () => {
      assertSourceFence(conn, input)
      conn.prepare('DELETE FROM session_message_body_locator WHERE session_id=?').run(input.sessionId)
      conn.prepare('DELETE FROM session_body_source_manifest WHERE session_id=?').run(input.sessionId)
      if (input.checkpointJson) conn.prepare('UPDATE session_body_source_state SET checkpoint_json=?,updated_at=unixepoch()*1000 WHERE session_id=?')
        .run(input.checkpointJson, input.sessionId)
    })
    return
  }

  const schemaVersion = input.source.dependencies[0]!.schemaVersion
  if (input.source.dependencies.some((dependency) => dependency.schemaVersion !== schemaVersion)) {
    throw new Error('PROJECTION_SOURCE_ARTIFACT_SCHEMA_MISMATCH')
  }
  const manifestPayload = JSON.stringify({ formatVersion: 1, kind: 'chatBodyV1-source-manifest', sessionId: input.sessionId,
    sessionGeneration: input.sessionGeneration, sourceRevision: input.sourceRevision, messageRevision: identities.messageRevision ?? null,
    historyWatermarkJson: input.historyWatermarkJson, reducerSpecVersion: input.reducerSpecVersion,
    invocationId: input.source.invocationId, schemaVersion, dependencies: input.source.dependencies })
  const fragmentPayloads = input.source.messages.map((message) => JSON.stringify({ formatVersion: 1, kind: 'chatBodyV1-message',
    sessionId: input.sessionId, sessionGeneration: input.sessionGeneration, sourceRevision: input.sourceRevision,
    sequence: message.sequence, message: { id: message.id, role: message.role, content: message.content, timestamp: message.timestamp } }))
  const written = await input.blobs.writeMany([manifestPayload, ...fragmentPayloads])
  if (written.length !== input.source.messages.length + 1) {
    await written[0]?.release()
    throw new Error('PROJECTION_SOURCE_ARTIFACT_WRITE_INVALID')
  }
  try {
    const conn = getDbConnection(input.db)
    runInTransaction(conn, () => {
      assertSourceFence(conn, input)
      const existingManifest = conn.prepare('SELECT source_revision FROM session_body_source_manifest WHERE session_id=? AND invocation_id=?')
        .get(input.sessionId, input.source.invocationId) as { source_revision: number } | undefined
      if (existingManifest && existingManifest.source_revision !== input.sourceRevision) throw new Error('PROJECTION_SOURCE_REVISION_CHANGED')

      if (input.source.replacesPriorMessages) {
        conn.prepare('DELETE FROM session_message_body_locator WHERE session_id=?').run(input.sessionId)
        conn.prepare('DELETE FROM session_body_source_manifest WHERE session_id=?').run(input.sessionId)
      } else if (existingManifest) {
        const priorMessageIds = conn.prepare(`SELECT DISTINCT message_id FROM session_message_body_source_event
          WHERE session_id=? AND invocation_id=?`).all(input.sessionId, input.source.invocationId) as Array<{ message_id: string }>
        for (const { message_id: priorId } of priorMessageIds) {
          if (!ids.includes(priorId)) conn.prepare('DELETE FROM session_message_body_locator WHERE session_id=? AND message_id=?')
            .run(input.sessionId, priorId)
        }
        conn.prepare('DELETE FROM session_body_source_manifest WHERE session_id=? AND invocation_id=?')
          .run(input.sessionId, input.source.invocationId)
      }
      for (const id of ids) conn.prepare('DELETE FROM session_message_body_locator WHERE session_id=? AND message_id=?').run(input.sessionId, id)
      for (const message of input.source.messages) {
        const conflict = conn.prepare('SELECT message_id FROM session_message_body_locator WHERE session_id=? AND sequence=?')
          .get(input.sessionId, message.sequence) as { message_id: string } | undefined
        if (conflict) throw new Error('PROJECTION_SOURCE_SEQUENCE_DUPLICATE')
      }

      const manifestBlob = written[0]!
      conn.prepare(`INSERT INTO session_body_source_manifest(session_id,invocation_id,source_revision,manifest_locator,byte_length,sha256,
        history_watermark_json,schema_version) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(session_id,invocation_id) DO UPDATE SET
        source_revision=excluded.source_revision,manifest_locator=excluded.manifest_locator,byte_length=excluded.byte_length,
        sha256=excluded.sha256,history_watermark_json=excluded.history_watermark_json,schema_version=excluded.schema_version`)
        .run(input.sessionId, input.source.invocationId, input.sourceRevision, manifestBlob.locator, manifestBlob.byteLength,
          manifestBlob.payloadDigest, input.historyWatermarkJson, schemaVersion)
      const insertLocator = conn.prepare(`INSERT INTO session_message_body_locator(session_id,message_id,sequence,fragment_locator,byte_length,sha256)
        VALUES(?,?,?,?,?,?)`)
      const insertSourceEvent = conn.prepare(`INSERT INTO session_message_body_source_event(session_id,message_id,invocation_id,event_id,
        event_sequence,session_sequence,schema_version,kind,source_digest) VALUES(?,?,?,?,?,?,?,?,?)`)
      input.source.messages.forEach((message, index) => {
        const blob = written[index + 1]!
        insertLocator.run(input.sessionId, message.id, message.sequence, blob.locator, blob.byteLength, blob.payloadDigest)
        const dependencies = input.source.dependenciesByMessage.get(message.id)
        if (!dependencies || dependencies.length !== input.source.dependencies.length) throw new Error('PROJECTION_SOURCE_DEPENDENCY_INCOMPLETE')
        for (const dependency of dependencies) insertSourceEvent.run(input.sessionId, message.id, input.source.invocationId,
          dependency.eventId, dependency.sequence, dependency.sessionSequence, dependency.schemaVersion, dependency.kind, dependency.digest)
      })
      conn.prepare(`DELETE FROM session_body_source_manifest WHERE session_id=? AND NOT EXISTS (
        SELECT 1 FROM session_message_body_source_event refs WHERE refs.session_id=session_body_source_manifest.session_id
          AND refs.invocation_id=session_body_source_manifest.invocation_id)`).run(input.sessionId)
      if (input.checkpointJson) conn.prepare('UPDATE session_body_source_state SET checkpoint_json=?,updated_at=unixepoch()*1000 WHERE session_id=?')
        .run(input.checkpointJson, input.sessionId)
    })
  } finally {
    await written[0]!.release()
  }
}

function assertSourceFence(conn: ReturnType<typeof getDbConnection>, input: Readonly<{ sessionId: string; sessionGeneration: string;
  sourceRevision: number; sourceIdentityJson: string; backfillRunId?: string }>): void {
  if (readProjectionSourceIdentity(conn, input.sessionId, input.sessionGeneration) !== input.sourceIdentityJson) {
    throw new Error('PROJECTION_SOURCE_REVISION_CHANGED')
  }
  const state = conn.prepare('SELECT source_revision,status,checkpoint_json FROM session_body_source_state WHERE session_id=?')
    .get(input.sessionId) as { source_revision: number; status: string; checkpoint_json: string | null } | undefined
  if (!state || state.source_revision !== input.sourceRevision || !['pending', 'backfilling'].includes(state.status)) {
    throw new Error('PROJECTION_SOURCE_REVISION_CHANGED')
  }
  if (input.backfillRunId) {
    let checkpoint: { runId?: unknown } | undefined
    try { checkpoint = JSON.parse(state.checkpoint_json ?? 'null') as typeof checkpoint } catch { /* treated as stale owner */ }
    if (checkpoint?.runId !== input.backfillRunId) throw new Error('PROJECTION_SOURCE_BACKFILL_LEASE_LOST')
  }
}

function sha256(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}
