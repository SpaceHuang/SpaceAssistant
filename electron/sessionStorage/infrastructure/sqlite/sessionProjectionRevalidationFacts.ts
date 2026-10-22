import { createHash } from 'node:crypto'
import type { Message } from '../../../../src/shared/domainTypes'
import type { ClaudeChatMessageWithBlocks } from '../../../../src/shared/api'
import { getMessageSkeletons, getMessages } from '../../../database/operations'
import type { AppDatabase } from '../../../database/sqliteStore'
import { getDbConnection } from '../../../database/sqliteStore'
import { SqliteAgentHistory } from '../../../runtime/sqliteAgentHistory'
import { currentProcessGeneration } from '../../../database/processGeneration'
import { randomUUID } from 'node:crypto'
import { runInTransaction } from '../../../database/transaction'
import type { CanonicalSessionTranscriptRead } from '../../../runtime/sqliteAgentHistory'
import { encodeProjectionScopeKey } from '../../domain/scopeKey'
import { createProjectionService } from '../../application/projectionService'
import { createSqliteProjectionStateStore } from './sessionProjectionStateStore'

/** Read the complete legacy projection input owned by the SQLite adapter. */
export function readLegacyProjectionMessages(db: AppDatabase, sessionId: string) {
  return getMessages(db, sessionId, Number.MAX_SAFE_INTEGER)
}

/** Fingerprint canonical event payloads in their durable per-session order. */
export function computeCanonicalProjectionFingerprint(db: AppDatabase, sessionId: string): string {
  const hash = createHash('sha256')
  for (const row of getDbConnection(db).prepare(
    'SELECT payload_json FROM agent_history_events WHERE session_id=? ORDER BY session_seq ASC'
  ).iterate(sessionId) as Iterable<{ payload_json: string }>) {
    hash.update(row.payload_json).update('\n')
  }
  return hash.digest('hex')
}

/** Persist only the parity certificate produced by a full canonical-vs-legacy transcript comparison. */
export function publishTranscriptParityProof(db: AppDatabase, sessionId: string,
  verified: Extract<CanonicalSessionTranscriptRead, { kind: 'matched' }>, parityDigest: string): boolean {
  if (verified.sessionId !== sessionId || !/^[a-f0-9]{64}$/.test(parityDigest)) return false
  const conn = getDbConnection(db)
  const scopeKey = encodeProjectionScopeKey({ scope: 'transcriptParityV1', specVersion: 1 })
  const store = createSqliteProjectionStateStore(db)
  const service = createProjectionService(store, { processGeneration: () => currentProcessGeneration(conn), connectionEpoch: () => 0,
    createToken: randomUUID, now: Date.now })
  try {
    return runInTransaction(conn, () => {
      const sourceIdentityJson = store.readSourceIdentity(sessionId, verified.sessionGeneration)
      if (!sourceIdentityJson) return false
      const source = JSON.parse(sourceIdentityJson) as { historyWatermark?: unknown }
      const verifiedWatermark = verified.sessionSeq < 1 ? null : [verified.sessionSeq, verified.commitOrder,
        verified.watermarkEventId, verified.watermarkInvocationId]
      if (JSON.stringify(source.historyWatermark ?? null) !== JSON.stringify(verifiedWatermark)) return false
      const canonicalFingerprint = computeCanonicalProjectionFingerprint(db, sessionId)
      const payload = JSON.stringify({ formatVersion: 1, parityDigest, canonicalFingerprint,
        eventCount: verified.eventCount, messageCount: verified.messages.length })
      const payloadDigest = createHash('sha256').update(payload).digest('hex')
      const current = store.get(sessionId, scopeKey)
      if (current) service.invalidateInTransaction({ sessionId, scopeKey, sessionGeneration: verified.sessionGeneration })
      else service.ensureInvalid({ sessionId, scopeKey, sessionGeneration: verified.sessionGeneration })
      const lease = service.beginRebuild({ sessionId, scopeKey, sessionGeneration: verified.sessionGeneration })
      if (!lease || lease.sourceIdentityJson !== sourceIdentityJson) return false
      return service.publish(lease, { sourceIdentityJson, payloadGeneration: `parity-${payloadDigest}`, payloadDigest,
        validatedRangeJson: JSON.stringify({ formatVersion: 1, historyWatermark: verifiedWatermark,
          messageRevision: JSON.parse(sourceIdentityJson).messageRevision }), inlinePayload: payload })?.status === 'valid'
    })
  } catch { return false }
}

