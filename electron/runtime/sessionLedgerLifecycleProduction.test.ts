import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { createSession, setConfigValue } from '../database/operations'
import { sessionLedgerLocationIdentity } from '../sessionLedgerIdentity'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { bootstrapEmptySessionEventLedger, getSessionEventSink, readSessionEvents, resolveSessionEventPaths, setSessionEventCommitObserver } from '../sessionEvents'
import { ensureLegacyLedgerReadiness, refreshSessionLedgerReadyProof } from '../sessionLedgerReadiness'
import { ensureSessionLedgerReady } from '../sessionLedgerLifecycle'
import { createProductionSessionLedgerLifecycleDependencies } from './sessionLedgerLifecycleProduction'
import { createSessionLedgerCompactionDependencyGuard, runSessionEventRetentionMaintenance } from '../storage/sessionEventRetention'

describe('production session ledger lifecycle', () => {
  const databases: ReturnType<typeof createMemoryAppDb>[] = []
  const roots: string[] = []
  afterEach(async () => {
    setSessionEventCommitObserver(undefined)
    for (const db of databases.splice(0)) db.close()
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  })

  it('refreshes a ready proof after ordinary ledger-only appends without rescanning the session', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-proof-refresh-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'proof-refresh', workDirProfileId: 'profile' })
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const conn = getDbConnection(db)
    const dependencies = createProductionSessionLedgerLifecycleDependencies(conn)
    const first = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1, dependencies })
    expect(first.status).toBe('ready')

    setSessionEventCommitObserver(async (committedLocation) => {
      const identity = sessionLedgerLocationIdentity(committedLocation)
      const proof = await dependencies.readProof(committedLocation)
      if (proof) refreshSessionLedgerReadyProof(conn, identity.key, proof)
    })
    const sink = getSessionEventSink(root, session.id, session.createdAt)
    await sink.appendCritical({ type: 'assistant_chunk', payload: { turnId: 'ordinary-turn', content: 'hello' } })
    await sink.close()

    const traces: Array<{ baselineScanCount: number }> = []
    const second = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1,
      dependencies, onTrace: (trace) => traces.push(trace) })
    expect(second.status).toBe('ready')
    expect(traces).toMatchObject([{ baselineScanCount: 0 }])
  })

  it('keeps a resumable session ledger through retention and allows the session to reopen', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-retention-resume-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'retention-resume', workDirProfileId: 'profile' })
    setConfigValue(db, 'retention.sessionEvent.maxSessions', '1')
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const conn = getDbConnection(db)
    const dependencies = createProductionSessionLedgerLifecycleDependencies(conn)
    expect((await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1, dependencies })).status).toBe('ready')
    const sink = getSessionEventSink(root, session.id, session.createdAt)
    await sink.close()
    const paths = resolveSessionEventPaths(root, session.id, session.createdAt)
    const index = JSON.parse(await fs.readFile(paths.indexPath, 'utf8')) as { lastAt: number }
    await fs.mkdir(path.join(root, 'sessions', 'newer-20990101'), { recursive: true })
    await fs.writeFile(path.join(root, 'sessions', 'newer-20990101', 'events.index.json'), JSON.stringify({ lastAt: index.lastAt + 1_000_000 }))

    const retention = await runSessionEventRetentionMaintenance(db, root, {
      shouldRetainSessionDir: createSessionLedgerCompactionDependencyGuard(db),
      ensureReadyBeforeDelete: async () => true,
      verifyReadyBeforeDelete: async () => true
    })

    expect(retention.summary.removed).toBe(0)
    expect(retention.summary.retained.map(({ sessionName }) => sessionName)).toContain(path.basename(paths.directory))
    await expect(fs.stat(paths.eventsPath)).resolves.toBeTruthy()
    expect((await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1, dependencies })).status).toBe('ready')
  })

  it('lazily projects a legacy canonical tool proposal into its existing ledger and persists a ready proof', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-lifecycle-production-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'legacy-lifecycle', workDirProfileId: 'profile' })
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'legacy-invocation', turnId: 'legacy-turn', sequence: 1, schemaVersion: 1,
      eventId: 'legacy-model-response', idempotencyKey: 'legacy-model-response', kind: 'model-response-committed',
      payload: { modelTurn: 1, message: { role: 'assistant', toolCalls: [{ id: 'legacy-tool', name: 'read_file', input: { path: 'a.txt' } }] },
        sessionLedger: { location, stepId: 'legacy-step', toolCalls: [{ toolUseId: 'legacy-tool', name: 'read_file', args: { path: 'a.txt' } }] } }
    }], 0)
    const conn = getDbConnection(db)
    conn.prepare('DELETE FROM session_ledger_projection_outbox WHERE session_id=?').run(session.id)
    conn.prepare("UPDATE session_ledger_projection_state SET state='unknown',origin='legacy',bootstrap_id=NULL WHERE session_id=?").run(session.id)
    const legacy = ensureLegacyLedgerReadiness(conn, location, session.generation)
    expect(legacy.origin).toBe('legacy')
    await bootstrapEmptySessionEventLedger(root, session.id, session.createdAt, 'legacy-test-bootstrap')

    const result = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1,
      dependencies: createProductionSessionLedgerLifecycleDependencies(conn) })

    expect(result).toMatchObject({ status: 'ready', readiness: { failureClass: null } })
    const verifySink = getSessionEventSink(root, session.id, session.createdAt)
    const events = await readSessionEvents(verifySink.eventsPath)
    await verifySink.close()
    expect(events.filter((event) => event.type === 'tool_call').map((event) => event.payload)).toEqual([
      { toolUseId: 'legacy-tool', stepId: 'legacy-step', name: 'read_file', args: { path: 'a.txt' }, turnId: 'legacy-turn' }
    ])
    expect(conn.prepare("SELECT status FROM session_ledger_projection_outbox WHERE canonical_event_id='legacy-model-response'").get()).toEqual({ status: 'acked' })
  })

  it('bootstraps a new location from its creation credential before the first ledger-dependent turn', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-new-bootstrap-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'new-bootstrap', workDirProfileId: 'profile' })
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const conn = getDbConnection(db)
    const before = conn.prepare('SELECT origin,state,bootstrap_id FROM session_ledger_projection_state WHERE session_id=?')
      .get(session.id) as { origin: string; state: string; bootstrap_id: string }
    expect(before).toMatchObject({ origin: 'new_location', state: 'uninitialized', bootstrap_id: expect.any(String) })

    const result = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1,
      dependencies: createProductionSessionLedgerLifecycleDependencies(conn) })

    expect(result).toMatchObject({ status: 'ready', readiness: { state: 'ready', origin: 'new_location' } })
    const paths = resolveSessionEventPaths(root, session.id, session.createdAt)
    expect(await fs.readFile(paths.eventsPath, 'utf8')).toBe('')
    expect(JSON.parse(await fs.readFile(paths.indexPath, 'utf8'))).toEqual({ formatVersion: 2, seq: 0, eventCount: 0, bytes: 0, lastAt: 0 })
  })

  it('resumes new-location bootstrap after each durable marker, JSONL and index boundary', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-bootstrap-resume-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const conn = getDbConnection(db)
    for (const boundary of ['initializing', 'marker', 'events', 'index'] as const) {
      const session = createSession(db, { name: `bootstrap-${boundary}`, workDirProfileId: 'profile' })
      const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
      const identity = sessionLedgerLocationIdentity(location)
      const paths = resolveSessionEventPaths(root, session.id, session.createdAt)
      const row = conn.prepare('SELECT bootstrap_id FROM session_ledger_projection_state WHERE session_id=?')
        .get(session.id) as { bootstrap_id: string }
      await fs.mkdir(paths.directory, { recursive: true })
      conn.prepare("UPDATE session_ledger_projection_state SET state='initializing' WHERE session_id=?").run(session.id)
      if (boundary !== 'initializing') {
        await fs.writeFile(paths.bootstrapPath, JSON.stringify({ formatVersion: 1, bootstrapId: row.bootstrap_id, ledgerLocationKey: identity.key }))
      }
      if (boundary === 'events' || boundary === 'index') await fs.writeFile(paths.eventsPath, '')
      if (boundary === 'index') await fs.writeFile(paths.indexPath, JSON.stringify({ formatVersion: 2, seq: 0, eventCount: 0, bytes: 0, lastAt: 0 }))

      const result = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1,
        dependencies: createProductionSessionLedgerLifecycleDependencies(conn) })
      expect(result).toMatchObject({ status: 'ready', readiness: { state: 'ready', bootstrapId: row.bootstrap_id } })
      expect(await fs.readFile(paths.eventsPath, 'utf8')).toBe('')
    }
  })

  it.each(['initializing', 'uninitialized'] as const)('resumes a %s bootstrap across process generations when its ledger files are still missing', async (state) => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-bootstrap-cross-process-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'bootstrap-cross-process', workDirProfileId: 'profile' })
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const conn = getDbConnection(db)
    const row = conn.prepare('SELECT bootstrap_id FROM session_ledger_projection_state WHERE session_id=?').get(session.id) as { bootstrap_id: string }
    conn.prepare('UPDATE session_ledger_projection_state SET state=?,owner_reconciled_process_generation=1 WHERE session_id=?').run(state, session.id)

    const result = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 2,
      dependencies: createProductionSessionLedgerLifecycleDependencies(conn) })

    expect(result).toMatchObject({ status: 'ready', readiness: { state: 'ready', bootstrapId: row.bootstrap_id,
      ownerReconciledProcessGeneration: 2 } })
    const paths = resolveSessionEventPaths(root, session.id, session.createdAt)
    expect(await fs.readFile(paths.eventsPath, 'utf8')).toBe('')
  })

  it('only baselines a previous owner before a canonical process-restart terminal exists', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-owner-recovery-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'prior-owner', workDirProfileId: 'profile' })
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
      invocationId: 'prior-owner-invocation', turnId: 'prior-owner-turn', sequence: 1, schemaVersion: 1,
      eventId: 'prior-owner-proposal', idempotencyKey: 'prior-owner-proposal', kind: 'model-response-committed',
      payload: { modelTurn: 1, message: { role: 'assistant', toolCalls: [{ id: 'prior-owner-tool', name: 'read_file', input: { path: 'old.txt' } }] },
        sessionLedger: { location, stepId: 'prior-owner-step', toolCalls: [{ toolUseId: 'prior-owner-tool', name: 'read_file', args: { path: 'old.txt' } }] } }
    }], 0)
    const conn = getDbConnection(db)
    conn.prepare('DELETE FROM session_ledger_projection_outbox WHERE session_id=?').run(session.id)
    conn.prepare("UPDATE session_ledger_projection_state SET state='unknown',origin='legacy',bootstrap_id=NULL,owner_reconciled_process_generation=0 WHERE session_id=?").run(session.id)
    const sink = getSessionEventSink(root, session.id, session.createdAt)
    await sink.appendCritical({ type: 'turn_start', payload: { turnId: 'prior-owner-turn' } })
    await sink.appendCritical({ type: 'step_start', payload: { turnId: 'prior-owner-turn', stepId: 'prior-owner-step' } })
    await sink.appendCritical({ type: 'tool_call', payload: { toolUseId: 'prior-owner-tool', turnId: 'prior-owner-turn', stepId: 'prior-owner-step', name: 'read_file', args: { path: 'old.txt' } } })
    await sink.close()

    const result = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 2,
      dependencies: createProductionSessionLedgerLifecycleDependencies(conn) })

    expect(result).toMatchObject({ status: 'ready', readiness: { ownerReconciledProcessGeneration: 2 } })
    const verifySink = getSessionEventSink(root, session.id, session.createdAt)
    const events = await readSessionEvents(verifySink.eventsPath)
    await verifySink.close()
    expect(events.map(({ type }) => type)).toEqual(['turn_start', 'step_start', 'tool_call'])
    expect(events.some((event) => event.type === 'tool_result' && event.payload.synthetic === true)).toBe(false)
  })

  it('baselines a previous owner with an active writer and leaves that writer usable', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-active-writer-baseline-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'active-writer-baseline', workDirProfileId: 'profile' })
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const conn = getDbConnection(db)
    const dependencies = createProductionSessionLedgerLifecycleDependencies(conn)
    const initialized = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
      processGeneration: 1, dependencies })
    expect(initialized.status).toBe('ready')
    const sink = getSessionEventSink(root, session.id, session.createdAt)
    await sink.appendCritical({ type: 'turn_start', payload: { turnId: 'active-turn' } })
    conn.prepare("UPDATE session_ledger_projection_state SET state='unknown',origin='legacy',bootstrap_id=NULL,owner_reconciled_process_generation=1 WHERE session_id=?").run(session.id)

    const result = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
      processGeneration: 2, dependencies })

    expect(result).toMatchObject({ status: 'ready', readiness: { ownerReconciledProcessGeneration: 2 } })
    await expect(sink.appendCritical({ type: 'assistant_chunk', payload: { turnId: 'active-turn', content: 'still open' } })).resolves.toMatchObject({ type: 'assistant_chunk' })
    expect((await readSessionEvents(sink.eventsPath)).map(({ type }) => type)).toEqual(['turn_start', 'assistant_chunk'])
    await sink.close()
  })

  it('acks a canonical terminal after desktop finalization adds a legal snapshot', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-terminal-finalize-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'terminal-finalize', workDirProfileId: 'profile' })
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const conn = getDbConnection(db)
    const dependencies = createProductionSessionLedgerLifecycleDependencies(conn)
    expect((await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
      processGeneration: 1, dependencies })).status).toBe('ready')
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{ invocationId: 'finalize-invocation', turnId: 'finalize-turn', sequence: 1, schemaVersion: 1,
      eventId: 'finalize-terminal', idempotencyKey: 'finalize-terminal', kind: 'invocation-failed',
      payload: { status: 'failed', sessionLedger: { location, turnId: 'finalize-turn', reason: 'failed' } } }], 0)
    const sink = getSessionEventSink(root, session.id, session.createdAt)
    await sink.appendCritical({ type: 'turn_start', payload: { turnId: 'finalize-turn' } })
    await sink.appendCritical({ type: 'turn_end', payload: { turnId: 'finalize-turn', reason: 'failed',
      error: 'provider failed', errorCode: 'PROVIDER_ERROR', finalSurfaceSnapshot: { text: 'failed output' } } })

    const result = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
      processGeneration: 1, dependencies })

    expect(result).toMatchObject({ status: 'ready', readiness: { state: 'ready' } })
    expect(conn.prepare("SELECT status FROM session_ledger_projection_outbox WHERE canonical_event_id='finalize-terminal'").get()).toEqual({ status: 'acked' })
    expect((await readSessionEvents(sink.eventsPath)).find(({ type }) => type === 'turn_end')?.payload).toMatchObject({
      reason: 'failed', error: 'provider failed', errorCode: 'PROVIDER_ERROR', finalSurfaceSnapshot: { text: 'failed output' }
    })
    await sink.close()
  })

  it('blocks a missing legacy ledger in production without creating an empty replacement', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-legacy-missing-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'legacy-missing', workDirProfileId: 'profile' })
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const conn = getDbConnection(db)
    conn.prepare("UPDATE session_ledger_projection_state SET state='unknown',origin='legacy',bootstrap_id=NULL WHERE session_id=?").run(session.id)

    const result = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1,
      dependencies: createProductionSessionLedgerLifecycleDependencies(conn) })

    expect(result).toMatchObject({ status: 'blocked', readiness: { state: 'blocked', failureClass: 'ledger_missing' } })
    const paths = resolveSessionEventPaths(root, session.id, session.createdAt)
    await expect(fs.lstat(paths.eventsPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
