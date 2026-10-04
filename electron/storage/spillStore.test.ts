import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as agentLoggerModule from '../agentLogger/agentLogger'
import { SpillContentUnavailableError, SpillRootFenceBusyError, createSpillStore, createSpillStoreForDatabase, reconcileSpillOrphansAgainstCanonicalHistory, runSourceTruthSpillGcMaintenance, runSpillRetentionMaintenance } from './spillStore'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { openDatabase } from '../database'
import { createSession, deleteSession, setConfigValue } from '../database/operations'
import { getDbConnection } from '../database/sqliteStore'
import { readSessionTranscript } from '../database/sessionTranscript'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { rebuildClaudeMessagesFromHistory } from '../runtime/canonicalHistory'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

async function createStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-spill-'))
  roots.push(root)
  return { root, store: createSpillStore(root) }
}

describe('spillStore P-5 protocol', () => {
  it('serializes independent spill-store instances through the shared file fence', async () => {
    const { root } = await createStore()
    const writer = createSpillStore(root)
    const collector = createSpillStore(root)
    let releaseWriter!: () => void
    let writerEntered!: () => void
    const entered = new Promise<void>((resolve) => { writerEntered = resolve })
    const gate = new Promise<void>((resolve) => { releaseWriter = resolve })
    const activeWrite = writer.withSpillRootFence(async () => { writerEntered(); await gate })
    await entered
    await expect(collector.withSpillRootFence(async () => undefined, false)).rejects.toBeInstanceOf(SpillRootFenceBusyError)
    let serialized = false
    const waitingWriter = collector.withSpillRootFence(async () => { serialized = true })
    releaseWriter()
    await Promise.all([activeWrite, waitingWriter])
    expect(serialized).toBe(true)
  })

  it('uses a cross-process spill-root lock that blocks a competing process', async () => {
    const { root } = await createStore()
    const child = spawn(process.execPath, ['-e', `const lock=require('proper-lockfile').lock; lock(process.argv[1], { realpath:false }).then(release => { process.stdout.write('LOCKED\\n'); setTimeout(() => release().then(() => process.exit(0)), 10000) }).catch(error => { console.error(error); process.exit(2) })`, root], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('child lock acquisition timed out')), 5_000)
        child.stdout.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('LOCKED')) { clearTimeout(timer); resolve() }
        })
        child.once('error', (error) => { clearTimeout(timer); reject(error) })
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`lock child exited before acquiring lock: ${code}`)) })
      })
      await expect(createSpillStore(root).withSpillRootFence(async () => undefined, false))
        .rejects.toBeInstanceOf(SpillRootFenceBusyError)
    } finally {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    }
  })

  it('records source-truth locators for post-commit collection when deleting a session', async () => {
    const temp = createTempDatabase('spill-session-delete-queue-')
    const session = createSession(temp.db, { name: 'spill deletion queue' })
    const otherSession = createSession(temp.db, { name: 'shared spill reference' })
    const body = 'session-owned canonical source '.repeat(3_000)
    const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'spill-delete-invocation', turnId: 'spill-delete-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-delete-context', idempotencyKey: 'spill-delete-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'spill-delete-user', role: 'user', content: body, timestamp: 1 }] }
    }], 0)
    const stored = getDbConnection(temp.db).prepare("SELECT payload_json FROM agent_history_events WHERE event_id='spill-delete-context'").get() as { payload_json: string }
    const payload = JSON.parse(stored.payload_json) as { messages: Array<{ content: { __spaceassistant_spill_v1: Record<string, unknown> } }> }
    const descriptor = payload.messages[0]!.content.__spaceassistant_spill_v1
    const locator = String(descriptor.locator)
    const transcriptSpill = JSON.stringify({ __spaceassistant_session_transcript_spill_v1: descriptor })
    getDbConnection(temp.db).prepare(`INSERT INTO session_transcript_entries(session_id,turn_id,base_version,version,outcome,messages_json,created_at)
      VALUES(?, 'spill-delete-transcript-turn',0,1,'completed',?,1)`).run(session.id, transcriptSpill)
    const spillFile = path.join(path.dirname(temp.dbPath), 'spill', locator)
    await expect(fs.access(spillFile)).resolves.toBeUndefined()
    await new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, otherSession.id).appendBatch([{
      invocationId: 'spill-delete-shared-invocation', turnId: 'spill-delete-shared-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-delete-shared-event', idempotencyKey: 'spill-delete-shared-event', kind: 'invocation-context-committed',
      payload: { messages: [], sharedSpill: descriptor }
    }], 0)

    deleteSession(temp.db, session.id, { flush: false })

    expect(getDbConnection(temp.db).prepare('SELECT session_id,generation,locator,status,attempts FROM source_truth_spill_gc_queue').all())
      .toEqual([expect.objectContaining({ session_id: session.id, locator, status: 'pending', attempts: 0 })])
    expect(getDbConnection(temp.db).prepare('SELECT 1 FROM agent_history_events WHERE event_id=?').get('spill-delete-context')).toBeUndefined()
    expect(getDbConnection(temp.db).prepare('SELECT 1 FROM session_transcript_entries WHERE session_id=?').get(session.id)).toBeUndefined()
    await expect(fs.access(spillFile)).resolves.toBeUndefined()
    await expect(runSourceTruthSpillGcMaintenance(temp.db, path.join(path.dirname(temp.dbPath), 'spill')))
      .resolves.toMatchObject({ pending: 1, shared: 1, completed: 0 })
    await expect(fs.access(spillFile)).resolves.toBeUndefined()
    deleteSession(temp.db, otherSession.id, { flush: false })
    await expect(runSourceTruthSpillGcMaintenance(temp.db, path.join(path.dirname(temp.dbPath), 'spill')))
      .resolves.toMatchObject({ pending: 0, completed: 1 })
    await expect(fs.access(spillFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(getDbConnection(temp.db).prepare('SELECT status,attempts,last_error FROM source_truth_spill_gc_queue WHERE locator=?').get(locator))
      .toEqual({ status: 'completed', attempts: 2, last_error: null })
    temp.cleanup()
  })

  it('rejects a source-truth append whose session generation disappeared during spill preparation', async () => {
    const temp = createTempDatabase('spill-session-generation-fence-')
    const session = createSession(temp.db, { name: 'generation race' })
    const spillRoot = path.join(path.dirname(temp.dbPath), 'spill')
    const store = createSpillStore(spillRoot)
    const commitUnderFence = store.commitSourceTruthUnderFence.bind(store)
    let prepared!: () => void
    let release!: () => void
    const filePrepared = new Promise<void>((resolve) => { prepared = resolve })
    const allowAppend = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(store, 'commitSourceTruthUnderFence').mockImplementation(async (payload, commit) => {
      const descriptor = await commitUnderFence(payload, commit)
      prepared()
      await allowAppend
      return descriptor
    })
    const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id, store)
    const append = history.appendBatch([{
      invocationId: 'spill-generation-race-invocation', turnId: 'spill-generation-race-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-generation-race-event', idempotencyKey: 'spill-generation-race-event', kind: 'tool-call-finished',
      payload: { result: { success: true, data: 'generation race body '.repeat(8_000) } }
    }], 0)
    await filePrepared
    deleteSession(temp.db, session.id, { flush: false })
    release()

    await expect(append).rejects.toThrow('history session generation changed during spill preparation')
    expect(getDbConnection(temp.db).prepare('SELECT COUNT(*) AS count FROM agent_history_events WHERE event_id=?')
      .get('spill-generation-race-event')).toEqual({ count: 0 })
    await expect(runSourceTruthSpillGcMaintenance(temp.db, spillRoot, Date.now(), { batchSize: 1 }))
      .resolves.toMatchObject({ completed: 1, classified: 1 })
    temp.cleanup()
  })

  it('keeps pending spill files when the full cross-session reference scan is malformed, then retries after repair', async () => {
    const temp = createTempDatabase('spill-gc-reference-scan-failure-')
    const deletedSession = createSession(temp.db, { name: 'queued delete' })
    const remainingSession = createSession(temp.db, { name: 'malformed unrelated history' })
    const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, deletedSession.id)
    await history.appendBatch([{
      invocationId: 'spill-gc-pending-invocation', turnId: 'spill-gc-pending-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-gc-pending-event', idempotencyKey: 'spill-gc-pending-event', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'spill-gc-pending-user', role: 'user', content: 'q'.repeat(70 * 1024), timestamp: 1 }] }
    }], 0)
    const pendingPayload = JSON.parse((getDbConnection(temp.db).prepare('SELECT payload_json FROM agent_history_events WHERE event_id=?')
      .get('spill-gc-pending-event') as { payload_json: string }).payload_json) as { messages: Array<{ content: { __spaceassistant_spill_v1: { locator: string } } }> }
    const locator = pendingPayload.messages[0]!.content.__spaceassistant_spill_v1.locator
    const spillFile = path.join(path.dirname(temp.dbPath), 'spill', locator)
    const conn = getDbConnection(temp.db)
    conn.prepare('INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id) VALUES(\'bad-reference-owner\',1,1,?)').run(remainingSession.id)
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at)
      VALUES('bad-reference-owner',1,'bad-reference-event','bad-reference-key','bad-reference-turn',1,'invocation-context-committed','{broken',1)`).run()
    deleteSession(temp.db, deletedSession.id, { flush: false })

    await expect(runSourceTruthSpillGcMaintenance(temp.db, path.join(path.dirname(temp.dbPath), 'spill')))
      .resolves.toMatchObject({ pending: 1, failed: 1, completed: 0 })
    await expect(fs.access(spillFile)).resolves.toBeUndefined()
    expect(conn.prepare('SELECT status,attempts,last_error FROM source_truth_spill_gc_queue WHERE locator=?').get(locator))
      .toEqual({ status: 'pending', attempts: 1, last_error: 'canonical-reference-scan-failed' })

    conn.prepare('DELETE FROM agent_history_events WHERE event_id=?').run('bad-reference-event')
    conn.prepare('DELETE FROM agent_history_streams WHERE invocation_id=?').run('bad-reference-owner')
    await expect(runSourceTruthSpillGcMaintenance(temp.db, path.join(path.dirname(temp.dbPath), 'spill')))
      .resolves.toMatchObject({ pending: 0, completed: 1 })
    await expect(fs.access(spillFile)).rejects.toMatchObject({ code: 'ENOENT' })
    temp.cleanup()
  })

  it('fails closed on an unknown spill marker instead of deleting its referenced file', async () => {
    const temp = createTempDatabase('spill-gc-unknown-marker-')
    const spillRoot = path.join(path.dirname(temp.dbPath), 'spill')
    await fs.mkdir(spillRoot, { recursive: true })
    const locator = '00000000-0000-4000-8000-000000000099.spill'
    const spillFile = path.join(spillRoot, locator)
    await fs.writeFile(spillFile, 'unknown marker source')
    const conn = getDbConnection(temp.db)
    conn.prepare(`INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id) VALUES('unknown-marker-owner',1,1,'unknown-owner')`).run()
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at)
      VALUES('unknown-marker-owner',1,'unknown-marker-event','unknown-marker-key','unknown-marker-turn',1,'tool-call-finished',?,1)`)
      .run(JSON.stringify({ source: { __spaceassistant_spill_v2: { version: 2, kind: 'source-of-truth', locator } } }))
    conn.prepare(`INSERT INTO source_truth_spill_gc_queue(locator,session_id,generation,created_at,updated_at)
      VALUES(?,'deleted-session','old-generation',1,1)`).run(locator)

    await expect(runSourceTruthSpillGcMaintenance(temp.db, spillRoot))
      .resolves.toMatchObject({ pending: 1, failed: 1, completed: 0 })
    await expect(fs.access(spillFile)).resolves.toBeUndefined()
    expect(conn.prepare('SELECT status,last_error FROM source_truth_spill_gc_queue WHERE locator=?').get(locator))
      .toEqual({ status: 'pending', last_error: 'canonical-reference-scan-failed' })
    temp.cleanup()
  })

  it('leaves a pending GC obligation after unlink failure and completes it on retry', async () => {
    const temp = createTempDatabase('spill-gc-unlink-failure-')
    const session = createSession(temp.db, { name: 'unlink retry' })
    const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'spill-gc-unlink-invocation', turnId: 'spill-gc-unlink-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-gc-unlink-event', idempotencyKey: 'spill-gc-unlink-event', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'spill-gc-unlink-user', role: 'user', content: 'u'.repeat(70 * 1024), timestamp: 1 }] }
    }], 0)
    const payload = JSON.parse((getDbConnection(temp.db).prepare('SELECT payload_json FROM agent_history_events WHERE event_id=?')
      .get('spill-gc-unlink-event') as { payload_json: string }).payload_json) as { messages: Array<{ content: { __spaceassistant_spill_v1: { locator: string } } }> }
    const locator = payload.messages[0]!.content.__spaceassistant_spill_v1.locator
    const spillRoot = path.join(path.dirname(temp.dbPath), 'spill')
    const spillFile = path.join(spillRoot, locator)
    deleteSession(temp.db, session.id, { flush: false })
    const unlink = vi.spyOn(fs, 'unlink').mockRejectedValueOnce(Object.assign(new Error('disk busy'), { code: 'EBUSY' }))

    await expect(runSourceTruthSpillGcMaintenance(temp.db, spillRoot)).resolves.toMatchObject({ pending: 1, failed: 1 })
    await expect(fs.access(spillFile)).resolves.toBeUndefined()
    expect(getDbConnection(temp.db).prepare('SELECT status,attempts,last_error FROM source_truth_spill_gc_queue WHERE locator=?').get(locator))
      .toEqual({ status: 'pending', attempts: 1, last_error: 'file-EBUSY' })

    unlink.mockRestore()
    temp.db.close()
    const reopened = openDatabase(temp.dbPath)
    await expect(runSourceTruthSpillGcMaintenance(reopened, spillRoot)).resolves.toMatchObject({ pending: 0, completed: 1 })
    reopened.close()
    await expect(fs.access(spillFile)).rejects.toMatchObject({ code: 'ENOENT' })
    temp.cleanup()
  })

  it('keeps a pending obligation when directory fsync fails after unlink and retries idempotently', async () => {
    const temp = createTempDatabase('spill-gc-fsync-failure-')
    const session = createSession(temp.db, { name: 'fsync retry' })
    const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'spill-gc-fsync-invocation', turnId: 'spill-gc-fsync-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-gc-fsync-event', idempotencyKey: 'spill-gc-fsync-event', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'spill-gc-fsync-user', role: 'user', content: 'f'.repeat(70 * 1024), timestamp: 1 }] }
    }], 0)
    const payload = JSON.parse((getDbConnection(temp.db).prepare('SELECT payload_json FROM agent_history_events WHERE event_id=?')
      .get('spill-gc-fsync-event') as { payload_json: string }).payload_json) as { messages: Array<{ content: { __spaceassistant_spill_v1: { locator: string } } }> }
    const locator = payload.messages[0]!.content.__spaceassistant_spill_v1.locator
    const spillRoot = path.join(path.dirname(temp.dbPath), 'spill')
    const spillFile = path.join(spillRoot, locator)
    deleteSession(temp.db, session.id, { flush: false })
    const originalOpen = fs.open.bind(fs)
    const open = vi.spyOn(fs, 'open').mockImplementation(async (filePath, ...args) => {
      if (filePath === spillRoot) throw Object.assign(new Error('directory fsync failed'), { code: 'EIO' })
      return await originalOpen(filePath, ...args)
    })

    await expect(runSourceTruthSpillGcMaintenance(temp.db, spillRoot)).resolves.toMatchObject({ pending: 1, failed: 1 })
    await expect(fs.access(spillFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(getDbConnection(temp.db).prepare('SELECT status,last_error FROM source_truth_spill_gc_queue WHERE locator=?').get(locator))
      .toEqual({ status: 'pending', last_error: 'file-EIO' })
    open.mockRestore()
    await expect(runSourceTruthSpillGcMaintenance(temp.db, spillRoot)).resolves.toMatchObject({ pending: 0, completed: 1 })
    temp.cleanup()
  })

  it('retries when unlink succeeds but durable completion marking fails', async () => {
    const temp = createTempDatabase('spill-gc-completion-mark-failure-')
    const session = createSession(temp.db, { name: 'completion marker retry' })
    const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'spill-gc-mark-invocation', turnId: 'spill-gc-mark-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-gc-mark-event', idempotencyKey: 'spill-gc-mark-event', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'spill-gc-mark-user', role: 'user', content: 'm'.repeat(70 * 1024), timestamp: 1 }] }
    }], 0)
    const payload = JSON.parse((getDbConnection(temp.db).prepare('SELECT payload_json FROM agent_history_events WHERE event_id=?')
      .get('spill-gc-mark-event') as { payload_json: string }).payload_json) as { messages: Array<{ content: { __spaceassistant_spill_v1: { locator: string } } }> }
    const locator = payload.messages[0]!.content.__spaceassistant_spill_v1.locator
    const spillRoot = path.join(path.dirname(temp.dbPath), 'spill')
    const spillFile = path.join(spillRoot, locator)
    deleteSession(temp.db, session.id, { flush: false })
    const conn = getDbConnection(temp.db)
    conn.exec(`CREATE TRIGGER reject_spill_gc_completion BEFORE UPDATE OF status ON source_truth_spill_gc_queue
      WHEN NEW.status='completed' BEGIN SELECT RAISE(ABORT, 'injected completion mark failure'); END`)

    await expect(runSourceTruthSpillGcMaintenance(temp.db, spillRoot)).resolves.toMatchObject({ pending: 1, failed: 1 })
    await expect(fs.access(spillFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(conn.prepare('SELECT status FROM source_truth_spill_gc_queue WHERE locator=?').get(locator)).toEqual({ status: 'pending' })
    conn.exec('DROP TRIGGER reject_spill_gc_completion')
    await expect(runSourceTruthSpillGcMaintenance(temp.db, spillRoot)).resolves.toMatchObject({ pending: 0, completed: 1 })
    temp.cleanup()
  })

  it('classifies spill directory orphans in resumable pages before unlinking them', async () => {
    const temp = createTempDatabase('spill-gc-directory-scan-')
    const spillRoot = path.join(path.dirname(temp.dbPath), 'spill')
    await fs.mkdir(spillRoot, { recursive: true })
    const first = '00000000-0000-4000-8000-000000000001.spill'
    const second = '00000000-0000-4000-8000-000000000002.spill'
    await fs.writeFile(path.join(spillRoot, first), 'orphan-one')
    await fs.writeFile(path.join(spillRoot, second), 'orphan-two')
    await fs.writeFile(path.join(spillRoot, 'temporary-upload.tmp'), 'leave alone')

    await expect(runSourceTruthSpillGcMaintenance(temp.db, spillRoot, Date.now(), { batchSize: 1 }))
      .resolves.toMatchObject({ pending: 0, completed: 1, classified: 1, scanStatus: 'pending' })
    expect(getDbConnection(temp.db).prepare('SELECT status,after_name FROM source_truth_spill_gc_scan_state').get())
      .toEqual({ status: 'pending', after_name: first })
    await expect(fs.access(path.join(spillRoot, first))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.access(path.join(spillRoot, second))).resolves.toBeUndefined()

    await expect(runSourceTruthSpillGcMaintenance(temp.db, spillRoot, Date.now(), { batchSize: 1 }))
      .resolves.toMatchObject({ pending: 0, completed: 1, classified: 1, scanStatus: 'pending' })
    await expect(runSourceTruthSpillGcMaintenance(temp.db, spillRoot, Date.now(), { batchSize: 1 }))
      .resolves.toMatchObject({ pending: 0, completed: 0, classified: 0, scanStatus: 'complete' })
    expect(getDbConnection(temp.db).prepare('SELECT status,after_name FROM source_truth_spill_gc_scan_state').get())
      .toEqual({ status: 'complete', after_name: null })
    await expect(fs.access(path.join(spillRoot, second))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(path.join(spillRoot, 'temporary-upload.tmp'), 'utf8')).resolves.toBe('leave alone')
    temp.cleanup()
  })

  it('rolls back session and History deletion if a source-truth payload cannot be classified', () => {
    const temp = createTempDatabase('spill-session-delete-malformed-')
    const session = createSession(temp.db, { name: 'malformed source locator' })
    const conn = getDbConnection(temp.db)
    conn.prepare('INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id) VALUES(\'malformed-spill-owner\',1,1,?)').run(session.id)
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at)
      VALUES('malformed-spill-owner',1,'malformed-spill-event','malformed-spill-key','malformed-spill-turn',1,'invocation-context-committed','{broken',1)`).run()

    expect(() => deleteSession(temp.db, session.id, { flush: false })).toThrow()
    expect(conn.prepare('SELECT id FROM sessions WHERE id=?').get(session.id)).toEqual({ id: session.id })
    expect(conn.prepare('SELECT event_id FROM agent_history_events WHERE event_id=?').get('malformed-spill-event')).toEqual({ event_id: 'malformed-spill-event' })
    expect(conn.prepare('SELECT locator FROM source_truth_spill_gc_queue').all()).toEqual([])
    temp.cleanup()
  })

  it('rolls back session deletion when durable spill-GC todo registration fails', async () => {
    const temp = createTempDatabase('spill-session-delete-queue-failure-')
    const session = createSession(temp.db, { name: 'queue registration failure' })
    const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'spill-delete-queue-failure-invocation', turnId: 'spill-delete-queue-failure-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-delete-queue-failure-event', idempotencyKey: 'spill-delete-queue-failure-event', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'spill-delete-queue-failure-user', role: 'user', content: 'f'.repeat(70 * 1024), timestamp: 1 }] }
    }], 0)
    const conn = getDbConnection(temp.db)
    conn.exec(`CREATE TRIGGER fail_spill_gc_enqueue BEFORE INSERT ON source_truth_spill_gc_queue
      BEGIN SELECT RAISE(ABORT, 'injected spill GC todo failure'); END`)

    expect(() => deleteSession(temp.db, session.id, { flush: false })).toThrow('injected spill GC todo failure')
    expect(conn.prepare('SELECT id FROM sessions WHERE id=?').get(session.id)).toEqual({ id: session.id })
    expect(conn.prepare('SELECT event_id FROM agent_history_events WHERE event_id=?').get('spill-delete-queue-failure-event'))
      .toEqual({ event_id: 'spill-delete-queue-failure-event' })
    expect(conn.prepare('SELECT locator FROM source_truth_spill_gc_queue').all()).toEqual([])
    temp.cleanup()
  })

  it('keeps spill disabled for in-memory and mocked database connections', () => {
    expect(createSpillStoreForDatabase({} as never)).toBeUndefined()
  })

  it('stores oversized canonical tool results as source-truth references and transparently hydrates them after reopen', async () => {
    const { root, store } = await createStore()
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'spill-hydration-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'spill-generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId, store)
    const completeResult = { success: true, data: 'tool output '.repeat(12_000) }
    const event: import('../../packages/agent-sdk/src/history').HistoryEvent = {
      invocationId: 'spill-hydration-invocation', turnId: 'spill-hydration-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-hydration-event', idempotencyKey: 'spill-hydration-event', kind: 'tool-call-finished',
      payload: { toolCallId: 'call-1', result: completeResult, replayContent: 'intentionally bounded replay' }
    }

    await history.appendBatch([event], 0)
    const storedPayload = JSON.parse(conn.prepare('SELECT payload_json FROM agent_history_events WHERE event_id=?')
      .get('spill-hydration-event')!.payload_json as string) as Record<string, any>
    expect(storedPayload.result.data.__spaceassistant_spill_v1).toMatchObject({ version: 1, kind: 'source-of-truth', byteLength: Buffer.byteLength(completeResult.data) })
    expect(storedPayload.replayContent).toBe('intentionally bounded replay')

    const reopenedHistory = new SqliteAgentHistory(conn, 1, Date.now, sessionId, createSpillStore(root))
    await expect(reopenedHistory.read('spill-hydration-invocation')).resolves.toMatchObject({ events: [{ payload: {
      result: completeResult, replayContent: 'intentionally bounded replay'
    } }] })
    db.close()
  })

  it('hard-fails canonical History reads when a referenced source-truth spill is missing or corrupt', async () => {
    const { root, store } = await createStore()
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'spill-hard-failure-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'spill-generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId, store)
    await history.appendBatch([{
      invocationId: 'spill-hard-failure-invocation', turnId: 'spill-hard-failure-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-hard-failure-event', idempotencyKey: 'spill-hard-failure-event', kind: 'tool-call-finished',
      payload: { result: { success: true, data: 'canonical body '.repeat(8_000) } }
    }], 0)
    const persisted = JSON.parse(conn.prepare('SELECT payload_json FROM agent_history_events WHERE event_id=?')
      .get('spill-hard-failure-event')!.payload_json as string) as { result: { data: { __spaceassistant_spill_v1: { locator: string } } } }
    await fs.rm(path.join(root, persisted.result.data.__spaceassistant_spill_v1.locator))

    try {
      history.readSync('spill-hard-failure-invocation')
      throw new Error('expected canonical read to fail when source spill is missing')
    } catch (error) {
      expect(error).toMatchObject({ code: 'SPILL_CONTENT_UNAVAILABLE' })
      expect(error).toBeInstanceOf(SpillContentUnavailableError)
    }
    db.close()
  })

  it('keeps oversized canonical result text inline when durable spill preparation fails', async () => {
    const { root } = await createStore()
    const blockedRoot = path.join(root, 'blocked')
    await fs.writeFile(blockedRoot, 'not a directory')
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'spill-inline-fallback-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'spill-generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId, createSpillStore(blockedRoot))
    const fullText = 'inline canonical fallback '.repeat(8_000)
    await expect(history.appendBatch([{
      invocationId: 'spill-inline-fallback-invocation', turnId: 'spill-inline-fallback-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-inline-fallback-event', idempotencyKey: 'spill-inline-fallback-event', kind: 'tool-call-finished',
      payload: { result: { success: true, data: fullText } }
    }], 0)).resolves.toMatchObject({ version: 1 })
    const stored = JSON.parse(conn.prepare('SELECT payload_json FROM agent_history_events WHERE event_id=?')
      .get('spill-inline-fallback-event')!.payload_json as string) as { result: { data: string } }
    expect(stored.result.data).toBe(fullText)
    await expect(history.read('spill-inline-fallback-invocation')).resolves.toMatchObject({ events: [{ payload: { result: { data: fullText } } }] })
    db.close()
  })

  it('stores oversized canonical assistant response text as source-truth and restores it for provider context', async () => {
    const { store } = await createStore()
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'spill-assistant-response-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'spill-generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId, store)
    const responseText = 'large assistant response '.repeat(8_000)
    await history.appendBatch([{
      invocationId: 'spill-assistant-response-invocation', turnId: 'spill-assistant-response-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-assistant-response-event', idempotencyKey: 'spill-assistant-response-event', kind: 'model-response-committed',
      payload: { message: { role: 'assistant', content: responseText } }
    }], 0)
    const stored = JSON.parse(conn.prepare('SELECT payload_json FROM agent_history_events WHERE event_id=?')
      .get('spill-assistant-response-event')!.payload_json as string) as { message: { content: { __spaceassistant_spill_v1: { kind: string } } } }
    expect(stored.message.content.__spaceassistant_spill_v1.kind).toBe('source-of-truth')
    await expect(history.read('spill-assistant-response-invocation')).resolves.toMatchObject({ events: [
      { payload: { message: { content: responseText } } }
    ] })
    db.close()
  })

  it('spills the duplicated terminal outputText and restores it for completed-invocation recovery', async () => {
    const { store } = await createStore()
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'spill-terminal-output-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'spill-generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId, store)
    const outputText = 'terminal output copy '.repeat(8_000)
    await history.appendBatch([{
      invocationId: 'spill-terminal-output-invocation', turnId: 'spill-terminal-output-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-terminal-output-event', idempotencyKey: 'spill-terminal-output-event', kind: 'invocation-completed',
      payload: { status: 'completed', outputText }
    }], 0)
    const stored = JSON.parse(conn.prepare('SELECT payload_json FROM agent_history_events WHERE event_id=?')
      .get('spill-terminal-output-event')!.payload_json as string) as { outputText: { __spaceassistant_spill_v1: { kind: string } } }
    expect(stored.outputText.__spaceassistant_spill_v1.kind).toBe('source-of-truth')
    await expect(history.readCompletedInvocationForSession('spill-terminal-output-invocation', sessionId)).toMatchObject({ outputText })
    db.close()
  })

  it('stores large terminal protocol transcript snapshots as source-truth locators and hydrates the committed snapshot', async () => {
    const temp = createTempDatabase('session-spill-transcript-')
    const root = path.join(path.dirname(temp.dbPath), 'spill')
    const store = createSpillStore(root)
    const db = temp.db
    const conn = getDbConnection(db)
    const sessionId = 'spill-transcript-snapshot-session'
    const turnId = 'spill-transcript-snapshot-turn'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'spill-generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId, store)
    const body = 'protocol transcript body '.repeat(8_000)
    await history.appendBatch([{
      invocationId: turnId, turnId, sequence: 1, schemaVersion: 1, eventId: 'spill-transcript-terminal',
      idempotencyKey: 'spill-transcript-terminal', kind: 'invocation-completed', payload: { status: 'completed' }
    }], 0, { sessionId, baseVersion: 0, outcome: 'completed', messages: [{ role: 'assistant', content: body }] })
    const stored = JSON.parse(conn.prepare('SELECT messages_json FROM session_transcript_entries WHERE session_id=?').get(sessionId)!.messages_json as string)
    expect(stored).toMatchObject({ __spaceassistant_session_transcript_spill_v1: { kind: 'source-of-truth' } })
    expect(readSessionTranscript(db, sessionId).messages).toEqual([{ role: 'assistant', content: body }])
    temp.cleanup()
  })

  it('never removes a source-truth transcript locator when degradable retention expires', async () => {
    const temp = createTempDatabase('session-spill-transcript-retention-')
    const root = path.join(path.dirname(temp.dbPath), 'spill')
    const store = createSpillStore(root)
    const db = temp.db
    const conn = getDbConnection(db)
    const sessionId = 'spill-transcript-retention-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'spill-generation')`).run(sessionId)
    setConfigValue(db, 'retention.spill.degradableDays', '1')
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId, store)
    const body = 'retention protected transcript '.repeat(8_000)
    await history.appendBatch([{
      invocationId: 'spill-transcript-retention-turn', turnId: 'spill-transcript-retention-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-transcript-retention-event', idempotencyKey: 'spill-transcript-retention-event', kind: 'invocation-completed', payload: { status: 'completed' }
    }], 0, { sessionId, baseVersion: 0, outcome: 'completed', messages: [{ role: 'assistant', content: body }] })

    const stored = JSON.parse(conn.prepare('SELECT messages_json FROM session_transcript_entries WHERE session_id=?').get(sessionId)!.messages_json as string) as {
      __spaceassistant_session_transcript_spill_v1: { locator: string }
    }
    const locator = stored.__spaceassistant_session_transcript_spill_v1.locator
    await expect(runSpillRetentionMaintenance(db, root, Date.now() + 3 * 24 * 60 * 60 * 1000)).resolves.toEqual([])
    await expect(fs.readFile(path.join(root, locator), 'utf8')).resolves.toContain(body.slice(0, 100))
    temp.cleanup()
  })

  it('folds a spilled assistant response byte-for-byte through cold L2 and warm L1 transcript reads', async () => {
    const { root, store } = await createStore()
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'spill-transcript-fold-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'spill-generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, () => 100, sessionId, store)
    const answer = 'canonical spilled assistant answer '.repeat(8_000)
    const legacy = [
      { id: 'spill-fold-user', role: 'user' as const, content: 'question', timestamp: 1 },
      { id: 'spill-fold-assistant', role: 'assistant' as const, content: answer, timestamp: 2 }
    ]
    await history.appendBatch([{
      invocationId: 'spill-transcript-fold-invocation', turnId: 'spill-transcript-fold-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-transcript-fold-context', idempotencyKey: 'spill-transcript-fold-context', kind: 'invocation-context-committed',
      payload: { messages: [{ role: 'user', content: 'question', id: 'spill-fold-user', timestamp: 1 }] }
    }, {
      invocationId: 'spill-transcript-fold-invocation', turnId: 'spill-transcript-fold-turn', sequence: 2, schemaVersion: 1,
      eventId: 'spill-transcript-fold-response', idempotencyKey: 'spill-transcript-fold-response', kind: 'model-response-committed',
      payload: { message: { role: 'assistant', content: answer, id: 'spill-fold-assistant', timestamp: 2 } }
    }, {
      invocationId: 'spill-transcript-fold-invocation', turnId: 'spill-transcript-fold-turn', sequence: 3, schemaVersion: 1,
      eventId: 'spill-transcript-fold-terminal', idempotencyKey: 'spill-transcript-fold-terminal', kind: 'invocation-completed', payload: { status: 'completed' }
    }], 0)

    const cold = history.readCanonicalSessionTranscriptWithCache(sessionId, 'transcript', legacy)
    expect(cold).toMatchObject({ kind: 'matched', source: 'L2', messages: legacy })
    const warm = history.readCanonicalSessionTranscriptWithCache(sessionId, 'transcript', legacy)
    expect(warm).toMatchObject({ kind: 'matched', source: 'L1', messages: legacy })
    db.close()
  })

  it('stores oversized provider context text and image bytes as source-truth and hydrates both on resume', async () => {
    const { store } = await createStore()
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'spill-provider-context-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'spill-generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId, store)
    const contextText = 'provider context body '.repeat(8_000)
    const imageData = 'a'.repeat(100_000)
    await history.appendBatch([{
      invocationId: 'spill-provider-context-invocation', turnId: 'spill-provider-context-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-provider-context-event', idempotencyKey: 'spill-provider-context-event', kind: 'invocation-context-committed',
      payload: { messages: [{ role: 'user', content: [
        { type: 'text', text: contextText }, { type: 'image', mimeType: 'image/png', data: imageData }
      ] }] }
    }], 0)
    const stored = JSON.parse(conn.prepare('SELECT payload_json FROM agent_history_events WHERE event_id=?')
      .get('spill-provider-context-event')!.payload_json as string) as { messages: Array<{ content: Array<{ text?: unknown; data?: unknown }> }> }
    expect(stored.messages[0]!.content[0]!.text).toMatchObject({ __spaceassistant_spill_v1: { kind: 'source-of-truth' } })
    expect(stored.messages[0]!.content[1]!.data).toMatchObject({ __spaceassistant_spill_v1: { kind: 'source-of-truth' } })
    await expect(history.read('spill-provider-context-invocation')).resolves.toMatchObject({ events: [
      { payload: { messages: [{ content: [{ text: contextText }, { data: imageData }] }] } }
    ] })
    db.close()
  })

  it('keeps SQLite growth below ten percent of canonical tool and response bodies over twenty turns', async () => {
    const { store } = await createStore()
    const temp = createTempDatabase('session-spill-growth-')
    const conn = getDbConnection(temp.db)
    const sessionId = 'spill-growth-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'spill-generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId, store)
    const beforeBytes = Number((conn.prepare('PRAGMA page_count').get() as { page_count: number }).page_count) *
      Number((conn.prepare('PRAGMA page_size').get() as { page_size: number }).page_size)
    const body = 'large canonical answer '.repeat(5_000)
    const bodyBytes = Buffer.byteLength(body)
    let canonicalBytes = 0
    const transcript: Array<{ role: string; content: string }> = []
    for (let turn = 1; turn <= 20; turn += 1) {
      const invocationId = `spill-growth-${turn}`
      const turnId = `spill-growth-turn-${turn}`
      transcript.push({ role: 'assistant', content: body })
      canonicalBytes += bodyBytes * 2 + Buffer.byteLength(JSON.stringify(transcript))
      await history.appendBatch([{
        invocationId, turnId, sequence: 1, schemaVersion: 1,
        eventId: `spill-growth-event-${turn}-response`, idempotencyKey: `spill-growth-event-${turn}-response`, kind: 'model-response-committed',
        payload: { message: { role: 'assistant', content: body } }
      }], 0)
      await history.appendBatch([{
        invocationId, turnId, sequence: 2, schemaVersion: 1,
        eventId: `spill-growth-event-${turn}-terminal`, idempotencyKey: `spill-growth-event-${turn}-terminal`, kind: 'invocation-completed',
        payload: { status: 'completed', outputText: body }
      }], 1, { sessionId, baseVersion: turn - 1, outcome: 'completed', messages: transcript })
    }
    const afterBytes = Number((conn.prepare('PRAGMA page_count').get() as { page_count: number }).page_count) *
      Number((conn.prepare('PRAGMA page_size').get() as { page_size: number }).page_size)
    const dbGrowth = afterBytes - beforeBytes
    expect(dbGrowth).toBeLessThanOrEqual(canonicalBytes * 0.1)
    temp.cleanup()
  })

  it('reopens SQLite and hydrates committed spill locators while reclaiming unreferenced files', async () => {
    const temp = createTempDatabase('session-spill-reopen-')
    const root = path.join(path.dirname(temp.dbPath), 'spill')
    const store = createSpillStore(root)
    const conn = getDbConnection(temp.db)
    const sessionId = 'spill-reopen-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'spill-generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId, store)
    const body = 'survives process restart '.repeat(6_000)
    await history.appendBatch([{
      invocationId: 'spill-reopen-invocation', turnId: 'spill-reopen-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-reopen-event', idempotencyKey: 'spill-reopen-event', kind: 'model-response-committed',
      payload: { message: { role: 'assistant', content: body } }
    }], 0)
    const orphan = await store.commitSourceTruth('unreferenced crash residue', () => undefined)
    temp.db.close()

    const reopenedDb = openDatabase(temp.dbPath)
    const reopenedHistory = new SqliteAgentHistory(getDbConnection(reopenedDb), 1, Date.now, sessionId)
    await expect(reopenedHistory.read('spill-reopen-invocation')).resolves.toMatchObject({ events: [
      { payload: { message: { content: body } } }
    ] })
    await expect(reconcileSpillOrphansAgainstCanonicalHistory(createSpillStore(root), getDbConnection(reopenedDb))).resolves.toEqual([orphan.locator])
    reopenedDb.close()
    temp.cleanup()
  })

  it('keeps a durable adapter spill after canonical rollback and reclaims it only after a reopened full reference scan', async () => {
    const temp = createTempDatabase('session-spill-rollback-')
    const root = path.join(path.dirname(temp.dbPath), 'spill')
    const store = createSpillStore(root)
    const conn = getDbConnection(temp.db)
    const sessionId = 'spill-rollback-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'spill-generation')`).run(sessionId)
    conn.exec(`CREATE TRIGGER reject_source_locator BEFORE INSERT ON agent_history_events BEGIN SELECT RAISE(ABORT, 'reject canonical locator'); END;`)
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId, store)
    await expect(history.appendBatch([{
      invocationId: 'spill-rollback-invocation', turnId: 'spill-rollback-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-rollback-event', idempotencyKey: 'spill-rollback-event', kind: 'model-response-committed',
      payload: { message: { role: 'assistant', content: 'rollback source payload '.repeat(8_000) } }
    }], 0)).rejects.toThrow(/reject canonical locator/)
    const orphan = (await fs.readdir(root)).find((name) => name.endsWith('.spill'))
    expect(orphan).toBeTruthy()
    temp.db.close()

    const reopened = openDatabase(temp.dbPath)
    await expect(reconcileSpillOrphansAgainstCanonicalHistory(createSpillStore(root), getDbConnection(reopened))).resolves.toEqual([orphan])
    reopened.close()
    temp.cleanup()
  })

  it('durably writes a complete source payload before committing its canonical locator', async () => {
    const { root, store } = await createStore()
    const payload = 'authoritative provider context '.repeat(128)
    let committedDescriptor: Awaited<ReturnType<typeof store.commitSourceTruth>> | undefined
    const descriptor = await store.commitSourceTruth(payload, async (candidate) => {
      expect(await fs.readFile(path.join(root, candidate.locator), 'utf8')).toBe(payload)
      committedDescriptor = candidate
    })

    expect(descriptor).toMatchObject({ kind: 'source-of-truth', byteLength: Buffer.byteLength(payload), sha256: expect.any(String) })
    expect(committedDescriptor).toEqual(descriptor)
    if (process.platform !== 'win32') {
      expect((await fs.stat(path.join(root, descriptor.locator))).mode & 0o777).toBe(0o600)
      expect((await fs.stat(root)).mode & 0o777).toBe(0o700)
    }
    await expect(store.readSourceTruth(descriptor)).resolves.toBe(payload)
  })

  it('does not invoke the canonical commit callback when durable spill preparation fails', async () => {
    const { root, store } = await createStore()
    const invalidRoot = path.join(root, 'not-a-directory')
    await fs.writeFile(invalidRoot, 'file blocks spill directory creation')
    const blockedStore = createSpillStore(invalidRoot)
    const commitCanonicalLocator = vi.fn()

    await expect(blockedStore.commitSourceTruth('keep inline on failure', commitCanonicalLocator)).rejects.toThrow()
    expect(commitCanonicalLocator).not.toHaveBeenCalled()
  })

  it('keeps an unreferenced durable file after locator commit failure for full-scan orphan reconciliation', async () => {
    const { root, store } = await createStore()
    let locator = ''
    await expect(store.commitSourceTruth('complete payload', async (descriptor) => {
      locator = descriptor.locator
      throw new Error('canonical transaction failed')
    })).rejects.toThrow('canonical transaction failed')
    await expect(fs.stat(path.join(root, locator))).resolves.toBeTruthy()
    await expect(store.reconcileOrphans({ referencedLocators: new Set(), fullReferenceScanComplete: false })).rejects.toThrow(/full reference scan/)
    await expect(store.reconcileOrphans({ referencedLocators: new Set(), fullReferenceScanComplete: true })).resolves.toEqual([locator])
    await expect(fs.stat(path.join(root, locator))).rejects.toThrow()
  })

  it('commits the locator in a real canonical History transaction before reporting source spill success', async () => {
    const { store } = await createStore()
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'spill-canonical-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'spill-generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId)
    const descriptor = await store.commitSourceTruth('authoritative spill text', async (spill) => {
      await history.appendBatch([{
        invocationId: 'spill-invocation', turnId: 'spill-turn', sequence: 1, schemaVersion: 1,
        eventId: 'spill-locator-event', idempotencyKey: 'spill-locator-event', kind: 'invocation-context-committed',
        payload: { messages: [], spill }
      }], 0)
    })

    const committed = await history.read('spill-invocation')
    expect(committed.events[0]?.payload).toEqual({ messages: [], spill: descriptor })
    await expect(store.readSourceTruth(descriptor)).resolves.toBe('authoritative spill text')
    const orphan = await store.commitSourceTruth('not referenced by canonical history', async () => undefined)
    await expect(reconcileSpillOrphansAgainstCanonicalHistory(store, conn)).resolves.toEqual([orphan.locator])
    await expect(store.readSourceTruth(descriptor)).resolves.toBe('authoritative spill text')
    db.close()
  })

  it('leaves an SQLite transaction failure as a recoverable orphan, never a successful locator', async () => {
    const { store } = await createStore()
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'spill-rollback-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'spill-generation')`).run(sessionId)
    conn.exec(`CREATE TRIGGER fail_spill_locator BEFORE INSERT ON agent_history_events BEGIN SELECT RAISE(ABORT, 'locator rejected'); END;`)
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId)
    let attemptedLocator = ''
    await expect(store.commitSourceTruth('orphan until full scan', async (spill) => {
      attemptedLocator = spill.locator
      await history.appendBatch([{
        invocationId: 'spill-failed-invocation', turnId: 'spill-failed-turn', sequence: 1, schemaVersion: 1,
        eventId: 'spill-failed-event', idempotencyKey: 'spill-failed-event', kind: 'invocation-context-committed', payload: { messages: [], spill }
      }], 0)
    })).rejects.toThrow('locator rejected')

    expect((await history.read('spill-failed-invocation')).events).toEqual([])
    await expect(reconcileSpillOrphansAgainstCanonicalHistory(store, conn)).resolves.toEqual([attemptedLocator])
    db.close()
  })

  it('preserves source spill when the canonical commit succeeds but its acknowledgement is lost', async () => {
    const { store } = await createStore()
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'spill-uncertain-commit-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'spill-generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId)
    let descriptor: Awaited<ReturnType<typeof store.commitSourceTruth>> | undefined
    await expect(store.commitSourceTruth('committed despite lost acknowledgement', async (spill) => {
      descriptor = spill
      await history.appendBatch([{
        invocationId: 'spill-uncertain-invocation', turnId: 'spill-uncertain-turn', sequence: 1, schemaVersion: 1,
        eventId: 'spill-uncertain-event', idempotencyKey: 'spill-uncertain-event', kind: 'invocation-context-committed', payload: { messages: [], spill }
      }], 0)
      throw new Error('commit acknowledgement lost')
    })).rejects.toThrow('commit acknowledgement lost')

    const references = await history.read('spill-uncertain-invocation')
    expect(references.events[0]?.payload).toEqual({ messages: [], spill: descriptor })
    await expect(reconcileSpillOrphansAgainstCanonicalHistory(store, conn)).resolves.toEqual([])
    await expect(store.readSourceTruth(descriptor!)).resolves.toBe('committed despite lost acknowledgement')
    db.close()
  })

  it('hard-fails missing or corrupted source-of-truth content with a stable error code', async () => {
    const { root, store } = await createStore()
    const descriptor = await store.commitSourceTruth('required source content', async () => undefined)
    await fs.writeFile(path.join(root, descriptor.locator), 'corrupted')
    await expect(store.readSourceTruth(descriptor)).rejects.toMatchObject<Partial<SpillContentUnavailableError>>({
      code: 'SPILL_CONTENT_UNAVAILABLE'
    })
    await fs.rm(path.join(root, descriptor.locator))
    await expect(store.readSourceTruth(descriptor)).rejects.toMatchObject({ code: 'SPILL_CONTENT_UNAVAILABLE' })
  })

  it('uses a visible placeholder for degraded reads and audits retention deletion', async () => {
    const { root, store } = await createStore()
    const audit = vi.spyOn(agentLoggerModule, 'logAgentEvent').mockImplementation(() => undefined)
    const descriptor = await store.writeDegradable('exact canonical duplicate', { canonicalEquivalent: true })
    expect(descriptor).toBeDefined()
    await fs.rm(path.join(root, descriptor!.locator))
    await expect(store.readDegradable(descriptor!)).resolves.toBe('[内容已归档]')

    const notExpired = await store.pruneDegradable([descriptor!], { retentionDays: 1 })
    expect(notExpired).toEqual([])
    const removed = await store.pruneDegradable([descriptor!], { retentionDays: 1, now: descriptor!.createdAt + 2 * 24 * 60 * 60 * 1000 })
    expect(removed).toEqual([descriptor!.locator])
    expect(audit).toHaveBeenCalledWith('info', 'retention.spill.cleaned', expect.objectContaining({ retentionDays: 1, removed: [descriptor!.locator] }))
  })

  it('keeps the canonical fold byte-for-byte unchanged when an exact degradable copy expires', async () => {
    const { store } = await createStore()
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'spill-degradable-fold-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'spill-generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId)
    const canonicalMessages = [{ role: 'user', content: 'canonical long diagnostic excerpt', id: 'spill-fold-user', timestamp: 1 }]
    await history.appendBatch([{
      invocationId: 'spill-fold-invocation', turnId: 'spill-fold-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-fold-event', idempotencyKey: 'spill-fold-event', kind: 'invocation-context-committed', payload: { messages: canonicalMessages }
    }], 0)
    const canonicalFold = async () => rebuildClaudeMessagesFromHistory((await history.read('spill-fold-invocation')).events)
    const before = await canonicalFold()
    const copy = await store.writeDegradable(canonicalMessages[0]!.content, { canonicalEquivalent: true })
    await expect(store.readDegradable(copy)).resolves.toBe(canonicalMessages[0]!.content)

    await expect(store.pruneDegradable([copy], { retentionDays: 1, now: copy.createdAt + 2 * 24 * 60 * 60 * 1000 })).resolves.toEqual([copy.locator])
    expect(await canonicalFold()).toEqual(before)
    expect(before).toEqual([{ role: 'user', content: canonicalMessages[0]!.content, id: 'spill-fold-user', timestamp: 1 }])
    db.close()
  })

  it('applies configured retention only to canonical-referenced degradable spill', async () => {
    const { root, store } = await createStore()
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    const sessionId = 'spill-retention-session'
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES(?, 's','m',0.7,1,1,1,'{}','{}',1,'spill-generation')`).run(sessionId)
    const history = new SqliteAgentHistory(conn, 1, Date.now, sessionId)
    const source = await store.commitSourceTruth('must survive retention', async (spill) => {
      await history.appendBatch([{
        invocationId: 'spill-retention-source', turnId: 'spill-retention-source-turn', sequence: 1, schemaVersion: 1,
        eventId: 'spill-retention-source-event', idempotencyKey: 'spill-retention-source-event', kind: 'invocation-context-committed', payload: { messages: [], spill }
      }], 0)
    })
    const degradable = await store.writeDegradable('reconstructible copy', { canonicalEquivalent: true })
    await history.appendBatch([{
      invocationId: 'spill-retention-degradable', turnId: 'spill-retention-degradable-turn', sequence: 1, schemaVersion: 1,
      eventId: 'spill-retention-degradable-event', idempotencyKey: 'spill-retention-degradable-event', kind: 'invocation-context-committed', payload: { messages: [], spill: degradable }
    }], 0)
    setConfigValue(db, 'retention.spill.degradableDays', '1')

    const removed = await runSpillRetentionMaintenance(db, root, Math.max(source.createdAt, degradable.createdAt) + 2 * 24 * 60 * 60 * 1000)

    expect(removed).toEqual([degradable.locator])
    await expect(fs.readFile(path.join(root, source.locator), 'utf8')).resolves.toBe('must survive retention')
    await expect(fs.stat(path.join(root, degradable.locator))).rejects.toThrow()
    db.close()
  })

  it('rejects degradable spills without canonical equivalence and never prunes source-of-truth data', async () => {
    const { root, store } = await createStore()
    await expect(store.writeDegradable('non-reconstructible', { canonicalEquivalent: false })).rejects.toThrow(/canonical history/)
    const descriptor = await store.commitSourceTruth('required', async () => undefined)
    await expect(store.pruneDegradable([descriptor], { retentionDays: 1 })).rejects.toThrow(/source-of-truth/)
    await expect(fs.readFile(path.join(root, descriptor.locator), 'utf8')).resolves.toBe('required')
  })
})
