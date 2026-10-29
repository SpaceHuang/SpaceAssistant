import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection, openSqliteDatabase } from '../database/sqliteStore'
import { createSession, setConfigValue } from '../database/operations'
import { sessionLedgerLocationIdentity } from '../sessionLedgerIdentity'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { bootstrapEmptySessionEventLedger, getSessionEventSink, readSessionEvents, resolveSessionEventPaths, retireSessionEventSink, setSessionEventCommitObserver } from '../sessionEvents'
import { ensureLegacyLedgerReadiness, markSessionLedgerBlocked, refreshSessionLedgerReadyProof } from '../sessionLedgerReadiness'
import { ensureSessionLedgerReady, runOutsideSessionLedgerLifecycleLock } from '../sessionLedgerLifecycle'
import { createSessionLedgerRepairScheduler } from '../sessionLedgerRepairScheduler'
import { createProductionSessionLedgerLifecycleDependencies } from './sessionLedgerLifecycleProduction'
import { createSessionLedgerCompactionDependencyGuard } from '../sessionStorage/infrastructure/sqlite/sessionEventRetentionAdapter'
import { runSessionEventRetentionMaintenance } from '../storage/sessionEventRetention'
import { computeCompactionSummaryHash } from '../../src/shared/compactionEvents'
import * as sessionLedgerOutbox from '../sessionLedgerOutbox'

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

  it('reads readiness proof from canonical state without opening or hashing the ledger file', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-proof-reuse-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'proof-reuse', workDirProfileId: 'profile' })
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const conn = getDbConnection(db)
    const dependencies = createProductionSessionLedgerLifecycleDependencies(conn)
    expect((await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
      processGeneration: 1, dependencies })).status).toBe('ready')

    const openSpy = vi.spyOn(fs, 'open')
    try {
      expect(await dependencies.readProof(location)).toEqual({ canonicalWatermark: 'session:-1', ledgerGeneration: 0 })
      expect(openSpy).not.toHaveBeenCalled()
    } finally {
      openSpy.mockRestore()
    }
  })

  it('ignores out-of-band same-length file edits in the retired physical proof path', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-proof-cache-invalidation-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'proof-cache-invalidation', workDirProfileId: 'profile' })
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const conn = getDbConnection(db)
    const identity = sessionLedgerLocationIdentity(location)
    const dependencies = createProductionSessionLedgerLifecycleDependencies(conn)
    expect((await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
      processGeneration: 1, dependencies })).status).toBe('ready')
    const sink = getSessionEventSink(root, session.id, session.createdAt)
    await sink.appendCritical({ type: 'assistant_chunk', payload: { turnId: 'proof-cache', content: 'x' } })
    await sink.close()
    const proofBefore = await dependencies.readProof(location)
    expect(proofBefore).toBeDefined()
    if (!proofBefore) throw new Error('SESSION_LEDGER_PROOF_MISSING')
    refreshSessionLedgerReadyProof(conn, identity.key, proofBefore)

    const paths = resolveSessionEventPaths(root, session.id, session.createdAt)
    const beforeStat = await fs.stat(paths.eventsPath)
    const bytes = await fs.readFile(paths.eventsPath)
    const marker = Buffer.from('"content":"x"')
    const markerOffset = bytes.indexOf(marker)
    expect(markerOffset).toBeGreaterThanOrEqual(0)
    if (markerOffset < 0) throw new Error('SESSION_LEDGER_TEST_MARKER_MISSING')
    bytes[markerOffset + marker.length - 2] = 'y'.charCodeAt(0)
    await fs.writeFile(paths.eventsPath, bytes)
    await fs.utimes(paths.eventsPath, beforeStat.atime, beforeStat.mtime)

    const openSpy = vi.spyOn(fs, 'open')
    try {
      const proofAfter = await dependencies.readProof(location)
      expect(openSpy).not.toHaveBeenCalled()
      expect(proofAfter).toEqual(proofBefore)
    } finally {
      openSpy.mockRestore()
    }
  })

  it('ignores retired physical proof columns for a healthy ready ledger', async () => {
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
    expect(upgraded.readiness.proofTailFrame).toBeNull()
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

    expect(upgraded).toMatchObject({ status: 'ready', readiness: { state: 'ready', proofTailFrame: null } })
    expect((await readSessionEvents(resolveSessionEventPaths(root, session.id, session.createdAt).eventsPath))
      .map(({ payload }) => payload.toolUseId)).toContain('legacy-tool')
  })

  it('keeps canonical history available when retired physical proof metadata is stale', async () => {
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
    expect(result).toMatchObject({ status: 'ready', readiness: { state: 'ready', failureClass: null } })
    expect(conn.prepare("SELECT event_id FROM agent_history_events WHERE session_id=? AND event_id='event-1'")
      .get(session.id)).toEqual({ event_id: 'event-1' })
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

    const scheduler = createSessionLedgerRepairScheduler({ repair: (repairLocation, retireSink) => runOutsideSessionLedgerLifecycleLock(async () => {
      if (retireSink) await retireSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
      return (await ensureSessionLedgerReady({ conn, location: repairLocation, sessionGeneration: session.generation,
        processGeneration: 1, retryBlocked: true, dependencies })).status === 'ready'
    }) })
    let result: Awaited<ReturnType<typeof ensureSessionLedgerReady>>
    try {
      const deferred = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1,
        retryBlocked: false, dependencies })
      expect(deferred).toMatchObject({ status: 'blocked', readiness: { failureClass: 'ledger_missing' } })
      scheduler.request(location, { retireSink: true, generation: `${deferred.readiness.ledgerGeneration}:ledger_missing` })
      await vi.waitFor(() => expect(scheduler.pendingCount()).toBe(0))
      result = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1,
        retryBlocked: false, dependencies })
    } finally { scheduler.stop() }

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
    const publishedPaths = resolveSessionEventPaths(root, session.id, session.createdAt)
    const originalRenameForIndex = fs.rename.bind(fs)
    const indexPublishSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === publishedPaths.indexPath) throw new Error('injected post-jsonl index publish interruption')
      return originalRenameForIndex(from, to)
    })
    try {
      const interruptedPublish = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
        processGeneration: 1, retryBlocked: true, dependencies })
      expect(interruptedPublish).toMatchObject({ status: 'blocked', readiness: { state: 'blocked', failureClass: 'baseline_failed' } })
      const publishedEvents = await readSessionEvents(publishedPaths.eventsPath)
      expect(publishedEvents.map(({ type }) => type)).toContain('tool_call')
      expect(conn.prepare("SELECT status FROM session_ledger_projection_outbox WHERE ledger_location_key=? AND status<>'pending'").all(identity.key))
        .toEqual([])
      await expect(fs.lstat(publishedPaths.indexPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { indexPublishSpy.mockRestore() }
    const resumedAfterPublish = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
      processGeneration: 1, retryBlocked: true, dependencies })
    expect(resumedAfterPublish).toMatchObject({ status: 'ready', readiness: { state: 'ready' } })
    expect(JSON.parse(await fs.readFile(publishedPaths.indexPath, 'utf8'))).toMatchObject({ formatVersion: 2 })
    expect((await fs.readdir(publishedPaths.directory)).filter((name) => name.startsWith('.ledger-rebuild-'))).toEqual([])
    expect(conn.prepare("SELECT status FROM session_ledger_projection_outbox WHERE ledger_location_key=? AND status<>'acked'").all(identity.key))
      .toEqual([])

    await simulateWholeLedgerLoss()
    const drainSpy = vi.spyOn(sessionLedgerOutbox, 'drainCanonicalLedgerProjectionOutbox')
      .mockResolvedValueOnce({ projected: 0, failedTargetId: 'injected-ack-interruption' })
    try {
      const interruptedAck = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
        processGeneration: 1, retryBlocked: true, dependencies })
      expect(interruptedAck).toMatchObject({ status: 'blocked', readiness: { state: 'blocked', failureClass: 'baseline_failed' } })
      const publishedEvents = await readSessionEvents(paths.eventsPath)
      expect(publishedEvents).toHaveLength(5)
      expect(publishedEvents.map(({ type }) => type)).toEqual(expect.arrayContaining([
        'tool_call', 'request_usage', 'compaction_start', 'compaction_summary', 'compaction_end'
      ]))
      expect(JSON.parse(await fs.readFile(paths.indexPath, 'utf8'))).toMatchObject({ formatVersion: 2 })
      expect(conn.prepare("SELECT status FROM session_ledger_projection_outbox WHERE ledger_location_key=? AND status<>'pending'").all(identity.key))
        .toEqual([])
    } finally { drainSpy.mockRestore() }
    const resumedAck = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
      processGeneration: 1, retryBlocked: true, dependencies })
    expect(resumedAck).toMatchObject({ status: 'ready', readiness: { state: 'ready' } })
    expect(conn.prepare("SELECT status FROM session_ledger_projection_outbox WHERE ledger_location_key=? AND status<>'acked'").all(identity.key))
      .toEqual([])

    await simulateWholeLedgerLoss()
    const publishTargetPath = resolveSessionEventPaths(root, session.id, session.createdAt)
    const originalRenameForEvents = fs.rename.bind(fs)
    const eventPublishSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === publishTargetPath.eventsPath) throw new Error('injected canonical jsonl publish interruption')
      return originalRenameForEvents(from, to)
    })
    try {
      const interruptedFilePublish = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
        processGeneration: 1, retryBlocked: true, dependencies })
      expect(interruptedFilePublish).toMatchObject({ status: 'blocked', readiness: { state: 'blocked', failureClass: 'baseline_failed' } })
      await expect(fs.lstat(publishTargetPath.eventsPath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await fs.readdir(publishTargetPath.directory)).filter((name) => name.startsWith('.ledger-rebuild-'))).toEqual([])
      expect(conn.prepare("SELECT status FROM session_ledger_projection_outbox WHERE ledger_location_key=? AND status<>'pending'").all(identity.key))
        .toEqual([])
    } finally { eventPublishSpy.mockRestore() }
    const resumedFilePublish = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
      processGeneration: 1, retryBlocked: true, dependencies })
    expect(resumedFilePublish).toMatchObject({ status: 'ready', readiness: { state: 'ready' } })

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
      await expect(fs.lstat(resolveSessionEventPaths(root, session.id, session.createdAt).eventsPath)).rejects.toMatchObject({ code: 'ENOENT' })
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

  it('baselines spilled canonical tool results using their hydrated source content', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-spilled-baseline-'))
    roots.push(root)
    const db = openSqliteDatabase(path.join(root, 'app.sqlite'))
    databases.push(db)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'spilled-baseline', workDirProfileId: 'profile' })
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const conn = getDbConnection(db)
    const largeText = 'canonical-result-'.repeat(8_000)
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([
      { invocationId: 'spill-invocation', turnId: 'spill-turn', sequence: 1, schemaVersion: 1,
        eventId: 'spill-proposal', idempotencyKey: 'spill-proposal', kind: 'model-response-committed',
        payload: { modelTurn: 1, message: { role: 'assistant', toolCalls: [{ id: 'spill-tool', name: 'read_file', input: { path: 'large.txt' } }] },
          sessionLedger: { location, stepId: 'spill-step', toolCalls: [{ toolUseId: 'spill-tool', name: 'read_file', args: { path: 'large.txt' } }] } } },
      { invocationId: 'spill-invocation', turnId: 'spill-turn', sequence: 2, schemaVersion: 1,
        eventId: 'spill-result', idempotencyKey: 'spill-result', kind: 'tool-call-finished',
        payload: { toolCallId: 'spill-tool', result: { success: true, data: largeText },
          sessionLedger: { location, stepId: 'spill-step', turnId: 'spill-turn', result: { success: true, data: largeText } } } }
    ], 0)
    const storedPayload = conn.prepare("SELECT payload_json FROM agent_history_events WHERE event_id='spill-result'").get() as { payload_json: string }
    expect(storedPayload.payload_json).toContain('__spaceassistant_spill_v1')
    await bootstrapEmptySessionEventLedger(root, session.id, session.createdAt, 'spill-baseline')

    const dependencies = createProductionSessionLedgerLifecycleDependencies(conn)
    await dependencies.baseline(location)

    const events = await readSessionEvents(resolveSessionEventPaths(root, session.id, session.createdAt).eventsPath)
    expect(events.find(({ type }) => type === 'tool_result')?.payload).toMatchObject({
      toolUseId: 'spill-tool', result: { success: true, data: largeText }
    })

    await retireSessionEventSink(root, session.id, session.createdAt)
    const identity = sessionLedgerLocationIdentity(location)
    await fs.rm(resolveSessionEventPaths(root, session.id, session.createdAt).directory, { recursive: true, force: true })
    conn.prepare(`UPDATE session_ledger_projection_state SET state='blocked',retry_scope='baseline',failure_class='ledger_missing',
      canonical_watermark=NULL,proof_file_identity=NULL,proof_file_bytes=NULL,proof_tail_frame=NULL,proof_index_seq=NULL,
      proof_index_event_count=NULL,proof_index_bytes=NULL,proof_index_last_at=NULL WHERE ledger_location_key=?`).run(identity.key)

    if (!dependencies.rebuildMissingLegacyLedger) throw new Error('SESSION_LEDGER_REBUILD_DEPENDENCY_MISSING')
    await dependencies.rebuildMissingLegacyLedger(location)

    const rebuilt = await readSessionEvents(resolveSessionEventPaths(root, session.id, session.createdAt).eventsPath)
    expect(rebuilt.find(({ type }) => type === 'tool_result')?.payload).toMatchObject({
      toolUseId: 'spill-tool', result: { success: true, data: largeText }
    })
  })

  it('rebuilds a ledger after a durable physical-mismatch verdict without trusting the truncated suffix', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-shortened-rebuild-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'shortened-ledger-rebuild', workDirProfileId: 'profile' })
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const conn = getDbConnection(db)
    const dependencies = createProductionSessionLedgerLifecycleDependencies(conn)
    expect((await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1, dependencies })).status)
      .toBe('ready')
    const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
    await history.appendBatch([{ invocationId: 'shortened-invocation', turnId: 'shortened-turn', sequence: 1, schemaVersion: 1,
      eventId: 'shortened-model-response', idempotencyKey: 'shortened-model-response', kind: 'model-response-committed',
      payload: { modelTurn: 1, message: { role: 'assistant', toolCalls: [{ id: 'shortened-tool', name: 'read_file', input: { path: 'canonical.txt' } }] },
        sessionLedger: { location, stepId: 'shortened-step', toolCalls: [{ toolUseId: 'shortened-tool', name: 'read_file', args: { path: 'canonical.txt' } }] } }
    }], 0)
    expect((await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1, dependencies })).status)
      .toBe('ready')
    const sink = getSessionEventSink(root, session.id, session.createdAt)
    await sink.appendCritical({ type: 'assistant_chunk', payload: { turnId: 'shortened-turn', text: 'preserve original bytes before rebuild' } })
    expect((await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1, dependencies })).status)
      .toBe('ready')
    await sink.close()
    const paths = resolveSessionEventPaths(root, session.id, session.createdAt)
    const intact = await fs.readFile(paths.eventsPath, 'utf8')
    const shortened = intact.slice(0, -10)
    await fs.writeFile(paths.eventsPath, shortened)
    const identity = sessionLedgerLocationIdentity(location)
    expect(markSessionLedgerBlocked(conn, identity.key, 'baseline', 'physical_proof_mismatch')).toBe(true)

    const scheduler = createSessionLedgerRepairScheduler({ repair: (repairLocation) => runOutsideSessionLedgerLifecycleLock(async () =>
      (await ensureSessionLedgerReady({ conn, location: repairLocation, sessionGeneration: session.generation,
        processGeneration: 1, retryBlocked: true, dependencies })).status === 'ready') })
    try {
      const deferred = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
        processGeneration: 1, retryBlocked: false, dependencies })
      expect(deferred).toMatchObject({ status: 'blocked', readiness: { failureClass: 'physical_proof_mismatch' } })
      scheduler.request(location, { generation: `${deferred.readiness.ledgerGeneration}:${deferred.readiness.failureClass}` })
      await vi.waitFor(() => expect(scheduler.pendingCount()).toBe(0))
      const recovered = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
        processGeneration: 1, retryBlocked: false, dependencies })
      expect(recovered).toMatchObject({ status: 'ready', readiness: { state: 'ready' } })
    } finally { scheduler.stop() }
    const quarantineRoot = path.join(root, 'sessions', '.quarantine')
    const archives = await fs.readdir(quarantineRoot)
    expect(archives).toHaveLength(1)
    const archive = path.join(quarantineRoot, archives[0]!)
    expect(await fs.readFile(path.join(archive, 'events.jsonl'), 'utf8')).toBe(shortened)
    expect(JSON.parse(await fs.readFile(path.join(archive, 'manifest.json'), 'utf8')))
      .toMatchObject({ reason: 'physical_proof_mismatch', state: 'complete' })
    const restored = await readSessionEvents(paths.eventsPath)
    expect(restored.filter(({ type, payload }) => type === 'tool_call' && payload.toolUseId === 'shortened-tool')).toHaveLength(1)
    expect(restored.some(({ type, payload }) => type === 'assistant_chunk' && payload.turnId === 'shortened-turn')).toBe(false)
  })

  it('does not use retired index byte-count metadata to gate an already-ready ledger', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-index-repair-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'index proof mismatch', workDirProfileId: 'profile' })
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const conn = getDbConnection(db)
    const dependencies = createProductionSessionLedgerLifecycleDependencies(conn)
    expect((await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1, dependencies })).status)
      .toBe('ready')
    const sink = getSessionEventSink(root, session.id, session.createdAt)
    await sink.appendCritical({ type: 'turn_start', payload: { turnId: 'index-repair-turn' } })
    expect((await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1, dependencies })).status)
      .toBe('ready')
    await sink.close()
    const paths = resolveSessionEventPaths(root, session.id, session.createdAt)
    const originalEvents = await fs.readFile(paths.eventsPath, 'utf8')
    const originalIndex = JSON.parse(await fs.readFile(paths.indexPath, 'utf8')) as Record<string, unknown>
    await fs.writeFile(paths.indexPath, JSON.stringify({ ...originalIndex, bytes: 0 }))

    const recovered = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
      processGeneration: 1, retryBlocked: true, dependencies })

    expect(recovered).toMatchObject({ status: 'ready', readiness: { state: 'ready' } })
    expect(await fs.readFile(paths.eventsPath, 'utf8')).toBe(originalEvents)
    const unchangedIndex = JSON.parse(await fs.readFile(paths.indexPath, 'utf8')) as { bytes: number; eventCount: number }
    expect(unchangedIndex.bytes).toBe(0)
    expect(unchangedIndex.eventCount).toBe(originalIndex.eventCount)
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

  it('quarantines a degraded legacy ledger and records the blocked availability reason', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-degraded-quarantine-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'degraded-quarantine', workDirProfileId: 'profile' })
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const conn = getDbConnection(db)
    const dependencies = createProductionSessionLedgerLifecycleDependencies(conn)
    const first = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
      processGeneration: 1, dependencies })
    expect(first.status).toBe('ready')
    const paths = resolveSessionEventPaths(root, session.id, session.createdAt)
    const sink = getSessionEventSink(root, session.id, session.createdAt)
    await sink.appendCritical({ type: 'turn_start', payload: { turnId: 'unique-quarantined-fact' } })
    await sink.close()
    const original = `${await fs.readFile(paths.eventsPath, 'utf8')}{unreadable-record}\n`
    await fs.writeFile(paths.eventsPath, original)
    conn.prepare("UPDATE session_ledger_projection_state SET state='unknown',origin='legacy',bootstrap_id=NULL WHERE session_id=?")
      .run(session.id)

    const result = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
      processGeneration: 1, dependencies })

    expect(result).toMatchObject({ status: 'blocked', readiness: { state: 'blocked', failureClass: 'ledger_degraded_quarantined' } })
    await expect(fs.readFile(paths.eventsPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const quarantineRoot = path.join(root, 'sessions', '.quarantine')
    const archives = await fs.readdir(quarantineRoot)
    expect(archives).toHaveLength(1)
    expect(await fs.readFile(path.join(quarantineRoot, archives[0]!, 'events.jsonl'), 'utf8')).toBe(original)
    expect(JSON.parse(await fs.readFile(path.join(quarantineRoot, archives[0]!, 'manifest.json'), 'utf8')))
      .toMatchObject({ state: 'complete', integrity: 'degraded', eventCount: 1 })
  })

  it('recovers an interrupted quarantine before retrying a missing-ledger rebuild', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-quarantine-resume-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'quarantine-resume', workDirProfileId: 'profile' })
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const conn = getDbConnection(db)
    const dependencies = createProductionSessionLedgerLifecycleDependencies(conn)
    await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1, dependencies })
    const paths = resolveSessionEventPaths(root, session.id, session.createdAt)
    const sink = getSessionEventSink(root, session.id, session.createdAt)
    await sink.appendCritical({ type: 'turn_start', payload: { turnId: 'unique-fact' } })
    await sink.close()
    const original = `${await fs.readFile(paths.eventsPath, 'utf8')}{malformed}\n`
    await fs.writeFile(paths.eventsPath, original)
    conn.prepare("UPDATE session_ledger_projection_state SET state='unknown',origin='legacy',bootstrap_id=NULL WHERE session_id=?")
      .run(session.id)
    const originalRename = fs.rename.bind(fs)
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (from === paths.eventsPath) throw new Error('injected quarantine interruption')
      return originalRename(from, to)
    })
    try {
      const interrupted = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
        processGeneration: 1, dependencies })
      expect(interrupted).toMatchObject({ status: 'blocked', readiness: { failureClass: 'ledger_quarantine_failed' } })
    } finally { renameSpy.mockRestore() }

    const resumed = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
      processGeneration: 1, retryBlocked: true, dependencies })

    expect(resumed).toMatchObject({ status: 'blocked', readiness: { failureClass: 'baseline_failed' } })
    await expect(fs.lstat(paths.eventsPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const archives = await fs.readdir(path.join(root, 'sessions', '.quarantine'))
    expect(archives).toHaveLength(1)
    const archive = path.join(root, 'sessions', '.quarantine', archives[0]!)
    expect(await fs.readFile(path.join(archive, 'events.jsonl'), 'utf8')).toBe(original)
    expect(JSON.parse(await fs.readFile(path.join(archive, 'manifest.json'), 'utf8'))).toMatchObject({ state: 'complete' })
  })
})
