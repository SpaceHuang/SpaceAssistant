import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { createSession, setConfigValue } from '../database/operations'
import { sessionLedgerLocationIdentity } from '../sessionLedgerIdentity'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { bootstrapEmptySessionEventLedger, getSessionEventSink, readSessionEvents, resolveSessionEventPaths, setSessionEventCommitObserver } from '../sessionEvents'
import { ensureLegacyLedgerReadiness, refreshSessionLedgerReadyProof } from '../sessionLedgerReadiness'
import { ensureSessionLedgerReady } from '../sessionLedgerLifecycle'
import { createProductionSessionLedgerLifecycleDependencies } from './sessionLedgerLifecycleProduction'
import { createSessionLedgerCompactionDependencyGuard } from '../sessionStorage/infrastructure/sqlite/sessionEventRetentionAdapter'
import { runSessionEventRetentionMaintenance } from '../storage/sessionEventRetention'
import { computeCompactionSummaryHash } from '../../src/shared/compactionEvents'

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

  it('migrates a healthy legacy ready proof to a full-prefix proof in place', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-legacy-proof-upgrade-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'legacy-proof-upgrade', workDirProfileId: 'profile' })
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const conn = getDbConnection(db)
    const dependencies = createProductionSessionLedgerLifecycleDependencies(conn)
    const ready = () => ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
      processGeneration: 1, dependencies })
    expect((await ready()).status).toBe('ready')
    conn.prepare("UPDATE session_ledger_projection_state SET proof_tail_frame=substr(proof_tail_frame,6) WHERE session_id=?")
      .run(session.id)

    const upgraded = await ready()

    expect(upgraded.status).toBe('ready')
    expect(upgraded.readiness.proofTailFrame).toMatch(/^full:/)
    expect(upgraded.readiness.failureClass).toBeNull()
  })

  it('continues a healthy legacy dirty proof after verifying its previous boundary', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-legacy-dirty-upgrade-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'legacy-dirty-upgrade', workDirProfileId: 'profile' })
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const conn = getDbConnection(db)
    const dependencies = createProductionSessionLedgerLifecycleDependencies(conn)
    const ready = () => ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
      processGeneration: 1, dependencies })
    expect((await ready()).status).toBe('ready')
    conn.prepare("UPDATE session_ledger_projection_state SET proof_tail_frame=substr(proof_tail_frame,6) WHERE session_id=?")
      .run(session.id)

    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{
      invocationId: 'legacy-invocation', turnId: 'legacy-turn', sequence: 1, schemaVersion: 1,
      eventId: 'legacy-event', idempotencyKey: 'legacy-event', kind: 'model-response-committed',
      payload: { modelTurn: 1, message: { role: 'assistant', toolCalls: [{ id: 'legacy-tool', name: 'read_file', input: { path: 'a' } }] },
        sessionLedger: { location, stepId: 'legacy-step', toolCalls: [{ toolUseId: 'legacy-tool', name: 'read_file', args: { path: 'a' } }] } }
    }], 0)

    const upgraded = await ready()

    expect(upgraded).toMatchObject({ status: 'ready', readiness: { state: 'ready', proofTailFrame: expect.stringMatching(/^full:/) } })
    expect((await readSessionEvents(resolveSessionEventPaths(root, session.id, session.createdAt).eventsPath))
      .map(({ payload }) => payload.toolUseId)).toContain('legacy-tool')
  })

  it('blocks incremental projection when previously proved ledger bytes were truncated and the writer regrows the file', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-truncated-proof-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'truncated-proof', workDirProfileId: 'profile' })
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const conn = getDbConnection(db)
    const dependencies = createProductionSessionLedgerLifecycleDependencies(conn)
    const ready = () => ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
      processGeneration: 1, dependencies })
    expect((await ready()).status).toBe('ready')

    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    const append = (sequence: number) => history.appendBatch([{
      invocationId: 'invocation', turnId: 'turn', sequence, schemaVersion: 1,
      eventId: `event-${sequence}`, idempotencyKey: `event-${sequence}`, kind: 'model-response-committed',
      payload: { modelTurn: sequence, message: { role: 'assistant', toolCalls: [{ id: `tool-${sequence}`, name: 'read_file', input: { path: 'a' } }] },
        sessionLedger: { location, stepId: `step-${sequence}`, toolCalls: [{ toolUseId: `tool-${sequence}`, name: 'read_file', args: { path: 'a' } }] } }
    }], sequence - 1)
    await append(1)
    expect((await ready()).status).toBe('ready')
    conn.prepare("UPDATE session_ledger_projection_state SET proof_tail_frame=substr(proof_tail_frame,6) WHERE session_id=?")
      .run(session.id)

    await getSessionEventSink(root, session.id, session.createdAt).close()
    const paths = resolveSessionEventPaths(root, session.id, session.createdAt)
    await fs.truncate(paths.eventsPath, 0)
    await append(2)
    const writer = getSessionEventSink(root, session.id, session.createdAt)
    await writer.appendCritical({ type: 'assistant_chunk', payload: { turnId: 'turn', content: 'x'.repeat(2048) } })
    await writer.appendCritical({ type: 'assistant_chunk', payload: { turnId: 'turn', content: 'y'.repeat(2048) } })
    await writer.close()

    const result = await ready()
    expect(result).toMatchObject({ status: 'blocked', readiness: {
      state: 'blocked', retryScope: 'baseline', failureClass: 'physical_proof_mismatch'
    } })
    expect((await readSessionEvents(paths.eventsPath)).map((event) => event.payload.toolUseId)).not.toContain('tool-1')
    expect(conn.prepare("SELECT status FROM session_ledger_projection_outbox WHERE canonical_event_id='event-2'").get())
      .toEqual({ status: 'pending' })
    expect((await ready()).status).toBe('blocked')
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

  it('rebuilds only a blocked legacy session ledger from canonical History when its entire directory is missing', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-missing-rebuild-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'missing-ledger-rebuild', workDirProfileId: 'profile' })
    const otherSession = createSession(db, { name: 'unrelated-session', workDirProfileId: 'profile' })
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const conn = getDbConnection(db)
    const identity = sessionLedgerLocationIdentity(location)
    conn.prepare(`UPDATE session_ledger_projection_state SET origin='legacy',bootstrap_id=NULL,state='blocked',retry_scope='baseline',
      failure_class='ledger_missing',canonical_watermark=NULL,proof_file_identity=NULL,proof_file_bytes=NULL,proof_tail_frame=NULL,
      proof_index_seq=NULL,proof_index_event_count=NULL,proof_index_bytes=NULL,proof_index_last_at=NULL WHERE ledger_location_key=?`)
      .run(identity.key)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    const compactionCandidate = { kind: 'summary', checkpointMessage: { id: 'missing-checkpoint', role: 'user', content: 'checkpoint snapshot' },
      checkpointReplayIdentity: 'checkpoint-replay-identity', shadowedRanges: [{ start: 'old-start', end: 'old-end' }] }
    const compactionStart = { compactionId: 'missing-manual-compaction', windowId: 'manual-window', inputSurfaceFingerprint: 'input-fingerprint',
      surfaceBoundaryId: 'old-end', targetTokens: 0, reason: 'user_compact', sourceRequestId: 'manual-request' }
    const compactionSummary = { compactionId: compactionStart.compactionId, windowId: compactionStart.windowId,
      summaryHash: computeCompactionSummaryHash(compactionCandidate), outputSurfaceFingerprint: 'output-fingerprint',
      shadowedRanges: compactionCandidate.shadowedRanges, candidate: compactionCandidate }
    await history.appendBatch([{
      invocationId: 'rebuild-invocation', turnId: 'rebuild-turn', sequence: 1, schemaVersion: 1,
      eventId: 'rebuild-model-response', idempotencyKey: 'rebuild-model-response', kind: 'model-response-committed',
      payload: { modelTurn: 1, message: { role: 'assistant', toolCalls: [{ id: 'rebuild-tool', name: 'read_file', input: { path: 'canonical.txt' } }] },
        sessionLedger: { location, stepId: 'rebuild-step', toolCalls: [{ toolUseId: 'rebuild-tool', name: 'read_file', args: { path: 'canonical.txt' } }],
          requestUsage: { requestId: 'rebuild-request', usage: { inputTokens: 10, outputTokens: 2 } } } }
    }], 0)
    await history.appendBatch([{
      invocationId: 'manual-compaction-invocation', turnId: 'manual-compaction-invocation', sequence: 1, schemaVersion: 1,
      eventId: 'manual-compaction-canonical-event', idempotencyKey: 'manual-compaction-canonical-event', kind: 'transcript-compacted',
      payload: { compactionId: compactionStart.compactionId, messages: [compactionCandidate.checkpointMessage],
        sessionLedger: { location, start: compactionStart, summary: compactionSummary },
        surfaceReplay: { windowId: 'manual-window', inputFingerprint: 'input-fingerprint', outputFingerprint: 'output-fingerprint', checkpointReplayIdentity: 'checkpoint-replay-identity' } }
    }, {
      invocationId: 'manual-compaction-invocation', turnId: 'manual-compaction-invocation', sequence: 2, schemaVersion: 1,
      eventId: 'manual-compaction-completed', idempotencyKey: 'manual-compaction-completed', kind: 'invocation-completed',
      payload: { status: 'completed', completedAt: 2 }
    }], 0)

    const dependencies = createProductionSessionLedgerLifecycleDependencies(conn)
    const firstRecovery = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1,
      retryBlocked: true, dependencies })
    expect(firstRecovery).toMatchObject({ status: 'ready' })
    expect(conn.prepare("SELECT status FROM session_ledger_projection_outbox WHERE canonical_event_id='rebuild-model-response'").get())
      .toEqual({ status: 'acked' })
    const simulateWholeLedgerLoss = async () => {
      await fs.rm(resolveSessionEventPaths(root, session.id, session.createdAt).directory, { recursive: true, force: true })
      conn.prepare(`UPDATE session_ledger_projection_state SET state='blocked',retry_scope='baseline',failure_class='ledger_missing',
        canonical_watermark=NULL,proof_file_identity=NULL,proof_file_bytes=NULL,proof_tail_frame=NULL,proof_index_seq=NULL,
        proof_index_event_count=NULL,proof_index_bytes=NULL,proof_index_last_at=NULL WHERE ledger_location_key=?`).run(identity.key)
    }
    await simulateWholeLedgerLoss()

    const result = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1,
      retryBlocked: true, dependencies })

    expect(result).toMatchObject({ status: 'ready', readiness: { state: 'ready', failureClass: null } })
    const paths = resolveSessionEventPaths(root, session.id, session.createdAt)
    const events = await readSessionEvents(paths.eventsPath)
    expect(events.map((event) => event.type)).toContain('tool_call')
    expect(events.find((event) => event.type === 'tool_call')?.payload).toMatchObject({
      toolUseId: 'rebuild-tool', name: 'read_file', args: { path: 'canonical.txt' }, turnId: 'rebuild-turn'
    })
    expect(events.map(({ type }) => type)).toContain('request_usage')
    const compactedEvent = events.find(({ type }) => type === 'compaction_summary')
    expect(compactedEvent?.payload).toMatchObject({ compactionId: compactionStart.compactionId,
      candidate: { checkpointReplayIdentity: 'checkpoint-replay-identity' }, outputSurfaceFingerprint: 'output-fingerprint' })
    expect(events.map(({ type }) => type).filter((type) => type.startsWith('compaction_')))
      .toEqual(['compaction_start', 'compaction_summary', 'compaction_end'])
    expect(await fs.stat(resolveSessionEventPaths(root, otherSession.id, otherSession.createdAt).eventsPath).catch(() => undefined)).toBeUndefined()
    expect(conn.prepare("SELECT status FROM session_ledger_projection_outbox WHERE canonical_event_id='rebuild-model-response'").get())
      .toEqual({ status: 'acked' })

    await simulateWholeLedgerLoss()
    conn.prepare("UPDATE session_ledger_projection_outbox SET status='pending',acked_at=NULL WHERE ledger_location_key=? AND projection_kind='request-usage'")
      .run(identity.key)
    const mixedRetry = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1,
      retryBlocked: true, dependencies })
    expect(mixedRetry.status).toBe('ready')
    const mixedEvents = await readSessionEvents(paths.eventsPath)
    expect(mixedEvents.filter(({ type }) => type === 'tool_call')).toHaveLength(1)
    expect(mixedEvents.filter(({ type }) => type === 'request_usage')).toHaveLength(1)

    await simulateWholeLedgerLoss()
    const originalAppendFile = fs.appendFile.bind(fs)
    let appendCount = 0
    const appendSpy = vi.spyOn(fs, 'appendFile').mockImplementation(async (filePath, data, ...options) => {
      appendCount += 1
      if (appendCount === 2) throw new Error('injected rebuild projection interruption')
      return originalAppendFile(filePath, data, ...options)
    })
    try {
      const interrupted = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1,
        retryBlocked: true, dependencies })
      expect(interrupted).toMatchObject({ status: 'blocked', readiness: { state: 'blocked', failureClass: 'baseline_failed' } })
    } finally { appendSpy.mockRestore() }
    const resumed = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1,
      retryBlocked: true, dependencies })
    expect(resumed.status).toBe('ready')
    const resumedEvents = await readSessionEvents(paths.eventsPath)
    expect(resumedEvents.filter(({ type }) => type === 'tool_call')).toHaveLength(1)
    expect(resumedEvents.filter(({ type }) => type === 'request_usage')).toHaveLength(1)
    expect(conn.prepare("SELECT status FROM session_ledger_projection_outbox WHERE ledger_location_key=? AND status<>'acked'").all(identity.key))
      .toEqual([])
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