/** Read the current-generation eligibility fact through the storage-owned SQLite adapter. */
export function hasCurrentProjectionEligibility(db: AppDatabase, sessionId: string): boolean {
  try {
    const scopeKey = encodeProjectionScopeKey({ scope: 'transcriptParityV1', specVersion: 1 })
    const conn = getDbConnection(db)
    const row = conn.prepare(`SELECT state.session_generation,state.source_identity_json,state.payload_generation,state.payload_digest,
        state.validated_range_json,cache.source_identity_json AS cache_source_identity_json,
        cache.payload_generation AS cache_payload_generation,cache.payload_digest AS cache_payload_digest,
        cache.validated_range_json AS cache_validated_range_json,cache.inline_payload
      FROM session_projection_state state JOIN session_projection_cache cache
        ON cache.session_id=state.session_id AND cache.scope_key=state.scope_key
      JOIN sessions ON sessions.id=state.session_id AND sessions.generation=state.session_generation
      WHERE state.session_id=? AND state.scope_key=? AND state.status='valid'`).get(sessionId, scopeKey) as Record<string, unknown> | undefined
    if (!row || typeof row.source_identity_json !== 'string' || row.cache_source_identity_json !== row.source_identity_json ||
      row.payload_generation !== row.cache_payload_generation || row.payload_digest !== row.cache_payload_digest ||
      row.validated_range_json !== row.cache_validated_range_json || typeof row.inline_payload !== 'string') return false
    if (createSqliteProjectionStateStore(db).readSourceIdentity(sessionId, String(row.session_generation)) !== row.source_identity_json ||
      createHash('sha256').update(row.inline_payload).digest('hex') !== row.payload_digest) return false
    const proof = JSON.parse(row.inline_payload) as Record<string, unknown>
    return proof.formatVersion === 1 && typeof proof.parityDigest === 'string' && typeof proof.canonicalFingerprint === 'string'
  } catch { return false }
}

function mergeCanonicalBodies(canonicalMessages: readonly ClaudeChatMessageWithBlocks[],
  skeletons: ReadonlyArray<Omit<Message, 'content'>>): Message[] | undefined {
  if (canonicalMessages.length !== skeletons.length) return undefined
  const canonicalById = new Map(canonicalMessages.map((message) => [message.id, message]))
  const projected: Message[] = []
  for (const legacy of skeletons) {
    const message = canonicalById.get(legacy.id)
    if (!message || message.id !== legacy.id || message.role !== legacy.role || typeof message.content !== 'string' ||
      typeof message.timestamp !== 'number') return undefined
    projected.push({ ...legacy, id: message.id, role: message.role, content: message.content, timestamp: message.timestamp })
  }
  return projected
}

/** Cheap L1 fast path shared by revalidation and the terminal checkpoint, without a legacy full scan. */
export function refreshValidatedProjectionFastPath(db: AppDatabase, sessionId: string): boolean {
  const history = new SqliteAgentHistory(getDbConnection(db))
  const canonical = history.readCanonicalSessionTranscriptWithCache(sessionId, 'transcript')
  const skeletons = getMessageSkeletons(db, sessionId)
  return canonical.kind === 'matched' && hasCurrentProjectionEligibility(db, sessionId) &&
    mergeCanonicalBodies(canonical.messages, skeletons) !== undefined
}

/** Compare the supplied validated legacy transcript and cache only a canonical match. */
export function validateAndCacheCanonicalProjection(db: AppDatabase, sessionId: string,
  legacyMessages: ReadonlyArray<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }>) {
  const history = new SqliteAgentHistory(getDbConnection(db))
  const verified = history.readCanonicalSessionTranscript(sessionId, legacyMessages)
  const cacheWritten = verified.kind === 'matched' && history.writeCanonicalSessionCache({
    ...verified, cacheKey: 'transcript', value: JSON.stringify(verified.messages)
  })
  return { verified, cacheWritten }
}
