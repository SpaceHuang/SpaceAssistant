import type { AppDatabase } from '../../../database/sqliteStore'
import { getDbConnection } from '../../../database/sqliteStore'
import { currentProcessGeneration } from '../../../database/processGeneration'
import { runInTransaction } from '../../../database/transaction'
import { createHash, randomUUID } from 'node:crypto'
import { encodeProjectionScopeKey } from '../../domain/scopeKey'
import { createProjectionService } from '../../application/projectionService'
import { createSqliteProjectionStateStore } from './sessionProjectionStateStore'
import { readProjectionSourceIdentity } from './projectionSourceIdentity'

const API_ROUTE_SCOPE_KEYS = Object.freeze([
  encodeProjectionScopeKey({ scope: 'apiBaselineV1', specVersion: 1 }),
  encodeProjectionScopeKey({ scope: 'routeV1', specVersion: 1 }),
])

type FenceInput = Readonly<{
  sessionId: string
  sessionGeneration: string
  messageRevision: number
  historyWatermarkJson: string
}>

/** Read the paired durable API/route proof only when both scope payloads match the live source fence. */
export function createSqliteSessionApiRouteProjectionFence(db: AppDatabase) {
  const conn = getDbConnection(db)
  const isCurrent = (input: FenceInput): boolean => {
    if (!Number.isSafeInteger(input.messageRevision) || input.messageRevision < 0) return false
    const sourceIdentityJson = readProjectionSourceIdentity(conn, input.sessionId, input.sessionGeneration)
    if (!sourceIdentityJson) return false
    let source: { messageRevision?: unknown; historyWatermark?: unknown }
    try { source = JSON.parse(sourceIdentityJson) as typeof source } catch { return false }
    if (source.messageRevision !== input.messageRevision ||
      JSON.stringify(source.historyWatermark ?? null) !== input.historyWatermarkJson) return false

    const readScope = conn.prepare(`SELECT state.session_generation,state.status,state.message_revision,
        state.history_watermark_json,state.source_identity_json,state.payload_generation,state.payload_digest,state.validated_range_json,
        cache.payload_generation AS cache_payload_generation,cache.source_identity_json AS cache_source_identity_json,
        cache.payload_digest AS cache_payload_digest,cache.validated_range_json AS cache_validated_range_json,
        cache.inline_payload,cache.blob_locator,cache.blob_byte_length
      FROM session_projection_state state
      JOIN session_projection_cache cache ON cache.session_id=state.session_id AND cache.scope_key=state.scope_key
      WHERE state.session_id=? AND state.scope_key=?`)

    return API_ROUTE_SCOPE_KEYS.every((scopeKey) => {
      const row = readScope.get(input.sessionId, scopeKey) as Record<string, unknown> | undefined
      return !!row && row.session_generation === input.sessionGeneration && row.status === 'valid' &&
        row.message_revision === input.messageRevision && row.history_watermark_json === input.historyWatermarkJson &&
        row.source_identity_json === sourceIdentityJson && typeof row.payload_generation === 'string' &&
        typeof row.payload_digest === 'string' && typeof row.validated_range_json === 'string' &&
        row.cache_payload_generation === row.payload_generation && row.cache_source_identity_json === sourceIdentityJson &&
        row.cache_payload_digest === row.payload_digest && row.cache_validated_range_json === row.validated_range_json &&
        ((typeof row.inline_payload === 'string' && row.blob_locator === null && row.blob_byte_length === null) ||
          (row.inline_payload === null && typeof row.blob_locator === 'string' && Number.isSafeInteger(row.blob_byte_length) && Number(row.blob_byte_length) > 0))
    })
  }
  return Object.freeze({ isCurrent })
}

/** Publish the API and route candidates as a paired, source-fenced set of scope manifests. */
export function publishSqliteSessionApiRouteScopes(db: AppDatabase, input: FenceInput & Readonly<{
  apiBaseline: unknown
  route: unknown
}>): boolean {
  const conn = getDbConnection(db)
  const store = createSqliteProjectionStateStore(db)
  const processGeneration = currentProcessGeneration(conn)
  const service = createProjectionService(store, { processGeneration: () => processGeneration, connectionEpoch: () => 0,
    createToken: randomUUID, now: Date.now })
  try {
    return runInTransaction(conn, () => {
      const sourceIdentityJson = readProjectionSourceIdentity(conn, input.sessionId, input.sessionGeneration)
      if (!sourceIdentityJson) return false
      let source: { messageRevision?: unknown; historyWatermark?: unknown }
      try { source = JSON.parse(sourceIdentityJson) as typeof source } catch { return false }
      if (source.messageRevision !== input.messageRevision ||
        JSON.stringify(source.historyWatermark ?? null) !== input.historyWatermarkJson) return false

      for (const [index, scopeKey] of API_ROUTE_SCOPE_KEYS.entries()) {
        const current = store.get(input.sessionId, scopeKey)
        if (current) service.invalidateInTransaction({ sessionId: input.sessionId, scopeKey, sessionGeneration: input.sessionGeneration })
        else service.ensureInvalid({ sessionId: input.sessionId, scopeKey, sessionGeneration: input.sessionGeneration })
        const lease = service.beginRebuild({ sessionId: input.sessionId, scopeKey, sessionGeneration: input.sessionGeneration })
        if (!lease || lease.sourceIdentityJson !== sourceIdentityJson) throw new Error('API_ROUTE_SCOPE_REBUILD_CLAIM_FAILED')
        const payload = JSON.stringify(index === 0 ? input.apiBaseline : input.route)
        const payloadDigest = createHash('sha256').update(payload).digest('hex')
        const published = service.publish(lease, {
          sourceIdentityJson, payloadGeneration: randomUUID(), payloadDigest,
          validatedRangeJson: JSON.stringify({ messageRevision: input.messageRevision, historyWatermarkJson: input.historyWatermarkJson }),
          inlinePayload: payload,
        })
        if (published?.status !== 'valid') throw new Error('API_ROUTE_SCOPE_PUBLISH_FAILED')
      }
      return true
    })
  } catch {
    return false
  }
}
