import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  stripPartialJsonForPersist,
  getSessionEventSink,
  beginSessionEventShutdown,
  SessionEventWriter,
  getSessionEventWriter,
  computeSessionUsageFromEvents,
  flushAllSessionEventSinks,
  parseSessionEvent,
  readSessionEvents,
  readSessionEventsDetailed,
  appendCompactionTransaction,
  ensureCompactionTransaction,
  ensureRequestRetryEvent,
  ensureToolCallEvent,
  ensureToolResultEvent,
  ensureTurnEndEvent,
  ensureTurnStartEvent,
  ensureRequestProjectionEvents,
  ensureFinalRequestContextEvent,
  replayCompactionEvents,
  readCompactionMarkers,
  readCompactionReplay,
  reconcileSessionEventFiles,
  reconcileSessionEventFilesDetailed,
  reconcileSessionEvents,
  type SessionEvent
} from './sessionEvents'
import { computeCompactionSummaryHash } from '../src/shared/compactionEvents'

describe('session events', () => {
  it('canonical terminal recovery recreates a missing turn_start before turn_end', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-turn-start-recovery-'))
    const sink = getSessionEventSink(root, 'turn-start-recovery', 1000)
    try {
      const start = await ensureTurnStartEvent(sink, 'recovered-turn')
      const repeatedStart = await ensureTurnStartEvent(sink, 'recovered-turn')
      const end = await ensureTurnEndEvent(sink, 'recovered-turn', 'interrupted')

      expect(start).toMatchObject({ type: 'turn_start', payload: { turnId: 'recovered-turn' } })
      expect(repeatedStart).toEqual(start)
      expect(end).toMatchObject({ type: 'turn_end', payload: { turnId: 'recovered-turn', reason: 'interrupted' } })
      expect((await readSessionEvents(sink.eventsPath)).map((event) => event.type)).toEqual(['turn_start', 'turn_end'])
    } finally {
      await sink.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('treats a recovered tool result with reordered nested object keys as the same projection', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-tool-result-key-order-'))
    const sink = getSessionEventSink(root, 'tool-result-key-order', 1000)
    const original = { toolUseId: 'tool-1', stepId: 'step-1', result: { content: [{ type: 'text', text: 'ok' }], isError: false } }
    try {
      await sink.appendCritical({ type: 'tool_result', payload: original })

      await expect(ensureToolResultEvent(sink, {
        toolUseId: 'tool-1', stepId: 'step-1', result: { isError: false, content: [{ text: 'ok', type: 'text' }] }
      })).resolves.toMatchObject({ type: 'tool_result', payload: original })
      expect((await readSessionEvents(sink.eventsPath)).filter((event) => event.type === 'tool_result')).toHaveLength(1)
    } finally {
      await sink.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('rejects duplicate tool result identities even when the first projection matches canonical History', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-tool-result-duplicate-'))
    const sink = getSessionEventSink(root, 'tool-result-duplicate', 1000)
    const canonical = { toolUseId: 'tool-duplicate', stepId: 'step-1', result: { text: 'canonical' } }
    try {
      await sink.appendCritical({ type: 'tool_result', payload: canonical })
      await sink.appendCritical({ type: 'tool_result', payload: { ...canonical, result: { text: 'conflict' } } })

      await expect(ensureToolResultEvent(sink, canonical)).rejects.toThrow(/duplicate tool result ledger event/)
    } finally {
      await sink.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('repairs a canonical tool result when the session ledger has only an aborted-dispatch diagnostic', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-tool-result-diagnostic-'))
    const sink = getSessionEventSink(root, 'tool-result-diagnostic', 1000)
    try {
      await sink.appendCritical({ type: 'tool_result', payload: { toolUseId: 'tool-diagnostic', stepId: 'step-1', diagnosticType: 'tools.dispatch_failure_context', reasonCode: 'ToolExecutionAfterDispatchError' } })
      await expect(ensureToolResultEvent(sink, { toolUseId: 'tool-diagnostic', stepId: 'step-1', result: { content: [{ type: 'text', text: 'recovered' }] } }))
        .resolves.toMatchObject({ type: 'tool_result', payload: { toolUseId: 'tool-diagnostic', result: { content: [{ text: 'recovered', type: 'text' }] } } })
    } finally {
      await sink.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    {
      type: 'tool_call' as const,
      payload: { toolUseId: 'tool-payload-drift', turnId: 'turn-1', stepId: 'step-1', name: 'read_file', args: { path: 'note.txt' }, source: 'conflicting' },
      repair: (sink: ReturnType<typeof getSessionEventSink>) => ensureToolCallEvent(sink, {
        toolUseId: 'tool-payload-drift', turnId: 'turn-1', stepId: 'step-1', name: 'read_file', args: { path: 'note.txt' }
      })
    },
    {
      type: 'tool_result' as const,
      payload: { toolUseId: 'tool-payload-drift', turnId: 'turn-1', stepId: 'step-1', result: { success: true }, source: 'conflicting' },
      repair: (sink: ReturnType<typeof getSessionEventSink>) => ensureToolResultEvent(sink, {
        toolUseId: 'tool-payload-drift', turnId: 'turn-1', stepId: 'step-1', result: { success: true }
      })
    }
  ])('rejects extra conflicting $type payload fields during canonical repair', async ({ type, payload, repair }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-tool-payload-drift-'))
    const sink = getSessionEventSink(root, `tool-payload-${type}`, 1000)
    try {
      await sink.appendCritical({ type, payload })
      await expect(repair(sink)).rejects.toThrow(/conflicting tool (call|result) ledger event/)
    } finally {
      await sink.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('keeps legacy tool projection idempotency when canonical sidecars have no turnId', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-tool-legacy-turn-'))
    const sink = getSessionEventSink(root, 'tool-legacy-turn', 1000)
    try {
      await sink.appendCritical({ type: 'tool_call', payload: { toolUseId: 'legacy-tool', turnId: 'legacy-turn', stepId: 'step-1', name: 'read_file', args: { path: 'note.txt' } } })
      await expect(ensureToolCallEvent(sink, { toolUseId: 'legacy-tool', stepId: 'step-1', name: 'read_file', args: { path: 'note.txt' } }))
        .resolves.toMatchObject({ type: 'tool_call', payload: { turnId: 'legacy-turn' } })
    } finally {
      await sink.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('rejects duplicate turn_end identities during canonical terminal repair', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-turn-end-duplicate-'))
    const sink = getSessionEventSink(root, 'turn-end-duplicate', 1000)
    try {
      await sink.appendCritical({ type: 'turn_start', payload: { turnId: 'turn-duplicate' } })
      await sink.appendCritical({ type: 'turn_end', payload: { turnId: 'turn-duplicate', reason: 'completed' } })
      await sink.appendCritical({ type: 'turn_end', payload: { turnId: 'turn-duplicate', reason: 'failed' } })

      await expect(ensureTurnEndEvent(sink, 'turn-duplicate', 'completed')).rejects.toThrow(/duplicate invocation terminal projection/)
    } finally {
      await sink.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('rejects turn_end payload drift when terminal identity and reason match canonical History', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-turn-end-drift-'))
    const sink = getSessionEventSink(root, 'turn-end-drift', 1000)
    try {
      await sink.appendCritical({ type: 'turn_start', payload: { turnId: 'turn-drift' } })
      await sink.appendCritical({ type: 'turn_end', payload: { turnId: 'turn-drift', reason: 'completed', outputText: 'conflicting projection' } })

      await expect(ensureTurnEndEvent(sink, 'turn-drift', 'completed')).rejects.toThrow(/conflicting invocation terminal projection/)
    } finally {
      await sink.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('keeps optional terminal diagnostics when repairing an existing turn_end projection', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-turn-end-diagnostics-'))
    const sink = getSessionEventSink(root, 'turn-end-diagnostics', 1000)
    try {
      await sink.appendCritical({ type: 'turn_start', payload: { turnId: 'turn-diagnostics' } })
      const existing = await sink.appendCritical({
        type: 'turn_end',
        payload: { turnId: 'turn-diagnostics', reason: 'interrupted', error: 'policy changed', finalSurfaceSnapshot: { text: 'partial' } }
      })

      await expect(ensureTurnEndEvent(sink, 'turn-diagnostics', 'interrupted')).resolves.toEqual(existing)
      expect((await readSessionEvents(sink.eventsPath)).filter((event) => event.type === 'turn_end')).toHaveLength(1)
      await expect(ensureTurnEndEvent(sink, 'turn-diagnostics', 'failed')).rejects.toThrow(/conflicting invocation terminal projection/)
    } finally {
      await sink.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('rejects ambiguous duplicate turn_start owners during canonical terminal repair', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-turn-start-duplicate-'))
    const sink = getSessionEventSink(root, 'turn-start-duplicate', 1000)
    try {
      await sink.appendCritical({ type: 'turn_start', payload: { turnId: 'turn-duplicate-start' } })
      await sink.appendCritical({ type: 'turn_start', payload: { turnId: 'turn-duplicate-start' } })

      await expect(ensureTurnEndEvent(sink, 'turn-duplicate-start', 'completed')).rejects.toThrow(/duplicate invocation turn_start projection/)
    } finally {
      await sink.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('appends final request context after initial projection once and rejects conflicting finals', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-final-request-context-'))
    const sink = getSessionEventSink(root, 'final-context', 1000)
    const initial = { requestId: 'inv:round:1', turnId: 'turn', attempt: 1, provider: 'anthropic', model: 'test' }
    const final = { ...initial, contextUsage: { pressureTokens: 12 }, projectionStage: 'final' as const }
    await sink.appendCritical({ type: 'request_context', payload: initial })
    await ensureFinalRequestContextEvent(sink, final)
    await ensureFinalRequestContextEvent(sink, final)
    await expect(ensureFinalRequestContextEvent(sink, { ...initial, contextUsage: { pressureTokens: 13 }, projectionStage: 'final' })).rejects.toThrow(/conflicting final request context/i)
    await expect(readSessionEvents(sink.eventsPath)).resolves.toMatchObject([
      { type: 'request_context', payload: initial }, { type: 'request_context', payload: final }
    ])
    await sink.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('repairs initial model request projection when its final context shares the same request and attempt', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-request-projection-with-final-'))
    const sink = getSessionEventSink(root, 'request-projection-final', 1000)
    const requestHeader = { requestId: 'inv:round:1', attempt: 1, route: 'anthropic.messages.stream' }
    const requestContext = { requestId: 'inv:round:1', turnId: 'turn', attempt: 1, provider: 'anthropic', model: 'test' }
    try {
      await sink.appendCritical({ type: 'request_header', payload: requestHeader })
      await sink.appendCritical({ type: 'request_context', payload: requestContext })
      await sink.appendCritical({ type: 'request_context', payload: { ...requestContext, contextUsage: { pressureTokens: 12 }, projectionStage: 'final' } })

      await expect(ensureRequestProjectionEvents(sink, { requestHeader, requestContext })).resolves.toBeUndefined()
      await expect(readSessionEvents(sink.eventsPath)).resolves.toHaveLength(3)
    } finally {
      await sink.close()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('repairs the final context when the initial context already includes a usage projection', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-initial-usage-context-'))
    const sink = getSessionEventSink(root, 'initial-usage-context', 1000)
    const base = { requestId: 'inv:round:1', turnId: 'turn', attempt: 1, provider: 'anthropic', model: 'test' }
    const initial = { ...base, contextUsage: { pressureTokens: null, projectedTokens: null, surfaceTokens: 20, hardFit: true, bodyFit: true } }
    const final = { ...base, contextUsage: { pressureTokens: 12, projectedTokens: 15, surfaceTokens: 23, hardFit: true, bodyFit: true }, projectionStage: 'final' as const }
    await sink.appendCritical({ type: 'request_context', payload: initial })

    await expect(ensureFinalRequestContextEvent(sink, final)).resolves.toMatchObject({ type: 'request_context', payload: final })
    await expect(readSessionEvents(sink.eventsPath)).resolves.toEqual([
      expect.objectContaining({ type: 'request_context', payload: initial }),
      expect.objectContaining({ type: 'request_context', payload: final })
    ])
    await sink.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('rejects final request context with a nonpositive attempt or array usage', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-invalid-final-context-'))
    const sink = getSessionEventSink(root, 'invalid-final-context', 1000)
    const base = { requestId: 'inv:round:1', turnId: 'turn', attempt: 1, provider: 'anthropic', model: 'test' }
    await expect(ensureFinalRequestContextEvent(sink, { ...base, attempt: 0, contextUsage: {} })).rejects.toThrow(/identity is invalid/i)
    await expect(ensureFinalRequestContextEvent(sink, { ...base, contextUsage: [] })).rejects.toThrow(/identity is invalid/i)
    await sink.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('rejects a session identity whose ledger directory escapes the workspace sessions root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-path-confinement-'))
    expect(() => getSessionEventSink(root, '../../outside-ledger', 1000)).toThrow(/escapes sessions root/i)
    await fs.rm(root, { recursive: true, force: true })
  })

  it.each(['sessions-root', 'session-directory', 'session-parent', 'events-file', 'index-file', 'events-hardlink'] as const)(
    'does not follow a symlink at the %s recovery write boundary', async (linkKind) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-symlink-confinement-'))
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-symlink-target-'))
      const sessionId = linkKind === 'session-parent' ? 'nested/symlink-case' : 'symlink-case'
      const sessionDirectory = path.join(root, 'sessions', `${sessionId}-19700101`)
      let sink: ReturnType<typeof getSessionEventSink> | undefined
      try {
        if (linkKind === 'sessions-root') {
          await fs.symlink(outside, path.join(root, 'sessions'), 'dir')
        } else if (linkKind === 'session-parent') {
          await fs.mkdir(path.join(root, 'sessions'), { recursive: true })
          await fs.symlink(outside, path.join(root, 'sessions', 'nested'), 'dir')
        } else {
          await fs.mkdir(path.dirname(sessionDirectory), { recursive: true })
          if (linkKind === 'session-directory') await fs.symlink(outside, sessionDirectory, 'dir')
          else {
            await fs.mkdir(sessionDirectory, { recursive: true })
            const fileName = linkKind === 'events-file' ? 'events.jsonl' : 'events.index.json'
            if (linkKind === 'events-hardlink') {
              await fs.writeFile(path.join(outside, 'events.jsonl'), 'outside sentinel\n')
              await fs.link(path.join(outside, 'events.jsonl'), path.join(sessionDirectory, 'events.jsonl'))
            } else {
              await fs.symlink(path.join(outside, fileName), path.join(sessionDirectory, fileName))
            }
          }
        }
        sink = getSessionEventSink(root, sessionId, 1000)

        await expect(sink.appendCritical({ type: 'tool_result', payload: { toolUseId: 't', result: {} } }))
          .rejects.toThrow(/symbolic link|hard link|session event path/i)
        if (linkKind === 'events-hardlink') {
          await expect(fs.readFile(path.join(outside, 'events.jsonl'), 'utf8')).resolves.toBe('outside sentinel\n')
        } else {
          await expect(fs.readdir(outside)).resolves.toEqual([])
        }
      } finally {
        await sink?.close().catch(() => undefined)
        await fs.rm(root, { recursive: true, force: true })
        await fs.rm(outside, { recursive: true, force: true })
      }
    }
  )

  it('repairs provider retry projections by request and retry attempt identity', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-request-retry-'))
    const sink = getSessionEventSink(root, 'retry-repair', 1000)
    const payload = { turnId: 't', stepId: 'inv', requestId: 'inv:round:1', attempt: 2, backoffMs: 0, code: 'provider_context_overflow' }
    await ensureRequestRetryEvent(sink, payload)
    await ensureRequestRetryEvent(sink, payload)
    await expect(ensureRequestRetryEvent(sink, { ...payload, code: 'effort_unsupported' })).rejects.toThrow(/conflicting request retry/i)
    await expect(readSessionEvents(sink.eventsPath)).resolves.toMatchObject([{ type: 'request_retry', payload }])
    await sink.close()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('repairs a missing compaction transaction idempotently from its canonical envelope', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-compaction-repair-'))
    const writer = new SessionEventWriter(root, 'compaction-repair')
    const start = { compactionId: 'recover-c1', windowId: 'w1', inputSurfaceFingerprint: 'in', targetTokens: 1 }
    const summary = { compactionId: 'recover-c1', windowId: 'w1', summaryHash: computeCompactionSummaryHash({}), outputSurfaceFingerprint: 'out', candidate: {} }

    await ensureCompactionTransaction(writer, start, summary)
    await ensureCompactionTransaction(writer, start, summary)

    const events = await readSessionEvents(writer.eventsPath)
    expect(events.map((event) => event.type)).toEqual(['compaction_start', 'compaction_summary', 'compaction_end'])
    expect(replayCompactionEvents(events).committed).toHaveLength(1)
    await writer.close()
  })

  it('completes a compaction transaction when only its start event reached the ledger', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-compaction-prefix-'))
    const writer = new SessionEventWriter(root, 'compaction-prefix')
    const start = { compactionId: 'recover-prefix', windowId: 'w1', inputSurfaceFingerprint: 'in', targetTokens: 1 }
    const summary = { compactionId: 'recover-prefix', windowId: 'w1', summaryHash: computeCompactionSummaryHash({}), outputSurfaceFingerprint: 'out', candidate: {} }
    await writer.appendCritical({ type: 'compaction_start', payload: start })

    await ensureCompactionTransaction(writer, start, summary)

    const events = await readSessionEvents(writer.eventsPath)
    expect(events.map((event) => event.type)).toEqual(['compaction_start', 'compaction_summary', 'compaction_end'])
    expect(replayCompactionEvents(events).committed).toHaveLength(1)
    await writer.close()
  })

  it('commits compaction start, summary, and end in order', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-compaction-'))
    const writer = new SessionEventWriter(root, 'compaction')
    const end = await appendCompactionTransaction(writer, { compactionId: 'c1', inputSurfaceFingerprint: 'in', targetTokens: 1 }, { compactionId: 'c1', summaryHash: computeCompactionSummaryHash({}), outputSurfaceFingerprint: 'out', candidate: {} })
    expect(end.seq).toBe(3)
    expect((await readSessionEvents(writer.eventsPath)).map((event) => event.type)).toEqual(['compaction_start', 'compaction_summary', 'compaction_end'])
    await writer.close()
  })

  it('replays only a fully committed compaction transaction', () => {
    const replay = replayCompactionEvents([
      { schemaVersion: 1, seq: 1, time: 1, type: 'compaction_start', payload: { compactionId: 'c', inputSurfaceFingerprint: 'in' } },
      { schemaVersion: 1, seq: 2, time: 2, type: 'compaction_summary', payload: { compactionId: 'c', outputSurfaceFingerprint: 'out', summaryHash: 'h' } },
      { schemaVersion: 1, seq: 3, time: 3, type: 'compaction_end', payload: { compactionId: 'c', status: 'committed', startSeq: 1, summarySeq: 2, inputSurfaceFingerprint: 'in', outputSurfaceFingerprint: 'out', summaryHash: 'h' } },
      { schemaVersion: 1, seq: 4, time: 4, type: 'compaction_end', payload: { compactionId: 'broken', status: 'committed' } }
    ])
    expect(replay.committed).toHaveLength(1)
    expect(replay.rejected).toContainEqual({ compactionId: 'broken', reason: 'invalid-commit-references' })
  })
  it('reads only committed compaction markers from the event log', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-markers-'))
    const writer = new SessionEventWriter(root, 'markers')
    await appendCompactionTransaction(writer, { compactionId: 'c1', windowId: 'w1', inputSurfaceFingerprint: 'in', targetTokens: 1 }, { compactionId: 'c1', windowId: 'w1', summaryHash: computeCompactionSummaryHash({}), outputSurfaceFingerprint: 'out', candidate: {} })
    expect(await readCompactionMarkers(writer.eventsPath, 'w1')).toEqual([{ compactionId: 'c1', windowId: 'w1', outputSurfaceFingerprint: 'out' }])
    await writer.close()
  })
  it('reads committed compaction replay for surface reconstruction', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-replay-'))
    const writer = new SessionEventWriter(root, 'replay')
    await appendCompactionTransaction(writer, { compactionId: 'c1', windowId: 'w1', inputSurfaceFingerprint: 'in', targetTokens: 1 }, { compactionId: 'c1', windowId: 'w1', summaryHash: 'out', outputSurfaceFingerprint: 'out', shadowedRanges: [{ start: 'old', end: 'old' }] })
    expect((await readCompactionReplay(writer.eventsPath)).committed).toHaveLength(1)
    await writer.close()
  })
  it('writes schemaVersion 1 while accepting legacy events without it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-schema-'))
    const writer = new SessionEventWriter(root, 'schema')
    await writer.appendCritical({ type: 'turn_start', payload: {} })
    const raw = JSON.parse((await fs.readFile(writer.eventsPath, 'utf8')).trim())
    expect(raw.schemaVersion).toBe(1)
    await writer.close()
  })

  it('appends JSONL with monotonic sequence and atomic index', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-'))
    const writer = new SessionEventWriter(root, 's1', new Date('2026-01-02T00:00:00Z').getTime())
    await writer.append({ type: 'turn_start', payload: { turnId: 't1' } })
    await writer.append({ type: 'turn_end', payload: { turnId: 't1', reason: 'completed' } })
    const lines = (await fs.readFile(writer.eventsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.map((e) => e.seq)).toEqual([1, 2])
    expect(JSON.parse(await fs.readFile(writer.indexPath, 'utf8'))).toMatchObject({ seq: 2, eventCount: 2 })
    const restarted = getSessionEventWriter(root, 's1', new Date('2026-01-02T00:00:00Z').getTime())
    expect((await restarted.append({ type: 'session_end_seed', payload: { seedSeq: 2 } }))?.seq).toBe(3)
  })

  it('reconciles unfinished turns, steps and tool calls without executing tools', () => {
    const events: SessionEvent[] = [
      { seq: 1, time: 1, type: 'turn_start', payload: { turnId: 't1' } },
      { seq: 2, time: 2, type: 'step_start', payload: { turnId: 't1', stepId: 's1' } },
      { seq: 3, time: 3, type: 'tool_call', payload: { turnId: 't1', stepId: 's1', toolUseId: 'u1', name: 'shell', args: {} } }
    ]
    const result = reconcileSessionEvents(events, 4)
    expect(result.map((e) => e.type)).toEqual(['step_end', 'tool_result', 'turn_end'])
    expect(result[1]).toMatchObject({ type: 'tool_result', payload: { toolUseId: 'u1', synthetic: true } })
  })

  it('preserves turn and step identities containing the legacy delimiter during recovery', () => {
    const events: SessionEvent[] = [
      { seq: 1, time: 1, type: 'turn_start', payload: { turnId: 'turn:parent:child' } },
      { seq: 2, time: 2, type: 'step_start', payload: { turnId: 'turn:parent:child', stepId: 'request:model:2' } }
    ]

    expect(reconcileSessionEvents(events, 3)).toEqual([
      { seq: 3, time: expect.any(Number), type: 'step_end', payload: { turnId: 'turn:parent:child', stepId: 'request:model:2', reason: 'interrupted' } },
      { seq: 4, time: expect.any(Number), type: 'turn_end', payload: { turnId: 'turn:parent:child', reason: 'interrupted' } }
    ])
  })

  it('recomputes usage from request facts', () => {
    const events: SessionEvent[] = [
      { seq: 1, time: 1, type: 'request_usage', payload: { requestId: 'a', source: 'api', usage: { input_tokens: 3, output_tokens: 4 } } },
      { seq: 2, time: 2, type: 'request_usage', payload: { requestId: 'b', source: 'api', usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 2 } } }
    ]
    expect(computeSessionUsageFromEvents(events)).toMatchObject({ input_tokens: 8, output_tokens: 10, cache_read_input_tokens: 2 })
  })

  it('rejects malformed or unknown event types', () => {
    expect(() => parseSessionEvent({ seq: 1, time: 1, type: 'unknown', payload: {} })).toThrow()
  })

  it('rejects unknown event schema versions so replay can degrade safely', () => {
    expect(() => parseSessionEvent({ schemaVersion: 99, seq: 1, time: 1, type: 'request_header', payload: {} })).toThrow(/schema/i)
  })

  it('ignores a torn final JSONL line while retaining valid events', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-torn-'))
    const writer = new SessionEventWriter(root, 's1', 1)
    await writer.append({ type: 'turn_start', payload: { turnId: 't1' } })
    await fs.appendFile(writer.eventsPath, '{"seq":2,"type":"turn_start"')
    await expect(readSessionEvents(writer.eventsPath)).resolves.toHaveLength(1)
    const appended = await writer.append({ type: 'turn_end', payload: {} })
    expect(appended?.seq).toBe(2)
    await expect(readSessionEvents(writer.eventsPath)).resolves.toHaveLength(2)
  })

  it('terminates a valid JSON tail before appending', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-no-newline-'))
    const writer = new SessionEventWriter(root, 's1', 1)
    await writer.append({ type: 'turn_start', payload: {} })
    const raw = await fs.readFile(writer.eventsPath, 'utf8')
    await fs.writeFile(writer.eventsPath, raw.trimEnd())
    await writer.append({ type: 'turn_end', payload: {} })
    expect(await fs.readFile(writer.eventsPath, 'utf8')).toContain('}\n{')
    await expect(readSessionEvents(writer.eventsPath)).resolves.toHaveLength(2)
  })

  it('写入失败后 flush/close 报告丢失，关闭后由新 sink 恢复', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-write-failure-'))
    const errors: unknown[] = []
    const writer = new SessionEventWriter(root, 's1', 1, { onError: (error) => errors.push(error) })
    await fs.mkdir(writer.directory, { recursive: true })
    await fs.mkdir(writer.eventsPath)
    expect(await writer.append({ type: 'turn_start', payload: {} })).toBeUndefined()
    await fs.rm(writer.eventsPath, { recursive: true, force: true })
    await expect(writer.close()).rejects.toMatchObject({ lostEvents: 1, lostBytes: expect.any(Number) })
    const recovered = getSessionEventWriter(root, 's1', 1)
    const event = await recovered.append({ type: 'turn_end', payload: {} })
    expect(event?.seq).toBe(1)
    expect(errors).toHaveLength(1)
  })

  it('never reuses a seq when index update fails after JSONL append', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-index-failure-'))
    const writer = new SessionEventWriter(root, 's1', 1)
    await writer.append({ type: 'turn_start', payload: {} })
    await fs.rm(writer.indexPath, { force: true })
    await fs.mkdir(writer.indexPath)
    expect((await writer.append({ type: 'step_start', payload: {} }))?.seq).toBe(2)
    await fs.rm(writer.indexPath, { recursive: true, force: true })
    expect((await writer.append({ type: 'turn_end', payload: {} }))?.seq).toBe(3)
    const restarted = getSessionEventWriter(root, 's1', 1)
    expect((await restarted.append({ type: 'session_end_seed', payload: {} }))?.seq).toBe(4)
  })

  it('索引更新失败时仍将 JSONL 事件视为已提交并允许后续写入', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-index-only-failure-'))
    const errors: unknown[] = []
    const sink = getSessionEventSink(root, 'index-only', 1, { onError: (error) => errors.push(error) })
    const originalRename = fs.rename
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === sink.indexPath) throw new Error('index rename failed')
      return originalRename(from, to)
    })

    await expect(sink.appendCritical({ type: 'turn_start', payload: {} })).resolves.toMatchObject({ seq: 1 })
    await expect(sink.appendCritical({ type: 'step_start', payload: {} })).resolves.toMatchObject({ seq: 2 })
    expect((await readSessionEvents(sink.eventsPath)).map((event) => event.seq)).toEqual([1, 2])
    expect(errors.length).toBeGreaterThanOrEqual(2)
    await expect(sink.flush()).resolves.toMatchObject({ failed: false, lostEvents: 0, lostBytes: 0 })

    renameSpy.mockRestore()
    await sink.close()
    const restarted = getSessionEventSink(root, 'index-only', 1)
    expect((await restarted.appendCritical({ type: 'turn_end', payload: {} })).seq).toBe(3)
    await restarted.close()
  })

  it('后台 chunk 写失败后不允许已排队的 chunk 或 critical 越过失败批次', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-fifo-failure-'))
    const sink = getSessionEventSink(root, 'fifo-failure', 1, {
      maxBatchEvents: 1,
      flushIntervalMs: 60_000,
      softPendingEvents: 100,
      hardPendingEvents: 100,
      hardPendingBytes: 1024 * 1024
    })
    let releaseFailure!: () => void
    let started!: () => void
    const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve })
    const firstAppendStarted = new Promise<void>((resolve) => { started = resolve })
    const appendSpy = vi.spyOn(fs, 'appendFile').mockImplementationOnce(async () => {
      started()
      await failureGate
      throw new Error('chunk JSONL append failed')
    })

    sink.appendChunk({ type: 'assistant_chunk', payload: { text: 'A' } })
    await firstAppendStarted
    sink.appendChunk({ type: 'assistant_chunk', payload: { text: 'B' } })
    const critical = sink.appendCritical({ type: 'tool_call', payload: { toolUseId: 'C' } })
    releaseFailure()

    await expect(critical).rejects.toThrow(/chunk JSONL append failed/)
    expect(await readSessionEvents(sink.eventsPath)).toEqual([])
    expect(() => sink.appendChunk({ type: 'assistant_chunk', payload: { text: 'D' } })).toThrow(/failed/)
    await expect(sink.flush()).rejects.toMatchObject({
      eventsPath: sink.eventsPath,
      lostEvents: 3,
      lostBytes: expect.any(Number)
    })
    await expect(flushAllSessionEventSinks()).rejects.toThrow(sink.eventsPath)
    await expect(sink.close()).rejects.toMatchObject({ eventsPath: sink.eventsPath, lostEvents: 3 })
    appendSpy.mockRestore()
  })

  it('scans the existing log only once across repeated appends', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-scan-once-'))
    const writer = new SessionEventWriter(root, 'scan-once', 1)
    const readSpy = vi.spyOn(fs, 'readFile')
    await writer.append({ type: 'assistant_chunk', payload: { text: 'a' } })
    await writer.append({ type: 'assistant_chunk', payload: { text: 'b' } })
    await writer.append({ type: 'assistant_chunk', payload: { text: 'c' } })
    expect(readSpy.mock.calls.filter(([file]) => file === writer.eventsPath)).toHaveLength(1)
    readSpy.mockRestore()
  })

  it('reuses one writer for the same session path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-writer-registry-'))
    const first = getSessionEventWriter(root, 'same', 1)
    const second = getSessionEventWriter(root, 'same', 1)
    expect(second).toBe(first)
    await Promise.all([
      first.append({ type: 'assistant_chunk', payload: { text: 'a' } }),
      second.append({ type: 'assistant_chunk', payload: { text: 'b' } })
    ])
    expect((await readSessionEvents(first.eventsPath)).map((event) => event.seq)).toEqual([1, 2])
    expect(JSON.parse(await fs.readFile(first.indexPath, 'utf8'))).toMatchObject({ seq: 2, eventCount: 2 })
  })

  it('serializes 1000 concurrent critical events with unique sequence numbers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-concurrent-'))
    const sink = getSessionEventSink(root, 'concurrent', 1, { flushIntervalMs: 60_000 })
    const committed = await Promise.all(
      Array.from({ length: 1000 }, (_, i) => sink.appendCritical({ type: 'request_context', payload: { i } }))
    )
    expect(committed.map((event) => event.seq)).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1))
    expect((await readSessionEvents(sink.eventsPath)).map((event) => event.seq)).toEqual(committed.map((event) => event.seq))
    await sink.close()
  })

  it('commits chunks in real batches instead of one append per event', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-batch-'))
    const sink = getSessionEventSink(root, 'batch', 1, {
      maxBatchEvents: 4,
      flushIntervalMs: 60_000,
      softPendingEvents: 100,
      hardPendingEvents: 100,
      hardPendingBytes: 1024 * 1024
    })
    const appendSpy = vi.spyOn(fs, 'appendFile')
    for (let i = 0; i < 10; i++) sink.appendChunk({ type: 'assistant_chunk', payload: { text: String(i) } })
    await sink.flush()
    const eventAppends = appendSpy.mock.calls.filter(([file]) => file === sink.eventsPath)
    expect(eventAppends).toHaveLength(3)
    expect((await readSessionEvents(sink.eventsPath)).map((event) => event.seq)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 1)
    )
    appendSpy.mockRestore()
    await sink.close()
  })

  it('persists earlier chunks before resolving a critical barrier', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-barrier-'))
    const sink = getSessionEventSink(root, 'barrier', 1, {
      maxBatchEvents: 100,
      flushIntervalMs: 60_000,
      softPendingEvents: 100,
      hardPendingEvents: 100,
      hardPendingBytes: 1024 * 1024
    })
    sink.appendChunk({ type: 'assistant_chunk', payload: { text: 'before' } })
    const append = sink.appendCritical({ type: 'tool_call', payload: { toolUseId: 'u1' } })
    await expect(Promise.race([append.then(() => 'resolved'), Promise.resolve('pending')])).resolves.toBe('pending')
    const committed = await append
    expect(committed.seq).toBe(2)
    expect((await readSessionEvents(sink.eventsPath)).map((event) => event.type)).toEqual(['assistant_chunk', 'tool_call'])
    await sink.close()
  })

  it('enforces a hard pending limit and exposes soft backpressure', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-backpressure-'))
    const sink = getSessionEventSink(root, 'backpressure', 1, {
      maxBatchEvents: 100,
      flushIntervalMs: 60_000,
      softPendingEvents: 2,
      hardPendingEvents: 3,
      hardPendingBytes: 1024 * 1024
    })
    sink.appendChunk({ type: 'assistant_chunk', payload: { text: '1' } })
    sink.appendChunk({ type: 'assistant_chunk', payload: { text: '2' } })
    sink.appendChunk({ type: 'assistant_chunk', payload: { text: '3' } })
    expect(() => sink.appendChunk({ type: 'assistant_chunk', payload: { text: '4' } })).toThrow(/hard pending limit/)
    await expect(sink.waitForCapacity()).resolves.toBeUndefined()
    sink.appendChunk({ type: 'assistant_chunk', payload: { text: '4' } })
    await sink.close()
  })

  it('never trusts an index sequence ahead of the authoritative JSONL', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-index-ahead-'))
    const first = new SessionEventWriter(root, 'index-ahead', 1)
    await first.append({ type: 'turn_start', payload: {} })
    await fs.writeFile(first.indexPath, JSON.stringify({ formatVersion: 2, seq: 99, eventCount: 99, bytes: 999 }))
    await first.close()
    const restarted = new SessionEventWriter(root, 'index-ahead', 1)
    expect((await restarted.append({ type: 'turn_end', payload: {} }))?.seq).toBe(2)
  })

  it('removes a closed sink from the registry before creating a replacement', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-close-'))
    const first = getSessionEventSink(root, 'close', 1)
    await first.close()
    const second = getSessionEventSink(root, 'close', 1)
    expect(second).not.toBe(first)
    await second.close()
  })

  it('does not allow a second direct sink for an active event path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-single-owner-'))
    const first = new SessionEventWriter(root, 'single-owner', 1)
    expect(() => new SessionEventWriter(root, 'single-owner', 1)).toThrow(/active session event sink/)
    await first.close()
  })

  it('does not discard a complete but invalid final JSON line as a torn write', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-invalid-tail-'))
    const eventsPath = path.join(root, 'events.jsonl')
    await fs.writeFile(eventsPath, JSON.stringify({ seq: 1, time: 1, type: 'not-a-real-event', payload: {} }))
    const malformed: number[] = []
    await expect(readSessionEvents(eventsPath, { onMalformed: (_error, line) => malformed.push(line) })).resolves.toEqual([])
    expect(malformed).toEqual([1])
    expect(await fs.readFile(eventsPath, 'utf8')).toContain('not-a-real-event')
  })

  it('returns an explicit integrity report for malformed event lines', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-integrity-report-'))
    const eventsPath = path.join(root, 'events.jsonl')
    await fs.writeFile(eventsPath, [
      JSON.stringify({ seq: 1, time: 1, type: 'turn_start', payload: {} }),
      '{not-json}',
      JSON.stringify({ seq: 3, time: 3, type: 'turn_end', payload: {} })
    ].join('\n') + '\n')

    const result = await readSessionEventsDetailed(eventsPath)
    expect(result.events.map((event) => event.seq)).toEqual([1, 3])
    expect(result.integrity).toBe('degraded')
    expect(result.issues).toMatchObject([{ line: 2, code: 'malformed-json', truncated: false }])
  })

  it('keeps torn tails untouched for readers and repairs them only when explicitly requested', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-events-tail-read-'))
    const eventsPath = path.join(root, 'events.jsonl')
    const first = JSON.stringify({ seq: 1, time: 1, type: 'turn_start', payload: { turnId: 't' } })
    const original = `${first}\n{"seq":2`
    await fs.writeFile(eventsPath, original)

    const inspected = await readSessionEventsDetailed(eventsPath)

    expect(inspected.integrity).toBe('recovered-tail')
    expect(inspected.events).toHaveLength(1)
    await expect(fs.readFile(eventsPath, 'utf8')).resolves.toBe(original)
    const repaired = await readSessionEventsDetailed(eventsPath, { repairTail: true })
    expect(repaired.events).toHaveLength(1)
    await expect(fs.readFile(eventsPath, 'utf8')).resolves.toBe(`${first}\n`)
  })

  it('isolates a failed session during startup reconciliation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-reconcile-isolation-'))
    const sessionsRoot = path.join(root, 'sessions')
    const good = path.join(sessionsRoot, 'good-19700101')
    const bad = path.join(sessionsRoot, 'bad-19700101')
    await fs.mkdir(good, { recursive: true })
    await fs.mkdir(bad, { recursive: true })
    await fs.writeFile(path.join(good, 'events.jsonl'), JSON.stringify({ seq: 1, time: 1, type: 'turn_start', payload: { turnId: 'g' } }) + '\n')
    await fs.writeFile(path.join(bad, 'events.jsonl'), JSON.stringify({ seq: 1, time: 1, type: 'turn_start', payload: { turnId: 'b' } }) + '\n')
    const appendSpy = vi.spyOn(fs, 'appendFile').mockImplementation(async (file, data, ...rest) => {
      if (file === path.join(bad, 'events.jsonl')) throw new Error('bad session append')
      return (await vi.importActual<typeof import('fs/promises')>('fs/promises')).appendFile(file, data, ...rest)
    })

    const result = await reconcileSessionEventFilesDetailed(root)
    expect(result.fixed).toBe(1)
    expect(result.failures).toMatchObject([{ sessionName: 'bad-19700101', phase: 'append-events' }])
    expect((await readSessionEvents(path.join(good, 'events.jsonl'))).map((event) => event.type)).toEqual(['turn_start', 'turn_end'])
    appendSpy.mockRestore()
  })

  it.each(['sessions-root', 'session-directory', 'events-symlink', 'events-hardlink'] as const)(
    'startup reconciliation refuses a %s path alias', async (aliasKind) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-reconcile-alias-root-'))
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'session-reconcile-alias-outside-'))
      const sessionsRoot = path.join(root, 'sessions')
      const sessionDir = path.join(sessionsRoot, 'alias-19700101')
      let outsideEvents = path.join(outside, 'events.jsonl')
      const openTurn = JSON.stringify({ seq: 1, time: 1, type: 'turn_start', payload: { turnId: 'external' } }) + '\n'
      if (aliasKind === 'sessions-root') {
        const outsideSession = path.join(outside, 'alias-19700101')
        await fs.mkdir(outsideSession)
        outsideEvents = path.join(outsideSession, 'events.jsonl')
        await fs.writeFile(outsideEvents, openTurn)
        await fs.symlink(outside, sessionsRoot, 'dir')
      } else {
        await fs.mkdir(sessionDir, { recursive: true })
        await fs.writeFile(outsideEvents, openTurn)
        if (aliasKind === 'session-directory') {
          await fs.rm(sessionDir, { recursive: true })
          await fs.symlink(outside, sessionDir, 'dir')
        } else if (aliasKind === 'events-symlink') {
          await fs.symlink(outsideEvents, path.join(sessionDir, 'events.jsonl'))
        } else {
          await fs.link(outsideEvents, path.join(sessionDir, 'events.jsonl'))
        }
      }

      const result = await reconcileSessionEventFilesDetailed(root)

      expect(result.fixed).toBe(0)
      expect(result.failures).toHaveLength(1)
      await expect(fs.readFile(outsideEvents, 'utf8')).resolves.toBe(openTurn)
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  )

  it('does not append recovery events to a degraded ledger with an invalid final record', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-reconcile-degraded-'))
    const eventsDir = path.join(root, 'sessions', 'degraded-19700101')
    const eventsPath = path.join(eventsDir, 'events.jsonl')
    const validStart = JSON.stringify({ seq: 1, time: 1, type: 'turn_start', payload: { turnId: 't' } })
    const invalidFinal = JSON.stringify({ seq: 2, type: 'turn_end', payload: { turnId: 't' } })
    const original = `${validStart}\n${invalidFinal}`
    await fs.mkdir(eventsDir, { recursive: true })
    await fs.writeFile(eventsPath, original)

    const result = await reconcileSessionEventFilesDetailed(root)

    expect(result.fixed).toBe(0)
    expect(result.failures).toMatchObject([{ sessionName: 'degraded-19700101', phase: 'read-events', jsonlCommitted: false }])
    expect(result.sessions).toMatchObject([{ sessionName: 'degraded-19700101', integrity: 'degraded', fixed: 0 }])
    await expect(fs.readFile(eventsPath, 'utf8')).resolves.toBe(original)
  })

  it('reports index failure after recovery append without duplicating repair events', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-reconcile-index-failure-'))
    const eventsDir = path.join(root, 'sessions', 'index-failure-19700101')
    const eventsPath = path.join(eventsDir, 'events.jsonl')
    await fs.mkdir(eventsDir, { recursive: true })
    await fs.writeFile(eventsPath, JSON.stringify({ seq: 1, time: 1, type: 'turn_start', payload: { turnId: 't' } }) + '\n')
    const indexPath = path.join(eventsDir, 'events.index.json')
    const originalRename = fs.rename
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === indexPath) throw new Error('recovery index rename failed')
      return originalRename(from, to)
    })

    const first = await reconcileSessionEventFilesDetailed(root)
    expect(first.fixed).toBe(1)
    expect(first.failures).toMatchObject([{ phase: 'write-index', jsonlCommitted: true }])
    const second = await reconcileSessionEventFilesDetailed(root)
    expect(second.fixed).toBe(0)
    expect((await readSessionEvents(eventsPath)).map((event) => event.type)).toEqual(['turn_start', 'turn_end'])
    renameSpy.mockRestore()
  })


  it('repairs unfinished event files on startup and is idempotent', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-reconcile-'))
    const writer = new SessionEventWriter(root, 's1', Date.UTC(2026, 0, 1))
    await writer.append({ type: 'turn_start', payload: { turnId: 't1' } })
    await writer.append({ type: 'tool_call', payload: { turnId: 't1', stepId: 'step', toolUseId: 'u1', name: 'x', args: {} } })
    expect(await reconcileSessionEventFiles(root)).toBe(2)
    expect(await reconcileSessionEventFiles(root)).toBe(0)
    const repaired = await fs.readFile(writer.eventsPath, 'utf8')
    expect(repaired).toContain('"synthetic":true')
    expect(repaired).toContain('"reason":"interrupted"')
  })

  it('skips invalid usage payloads while accumulating valid request usage', () => {
    const events: SessionEvent[] = [
      { seq: 1, time: 1, type: 'request_usage', payload: { usage: null } },
      { seq: 2, time: 2, type: 'request_usage', payload: { usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: -1 } } },
      { seq: 3, time: 3, type: 'request_usage', payload: { usage: { input_tokens: Number.NaN, output_tokens: 2 } } },
      { seq: 4, time: 4, type: 'request_usage', payload: { usage: { input_tokens: 5, output_tokens: 6 } } }
    ]
    expect(computeSessionUsageFromEvents(events)).toMatchObject({ input_tokens: 8, output_tokens: 12 })
  })

  it('closes event production before shutdown flush and drains already accepted events', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-shutdown-barrier-'))
    const sink = getSessionEventSink(root, 'shutdown-barrier', 1, { flushIntervalMs: 60_000 })
    sink.appendChunk({ type: 'assistant_chunk', payload: { text: 'accepted-before-shutdown' } })
    beginSessionEventShutdown()

    expect(() => sink.appendChunk({ type: 'assistant_chunk', payload: { text: 'rejected-after-shutdown' } })).toThrow(/production is closed|closing/)
    expect(() => sink.appendCritical({ type: 'turn_end', payload: {} })).toThrow('session event sink is closing')
    await expect(flushAllSessionEventSinks()).resolves.toBeUndefined()
    expect((await readSessionEvents(sink.eventsPath)).map((event) => event.payload.text)).toEqual(['accepted-before-shutdown'])
  })
})

describe('stripPartialJsonForPersist（R1：流式入参分片不落台账）', () => {
  it('assistant_chunk 的 tool_call_delta.partialJson 剥离为空串', () => {
    const out = stripPartialJsonForPersist({
      type: 'assistant_chunk',
      payload: { turnId: 't1', delta: { type: 'tool_call_delta', index: 2, partialJson: '{"accessTok' } }
    })
    expect(out.type).toBe('assistant_chunk')
    expect((out.payload.delta as { partialJson: string }).partialJson).toBe('')
  })

  it('其他 delta 类型与其他事件原样透传', () => {
    const textChunk = { type: 'assistant_chunk', payload: { delta: { type: 'text_delta', text: 'hi' } } }
    expect(stripPartialJsonForPersist(textChunk)).toBe(textChunk)
    const toolCall = { type: 'tool_call', payload: { args: { a: 1 } } }
    expect(stripPartialJsonForPersist(toolCall)).toBe(toolCall)
  })
})
