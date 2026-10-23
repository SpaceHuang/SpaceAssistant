import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSession } from '../../../database/operations'
import { createTempDatabase } from '../../../database/testHelpers'
import { getDbConnection } from '../../../database/sqliteStore'
import { createSessionProjectionBlobStore } from './sessionProjectionBlobStore'
import { acceptProjectionBuildChunk, attachProjectionPendingHistoryChunk, attachProjectionStableIdIndexManifest, createProjectionBuildCheckpoint } from '../../domain/projectionBuild'

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

  it('promotes a worker staged file under the blob fence without reading its payload into the main thread', async () => {
    temp = createTempDatabase('projection-worker-stage-')
    root = path.join(path.dirname(temp.dbPath), 'derived-projections')
    const blobs = createSessionProjectionBlobStore(root)
    const payload = 'large output '.repeat(30_000)
    const tempLocator = `.projection-123e4567-e89b-12d3-a456-426614174000.tmp`
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, tempLocator), payload, { mode: 0o600 })

    const promoted = await blobs.withWorkerStaging(async (promote) => promote({ tempLocator,
      byteLength: Buffer.byteLength(payload), payloadDigest: createHash('sha256').update(payload).digest('hex') }))

    expect(promoted.locator).toMatch(/^projection-[0-9a-f-]{36}\.blob$/)
    await expect(fs.stat(path.join(root, tempLocator))).rejects.toMatchObject({ code: 'ENOENT' })
    await promoted.release()
    expect(await blobs.readVerified(promoted)).toBe(payload)
  })

  it('allocates and promotes multiple worker artifacts while retaining the fence until checkpoint release', async () => {
    temp = createTempDatabase('projection-worker-stage-batch-')
    root = path.join(path.dirname(temp.dbPath), 'derived-projections')
    const blobs = createSessionProjectionBlobStore(root)
    const payloads = ['manifest payload', 'stable index payload', 'reducer state payload']
    const promoted = await blobs.withWorkerStaging(async (promote, stage) => {
      const locators = stage.allocate(payloads.length)
      const outputs = []
      for (const [index, locator] of locators.entries()) {
        const payload = payloads[index]!
        await fs.writeFile(path.join(stage.root, locator!), payload, { mode: 0o600 })
        outputs.push(await promote({ tempLocator: locator!, byteLength: Buffer.byteLength(payload),
          payloadDigest: createHash('sha256').update(payload).digest('hex') }))
      }
      return outputs
    })
    let gcSettled = false
    const gc = blobs.collectGarbage(getDbConnection(temp.db)).then((result) => { gcSettled = true; return result })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(gcSettled).toBe(false)
    expect(await Promise.all(promoted.map((blob) => fs.readFile(path.join(root!, blob.locator), 'utf8')))).toEqual(payloads)
    await Promise.all(promoted.map((blob) => blob.release()))
    expect(await gc).toMatchObject({ removedCount: promoted.length })
  })

  it('holds the blob fence for a transient worker input and removes it before release', async () => {
    temp = createTempDatabase('projection-worker-transient-stage-')
    root = path.join(path.dirname(temp.dbPath), 'derived-projections')
    const blobs = createSessionProjectionBlobStore(root)
    let entered!: (stage: { root: string; tempLocator: string }) => void
    let continueWork!: () => void
    const stageReady = new Promise<{ root: string; tempLocator: string }>((resolve) => { entered = resolve })
    const workGate = new Promise<void>((resolve) => { continueWork = resolve })
    const work = blobs.withWorkerTransientStaging(async (stage) => {
      await fs.writeFile(path.join(stage.root, stage.tempLocator), 'source chunk', { mode: 0o600 })
      entered(stage)
      await workGate
    })
    const stage = await stageReady
    let gcSettled = false
    const gc = blobs.collectGarbage(getDbConnection(temp.db)).then((result) => { gcSettled = true; return result })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(gcSettled).toBe(false)
    expect((await fs.stat(path.join(stage.root, stage.tempLocator)).then((stat) => stat.mode & 0o777))).toBe(0o600)
    continueWork()
    await work
    await expect(fs.stat(path.join(stage.root, stage.tempLocator))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await gc).toMatchObject({ removedCount: 0 })
  }, 10_000)

  it('removes a transient worker input when the consumer fails', async () => {
    temp = createTempDatabase('projection-worker-transient-failure-')
    root = path.join(path.dirname(temp.dbPath), 'derived-projections')
    const blobs = createSessionProjectionBlobStore(root)
    await expect(blobs.withWorkerTransientStaging(async (stage) => {
      await fs.writeFile(path.join(stage.root, stage.tempLocator), 'failed source chunk', { mode: 0o600 })
      throw new Error('reducer failed')
    })).rejects.toThrow('reducer failed')
    expect((await fs.readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
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

  it('retains reducer state blobs referenced only by a durable checkpoint', async () => {
    temp = createTempDatabase('projection-blob-reducer-state-')
    const session = createSession(temp.db, { name: 'reducer state checkpoint', model: 'test' })
    const conn = getDbConnection(temp.db)
    root = path.join(path.dirname(temp.dbPath), 'derived-projections')
    const blobs = createSessionProjectionBlobStore(root)
    const statePayload = JSON.stringify({ reducerState: 'x'.repeat(70_000) })
    const staged = await blobs.write(statePayload)
    const seed = createProjectionBuildCheckpoint({ sessionId: session.id, sessionGeneration: session.generation,
      scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson: '{"source":1}', processGeneration: 1,
      rebuildToken: 'reducer-state-token', startSequence: 0, historyReducerStateJson: null })
    const checkpoint = { ...seed, historyReducerStateBlob: { locator: staged.locator, byteLength: staged.byteLength,
      payloadDigest: staged.payloadDigest, sessionId: session.id, scopeKey: 'scope-a', sourceIdentityJson: '{"source":1}' } }
    conn.prepare("INSERT INTO session_projection_state(session_id,scope_key,session_generation,status,process_generation,rebuild_token,updated_at,build_checkpoint_json) VALUES(?,?,?,'rebuilding',1,'reducer-state-token',1,?)")
      .run(session.id, 'scope-a', session.generation, JSON.stringify(checkpoint))
    await staged.release()

    expect(await blobs.collectGarbage(conn)).toMatchObject({ removedCount: 0 })
    const orphan = await blobs.write('unreferenced candidate')
    await orphan.release()
    await fs.writeFile(path.join(root, staged.locator), 'corrupt reducer state')
    await expect(blobs.collectGarbage(conn)).rejects.toMatchObject({ code: 'PROJECTION_BLOB_REFERENCE_SCAN_INCOMPLETE' })
    await expect(fs.stat(path.join(root, orphan.locator))).resolves.toBeTruthy()
    conn.prepare('UPDATE session_projection_state SET build_checkpoint_json=NULL WHERE session_id=? AND scope_key=?').run(session.id, 'scope-a')
    expect(await blobs.collectGarbage(conn)).toMatchObject({ removedCount: 2 })
  })

  it('retains a staged pending History chunk across GC until the reducer advances its checkpoint', async () => {
    temp = createTempDatabase('projection-blob-pending-history-')
    const session = createSession(temp.db, { name: 'pending History chunk checkpoint', model: 'test' })
    const conn = getDbConnection(temp.db)
    root = path.join(path.dirname(temp.dbPath), 'derived-projections')
    const blobs = createSessionProjectionBlobStore(root)
    const staged = await blobs.write(JSON.stringify({ events: [{ payloadJson: '{"large":"x"}' }], messageFacts: [] }))
    const seed = createProjectionBuildCheckpoint({ sessionId: session.id, sessionGeneration: session.generation,
      scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson: '{"source":1}', processGeneration: 1,
      rebuildToken: 'pending-history-token', startSequence: 0, historyReducerStateJson: '{}' })
    const checkpoint = attachProjectionPendingHistoryChunk(seed, { locator: staged.locator, byteLength: staged.byteLength,
      payloadDigest: staged.payloadDigest, sessionId: session.id, scopeKey: 'scope-a', sourceIdentityJson: '{"source":1}',
      fromSequence: 0, nextSequence: 1, rowCount: 1, sourceBytes: staged.byteLength, hasMore: true })!
    conn.prepare("INSERT INTO session_projection_state(session_id,scope_key,session_generation,status,process_generation,rebuild_token,updated_at,build_checkpoint_json) VALUES(?,?,?,'rebuilding',1,'pending-history-token',1,?)")
      .run(session.id, 'scope-a', session.generation, JSON.stringify(checkpoint))
    await staged.release()

    expect(await blobs.collectGarbage(conn)).toMatchObject({ removedCount: 0 })
    const output = await blobs.write(JSON.stringify({ formatVersion: 2, sessionId: session.id, scopeKey: 'scope-a',
      sourceIdentityJson: '{"source":1}', outputManifest: { formatVersion: 1, parent: null, operations: [] } }))
    const advanced = acceptProjectionBuildChunk(checkpoint, { sessionId: session.id, sessionGeneration: session.generation,
      scopeKey: 'scope-a', specVersion: 1, sourceIdentityJson: '{"source":1}', processGeneration: 1,
      rebuildToken: 'pending-history-token', fromSequence: 0, nextSequence: 1, rowCount: 1, byteLength: 1,
      payloadDigest: output.payloadDigest, blobLocator: output.locator },
    { maxRows: 1, maxBytes: 1 }, '{}', null, output.byteLength)!
    conn.prepare('UPDATE session_projection_state SET build_checkpoint_json=? WHERE session_id=? AND scope_key=?')
      .run(JSON.stringify(advanced), session.id, 'scope-a')
    await output.release()
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
