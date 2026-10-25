import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createSession } from '../../../database/operations'
import { createMemoryAppDb, createTempDatabase } from '../../../database/testHelpers'
import { getDbConnection, reopenDatabaseConnection } from '../../../database/sqliteStore'
import { encodeProjectionScopeKey } from '../../domain/scopeKey'
import { createSqliteProjectionStateStore } from './sessionProjectionStateStore'
import { createSqliteSessionApiRouteProjectionFence, publishSqliteSessionApiRouteScopes } from './sessionApiRouteProjectionFence'

describe('SQLite API and route projection fence', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined
  afterEach(() => { db?.close(); db = undefined })

  it('resolves the active connection after same-object database reopen', () => {
    const temp = createTempDatabase('api-route-fence-reopen-')
    try {
      const session = createSession(temp.db, { name: 'API route fence reopen', model: 'test' })
      const sourceIdentityJson = createSqliteProjectionStateStore(temp.db).readSourceIdentity(session.id, session.generation)!
      const historyWatermarkJson = JSON.stringify((JSON.parse(sourceIdentityJson) as { historyWatermark: unknown }).historyWatermark)
      const fence = createSqliteSessionApiRouteProjectionFence(temp.db)
      temp.db.close()
      reopenDatabaseConnection(temp.db)

      expect(() => fence.isCurrent({ sessionId: session.id, sessionGeneration: session.generation,
        messageRevision: 0, historyWatermarkJson })).not.toThrow()
    } finally {
      temp.cleanup()
    }
  })

  it('requires both valid scope manifests to match current generation, revision, source and history watermark', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'API route projection fence', model: 'test' })
    const conn = getDbConnection(db)
    const sourceIdentityJson = createSqliteProjectionStateStore(db).readSourceIdentity(session.id, session.generation)!
    const historyWatermarkJson = JSON.stringify((JSON.parse(sourceIdentityJson) as { historyWatermark: unknown }).historyWatermark)
    const fence = createSqliteSessionApiRouteProjectionFence(db)

    expect(fence.isCurrent({ sessionId: session.id, sessionGeneration: session.generation, messageRevision: 0, historyWatermarkJson })).toBe(false)

    const scopes = [encodeProjectionScopeKey({ scope: 'apiBaselineV1', specVersion: 1 }),
      encodeProjectionScopeKey({ scope: 'routeV1', specVersion: 1 })]
    for (const scopeKey of scopes) {
      const proof = JSON.stringify({ formatVersion: 1, kind: 'canonical-shadow-match', scopeKey })
      const proofDigest = createHash('sha256').update(proof).digest('hex')
      conn.prepare(`INSERT INTO session_projection_state(session_id,scope_key,session_generation,status,history_watermark_json,
        message_revision,payload_generation,payload_digest,validated_range_json,source_identity_json,updated_at)
        VALUES(?,?,?,'valid',?,0,'payload-1',?,'{}',?,1)`).run(session.id, scopeKey, session.generation, historyWatermarkJson, proofDigest, sourceIdentityJson)
      conn.prepare(`INSERT INTO session_projection_cache(session_id,scope_key,payload_generation,source_identity_json,payload_digest,
        validated_range_json,inline_payload,updated_at) VALUES(?,?,?,?,?,'{}',?,1)`)
        .run(session.id, scopeKey, 'payload-1', sourceIdentityJson, proofDigest, proof)
    }

    expect(fence.isCurrent({ sessionId: session.id, sessionGeneration: session.generation, messageRevision: 0, historyWatermarkJson })).toBe(true)
    conn.prepare('UPDATE session_projection_cache SET inline_payload=? WHERE session_id=? AND scope_key=?')
      .run('x'.repeat(256 * 1024 + 1), session.id, scopes[0])
    expect(fence.isCurrent({ sessionId: session.id, sessionGeneration: session.generation, messageRevision: 0, historyWatermarkJson })).toBe(false)
    const apiProof = JSON.stringify({ formatVersion: 1, kind: 'canonical-shadow-match', scopeKey: scopes[0] })
    conn.prepare('UPDATE session_projection_cache SET inline_payload=? WHERE session_id=? AND scope_key=?')
      .run(apiProof, session.id, scopes[0])
    conn.prepare("DELETE FROM session_projection_cache WHERE session_id=? AND scope_key=?").run(session.id, scopes[1])
    expect(fence.isCurrent({ sessionId: session.id, sessionGeneration: session.generation, messageRevision: 0, historyWatermarkJson })).toBe(false)
    const routeProof = JSON.stringify({ formatVersion: 1, kind: 'canonical-shadow-match', scopeKey: scopes[1] })
    const routeDigest = createHash('sha256').update(routeProof).digest('hex')
    conn.prepare("INSERT INTO session_projection_cache(session_id,scope_key,payload_generation,source_identity_json,payload_digest,validated_range_json,inline_payload,updated_at) VALUES(?,?,'payload-1',?,?,'{}',?,1)")
      .run(session.id, scopes[1], sourceIdentityJson, routeDigest, routeProof)
    conn.prepare("UPDATE session_projection_state SET history_watermark_json='stale' WHERE session_id=? AND scope_key=?").run(session.id, scopes[1])
    expect(fence.isCurrent({ sessionId: session.id, sessionGeneration: session.generation, messageRevision: 0, historyWatermarkJson })).toBe(false)
  })

  it('does not include the retired API read eligibility marker in the projection source identity', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'API read marker retirement', model: 'test' })
    const store = createSqliteProjectionStateStore(db)
    const before = store.readSourceIdentity(session.id, session.generation)
    const conn = getDbConnection(db)

    conn.exec("ALTER TABLE session_message_content_cutover ADD COLUMN api_read_mode TEXT NOT NULL DEFAULT 'legacy'")
    conn.prepare("UPDATE session_message_content_cutover SET api_read_mode='revalidation-required' WHERE session_id=?").run(session.id)

    expect(store.readSourceIdentity(session.id, session.generation)).toBe(before)
    expect(JSON.parse(before!).bodyAuthority).toEqual(['legacy', 'retained'])
  })

  it('publishes both certified scopes through ProjectionService and refuses a stale source fence', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'publish API route scopes', model: 'test' })
    const sourceIdentityJson = createSqliteProjectionStateStore(db).readSourceIdentity(session.id, session.generation)!
    const historyWatermarkJson = JSON.stringify((JSON.parse(sourceIdentityJson) as { historyWatermark: unknown }).historyWatermark)

    expect(publishSqliteSessionApiRouteScopes(db, {
      sessionId: session.id, sessionGeneration: session.generation, messageRevision: 0, historyWatermarkJson,
    })).toBe(true)
    const proofRows = getDbConnection(db).prepare('SELECT inline_payload FROM session_projection_cache WHERE session_id=?').all(session.id) as Array<{ inline_payload: string }>
    expect(proofRows).toHaveLength(2)
    expect(proofRows.every(({ inline_payload }) => Buffer.byteLength(inline_payload, 'utf8') <= 256 * 1024 &&
      inline_payload.includes('canonical-shadow-match'))).toBe(true)
    const fence = createSqliteSessionApiRouteProjectionFence(db)
    expect(fence.isCurrent({ sessionId: session.id, sessionGeneration: session.generation, messageRevision: 0, historyWatermarkJson })).toBe(true)

    getDbConnection(db).prepare('UPDATE session_message_content_cutover SET message_revision=message_revision+1 WHERE session_id=?').run(session.id)
    expect(publishSqliteSessionApiRouteScopes(db, {
      sessionId: session.id, sessionGeneration: session.generation, messageRevision: 0, historyWatermarkJson,
    })).toBe(false)
    expect(fence.isCurrent({ sessionId: session.id, sessionGeneration: session.generation, messageRevision: 0, historyWatermarkJson })).toBe(false)
  })
})
