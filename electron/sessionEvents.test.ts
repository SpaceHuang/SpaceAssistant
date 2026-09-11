import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  getSessionEventSink,
  beginSessionEventShutdown,
  SessionEventWriter,
  getSessionEventWriter,
  computeSessionUsageFromEvents,
  enforceSessionEventRetention,
  enforceSessionEventRetentionDetailed,
  flushAllSessionEventSinks,
  parseSessionEvent,
  readSessionEvents,
  readSessionEventsDetailed,
  reconcileSessionEventFiles,
  reconcileSessionEventFilesDetailed,
  reconcileSessionEvents,
  type SessionEvent
} from './sessionEvents'

describe('session events', () => {
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

  it('retains the newest event sessions by index timestamp', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-'))
    for (const [id, time] of [['old', 1], ['new', 2]] as const) {
      const writer = new SessionEventWriter(root, id, time)
      await writer.append({ type: 'session_end_seed', payload: { seedSeq: 0 } })
      await fs.writeFile(writer.indexPath, JSON.stringify({ seq: 1, lastAt: time, eventCount: 1, bytes: 1 }))
    }
    expect(await enforceSessionEventRetention(root, 1)).toBe(1)
    expect(await fs.stat(path.join(root, 'sessions', 'new-19700101'))).toBeTruthy()
    await expect(fs.stat(path.join(root, 'sessions', 'old-19700101'))).rejects.toThrow()
  })

  it('isolates retention deletion failure and continues the retention pass', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-retention-failure-'))
    for (const [id, time] of [['oldest', 1], ['middle', 2], ['newest', 3]] as const) {
      const dir = path.join(root, 'sessions', `${id}-19700101`)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'events.index.json'), JSON.stringify({ lastAt: time }))
    }
    const originalRm = fs.rm
    const rmSpy = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (target === path.join(root, 'sessions', 'oldest-19700101')) throw new Error('retention delete failed')
      return originalRm(target, options)
    })

    const result = await enforceSessionEventRetentionDetailed(root, 1)
    expect(result.removed).toBe(1)
    expect(result.failures).toMatchObject([{ sessionName: 'oldest-19700101', phase: 'retention-delete' }])
    await expect(fs.stat(path.join(root, 'sessions', 'middle-19700101'))).rejects.toThrow()
    expect(await fs.stat(path.join(root, 'sessions', 'newest-19700101'))).toBeTruthy()
    rmSpy.mockRestore()
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
