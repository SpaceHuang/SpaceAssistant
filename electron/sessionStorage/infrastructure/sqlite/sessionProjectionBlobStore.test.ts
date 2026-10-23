import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSession } from '../../../database/operations'
import { createTempDatabase } from '../../../database/testHelpers'
import { getDbConnection } from '../../../database/sqliteStore'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { acceptProjectionBuildChunk, attachProjectionStableIdIndexManifest, createProjectionBuildCheckpoint } from '../../domain/projectionBuild'

const lockState = vi.hoisted(() => ({ failRelease: false }))
vi.mock('proper-lockfile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('proper-lockfile')>()
  return { ...actual, lock: async (...args: Parameters<typeof actual.lock>) => {
    const release = await actual.lock(...args)
    return async () => {
      await release()
      if (lockState.failRelease) throw new Error('injected lock release failure')
    }
  } }
})

describe('session projection derived blob store', () => {
  let temp: ReturnType<typeof createTempDatabase> | undefined
  let root: string | undefined
  afterEach(async () => {
    lockState.failRelease = false
    temp?.cleanup(); temp = undefined
    if (root) await fs.rm(root, { recursive: true, force: true })
    root = undefined
  })

  it('holds garbage collection behind the shared batch fence until output and index are checkpointable', async () => {
    temp = createTempDatabase('projection-blob-batch-')
    root = path.join(path.dirname(temp.dbPath), 'derived-projections')
    const blobs = createSessionProjectionBlobStore(root)
    const staged = await blobs.writeMany(['output-delta', 'stable-id-index'])
    expect(staged).toHaveLength(2)
    let gcSettled = false
    const gc = blobs.collectGarbage(getDbConnection(temp.db)).then((result) => { gcSettled = true; return result })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(gcSettled).toBe(false)
    await Promise.all(staged.map((blob) => blob.release()))
    expect(await gc).toMatchObject({ removedCount: 2 })
  })

  it('verifies durable payload bytes and preserves blobs referenced by cache manifests', async () => {
    temp = createTempDatabase('projection-blob-store-')
    const session = createSession(temp.db, { name: 'projection blob root', model: 'test' })
    root = path.join(path.dirname(temp.dbPath), 'derived-projections')
    const blobs = createSessionProjectionBlobStore(root)
    const payload = JSON.stringify({ formatVersion: 1, sessionId: session.id, sessionGeneration: session.generation,
      scopeKey: 'scope-a', sourceIdentityJson: '{"source":1}', messages: [] })
    const staged = await blobs.write(payload)
    getDbConnection(temp.db).prepare(`INSERT INTO session_projection_cache(
      session_id,scope_key,payload_generation,source_identity_json,payload_digest,validated_range_json,inline_payload,blob_locator,blob_byte_length,updated_at
    ) VALUES(?,?,?,?,?,? ,NULL,?,?,1)`).run(session.id, 'scope-a', 'generation-a', '{"source":1}', staged.payloadDigest, '{}', staged.locator, staged.byteLength)
    await staged.release()
    expect(await blobs.readVerified(staged)).toBe(payload)

    expect(await blobs.collectGarbage(getDbConnection(temp.db))).toMatchObject({ removedCount: 0 })
    getDbConnection(temp.db).prepare('DELETE FROM session_projection_cache WHERE session_id=? AND scope_key=?').run(session.id, 'scope-a')
    expect(await blobs.collectGarbage(getDbConnection(temp.db))).toMatchObject({ removedCount: 1 })
    await expect(blobs.readVerified(staged)).rejects.toMatchObject({ code: 'PROJECTION_BLOB_MISSING' })
  })

  it('blocks garbage collection until a staged blob fence is released', async () => {
    temp = createTempDatabase('projection-blob-fence-')
    root = path.join(path.dirname(temp.dbPath), 'derived-projections')
    const blobs = createSessionProjectionBlobStore(root)
    const staged = await blobs.write('staging payload')
    let gcSettled = false
    const gc = blobs.collectGarbage(getDbConnection(temp.db)).then((result) => { gcSettled = true; return result })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(gcSettled).toBe(false)
    await staged.release()
    expect(await gc).toMatchObject({ removedCount: 1 })
  }, 10_000)

  it('keeps chunks referenced only by a durable build checkpoint', async () => {
    temp = createTempDatabase('projection-blob-checkpoint-')
    const session = createSession(temp.db, { name: 'checkpoint blob root', model: 'test' })
    const conn = getDbConnection(temp.db)
    root = path.join(path.dirname(temp.dbPath), 'derived-projections')
    const blobs = createSessionProjectionBlobStore(root)
    const outputPayload = JSON.stringify({ formatVersion: 2, sessionId: session.id, sessionGeneration: session.generation,
      scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson: '{"source":1}',
      outputManifest: { formatVersion: 1, parent: null, operations: [] } })
    const staged = await blobs.write(outputPayload)
    const seed = createProjectionBuildCheckpoint({ sessionId: session.id, sessionGeneration: session.generation,
      scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson: '{"source":1}', processGeneration: 1,
      rebuildToken: 'build-token', startSequence: 0, historyReducerStateJson: '{}' })
    const checkpoint = acceptProjectionBuildChunk(seed, { sessionId: session.id, sessionGeneration: session.generation,
      scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson: '{"source":1}', processGeneration: 1,
      rebuildToken: 'build-token', fromSequence: 0, nextSequence: 1, rowCount: 1,
      byteLength: staged.byteLength, payloadDigest: staged.payloadDigest, blobLocator: staged.locator }, { maxRows: 10, maxBytes: 1024 })!
    conn.prepare("INSERT INTO session_projection_state(session_id,scope_key,session_generation,status,process_generation,rebuild_token,updated_at,build_checkpoint_json) VALUES(?,?,?,'rebuilding',1,'build-token',1,?)")
      .run(session.id, 'scope-a', session.generation, JSON.stringify(checkpoint))
    await staged.release()
    expect(await blobs.collectGarbage(conn)).toMatchObject({ removedCount: 0 })
    conn.prepare('UPDATE session_projection_state SET build_checkpoint_json=NULL WHERE session_id=? AND scope_key=?').run(session.id, 'scope-a')
    expect(await blobs.collectGarbage(conn)).toMatchObject({ removedCount: 1 })
  })

  it('retains a stable-ID index blob referenced only by a durable checkpoint', async () => {
    temp = createTempDatabase('projection-blob-stable-index-')
    const session = createSession(temp.db, { name: 'stable ID index checkpoint', model: 'test' })
    const conn = getDbConnection(temp.db)
    root = path.join(path.dirname(temp.dbPath), 'derived-projections')
    const blobs = createSessionProjectionBlobStore(root)
    const stableIds = Array.from({ length: 128 }, (_, index) => `message-${index}`)
    const stableIdsPayload = JSON.stringify({ formatVersion: 1, messageCount: stableIds.length, sessionId: session.id, scopeKey: 'scope-a',
      sourceIdentityJson: '{"source":1}', ids: stableIds,
      entries: stableIds.map((id, ordinal) => ({ id, role: ordinal % 2 === 0 ? 'user' : 'assistant', ordinal })) })
    const staged = await blobs.write(stableIdsPayload)
    const seed = createProjectionBuildCheckpoint({ sessionId: session.id, sessionGeneration: session.generation,
      scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson: '{"source":1}', processGeneration: 1,
      rebuildToken: 'stable-index-token', startSequence: 0, historyReducerStateJson: '{}' })
    const checkpoint = attachProjectionStableIdIndexManifest(seed, { locator: staged.locator, byteLength: staged.byteLength,
      payloadDigest: staged.payloadDigest, itemCount: 128, sessionId: session.id, scopeKey: 'scope-a', sourceIdentityJson: '{"source":1}' })!
    conn.prepare("INSERT INTO session_projection_state(session_id,scope_key,session_generation,status,process_generation,rebuild_token,updated_at,build_checkpoint_json) VALUES(?,?,?,'rebuilding',1,'stable-index-token',1,?)")
      .run(session.id, 'scope-a', session.generation, JSON.stringify(checkpoint))
    await staged.release()

    expect(await blobs.collectGarbage(conn)).toMatchObject({ removedCount: 0 })
    conn.prepare('UPDATE session_projection_state SET build_checkpoint_json=NULL WHERE session_id=? AND scope_key=?').run(session.id, 'scope-a')
    expect(await blobs.collectGarbage(conn)).toMatchObject({ removedCount: 1 })
  })

  it('retains the full append chain reachable from a durable checkpoint output manifest root', async () => {
    temp = createTempDatabase('projection-blob-manifest-chain-')
    const session = createSession(temp.db, { name: 'output manifest chain', model: 'test' })
    const conn = getDbConnection(temp.db)
    root = path.join(path.dirname(temp.dbPath), 'derived-projections')
    const blobs = createSessionProjectionBlobStore(root)
    let parent: { locator: string; byteLength: number; payloadDigest: string } | null = null
    let child: { locator: string; byteLength: number; payloadDigest: string } | null = null
    for (let index = 0; index < 32; index += 1) {
      const payload = JSON.stringify({ formatVersion: 2, sessionId: session.id, scopeKey: 'scope-a', sourceIdentityJson: '{"source":1}',
        outputManifest: { formatVersion: 1,
        parent,
        operations: [{ type: 'append', messages: [] }] } })
      const staged = await blobs.write(payload)
      child = { locator: staged.locator, byteLength: staged.byteLength, payloadDigest: staged.payloadDigest }
      await staged.release()
      parent = child
    }
    const seed = createProjectionBuildCheckpoint({ sessionId: session.id, sessionGeneration: session.generation,
      scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson: '{"source":1}', processGeneration: 1,
      rebuildToken: 'chain-token', startSequence: 0, historyReducerStateJson: '{}' })
    const checkpoint = acceptProjectionBuildChunk(seed, { sessionId: session.id, sessionGeneration: session.generation,
      scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson: '{"source":1}', processGeneration: 1,
      rebuildToken: 'chain-token', fromSequence: 0, nextSequence: 1, rowCount: 1, byteLength: 1,
      payloadDigest: child!.payloadDigest, blobLocator: child!.locator }, { maxRows: 1, maxBytes: 1 }, '{}', null, child!.byteLength)!
    conn.prepare("INSERT INTO session_projection_state(session_id,scope_key,session_generation,status,process_generation,rebuild_token,updated_at,build_checkpoint_json) VALUES(?,?,?,'rebuilding',1,'chain-token',1,?)")
      .run(session.id, 'scope-a', session.generation, JSON.stringify(checkpoint))

    expect(await blobs.collectGarbage(conn)).toMatchObject({ removedCount: 0 })
    conn.prepare('UPDATE session_projection_state SET build_checkpoint_json=NULL WHERE session_id=? AND scope_key=?').run(session.id, 'scope-a')
    expect(await blobs.collectGarbage(conn)).toMatchObject({ removedCount: 32 })
  })

  it('fails closed when a durable reference cannot be parsed instead of deleting candidate blobs', async () => {
    temp = createTempDatabase('projection-blob-reference-scan-')
    const session = createSession(temp.db, { name: 'invalid checkpoint references', model: 'test' })
    const conn = getDbConnection(temp.db)
    root = path.join(path.dirname(temp.dbPath), 'derived-projections')
    const blobs = createSessionProjectionBlobStore(root)
    const staged = await blobs.write('maybe referenced payload')
    conn.prepare("INSERT INTO session_projection_state(session_id,scope_key,session_generation,status,process_generation,rebuild_token,updated_at,build_checkpoint_json) VALUES(?,?,?,'rebuilding',1,'token',1,'{bad-json')")
      .run(session.id, 'scope-a', session.generation)
    await staged.release()

    await expect(blobs.collectGarbage(conn)).rejects.toMatchObject({ code: 'PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE' })
    expect(await blobs.readVerified(staged)).toBe('maybe referenced payload')
  })

  it('fails closed when an output manifest parent is missing', async () => {
    temp = createTempDatabase('projection-blob-missing-parent-')
    const session = createSession(temp.db, { name: 'missing output manifest parent', model: 'test' })
    const conn = getDbConnection(temp.db)
    root = path.join(path.dirname(temp.dbPath), 'derived-projections')
    const blobs = createSessionProjectionBlobStore(root)
    const parentRef = { locator: `projection-${'a'.repeat(8)}-${'b'.repeat(4)}-${'c'.repeat(4)}-${'d'.repeat(4)}-${'e'.repeat(12)}.blob`,
      byteLength: 10, payloadDigest: 'f'.repeat(64) }
    const staged = await blobs.write(JSON.stringify({ formatVersion: 2, sessionId: session.id, scopeKey: 'scope-a',
      sourceIdentityJson: '{"source":1}', outputManifest: { formatVersion: 1, parent: parentRef, operations: [] } }))
    conn.prepare(`INSERT INTO session_projection_cache(
      session_id,scope_key,payload_generation,source_identity_json,payload_digest,validated_range_json,inline_payload,blob_locator,blob_byte_length,updated_at
    ) VALUES(?,?,?,?,?,? ,NULL,?,?,1)`).run(session.id, 'scope-a', 'generation-a', '{"source":1}', staged.payloadDigest, '{}', staged.locator, staged.byteLength)
    await staged.release()

    await expect(blobs.collectGarbage(conn)).rejects.toMatchObject({ code: 'PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE' })
    expect(await blobs.readVerified(staged)).toContain('projection-aaaaaaaa')
  })

  it('rejects traversal locators and detects modified payloads', async () => {
    temp = createTempDatabase('projection-blob-corrupt-')
    root = path.join(path.dirname(temp.dbPath), 'derived-projections')
    const blobs = createSessionProjectionBlobStore(root)
    await expect(blobs.readVerified({ locator: '../outside.blob', byteLength: 1, payloadDigest: '0'.repeat(64) })).rejects.toMatchObject({ code: 'PROJECTION_BLOB_LOCATOR_INVALID' })
    const staged = await blobs.write('trusted payload')
    await staged.release()
    await fs.writeFile(path.join(root, staged.locator), 'modified payload')
    await expect(blobs.readVerified(staged)).rejects.toMatchObject({ code: 'PROJECTION_BLOB_CORRUPT' })
  })

  it('preserves the primary blob error when releasing the shared fence also fails', async () => {
    temp = createTempDatabase('projection-blob-release-error-')
    root = path.join(path.dirname(temp.dbPath), 'derived-projections')
    const blobs = createSessionProjectionBlobStore(root)
    lockState.failRelease = true
    await expect(blobs.readVerified({ locator: 'projection-00000000-0000-4000-8000-000000000099.blob', byteLength: 1,
      payloadDigest: '0'.repeat(64) })).rejects.toMatchObject({ code: 'PROJECTION_BLOB_MISSING' })
    lockState.failRelease = false
  })
})
