import { performance } from 'node:perf_hooks'
import { strict as assert } from 'node:assert'
import { openSqliteDatabase, getDbConnection } from '../electron/database/sqliteStore.ts'
import { createSession } from '../electron/database/operations.ts'
import { readSessionTranscript } from '../electron/database/sessionTranscript.ts'
import { SqliteAgentHistory } from '../electron/runtime/sqliteAgentHistory.ts'
import { restoreSessionContext } from '../packages/agent-sdk/src/sessionContext.ts'

const db = openSqliteDatabase(':memory:')
const session = createSession(db, { name: 'session cold replay benchmark', model: 'test' })
const conn = getDbConnection(db)
const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
const answer = 'x'.repeat(4096)
const checkpoints = new Set([100, 250, 400, 1000, 2500])
// Enables per-read SQLite/JSON timing wrappers for diagnosis; leave unset for baseline gate runs.
const profileReadPhases = process.env.SESSION_CONTEXT_COLD_REPLAY_PROFILE === '1'

try {
  for (let index = 0; index < 2500; index += 1) {
    const invocationId = `cold-replay-${index}`
    const turnId = `cold-turn-${index}`
    const makeEvent = (sequence: number, kind: string, payload: unknown) => ({ invocationId, turnId,
      eventId: `${invocationId}-${sequence}`, idempotencyKey: `${invocationId}-${sequence}`, sequence,
      schemaVersion: 1, kind, payload })
    const userMessage = { role: 'user' as const, content: `question-${index}` }
    const requiredUserMessage = { id: `cold-user-${index}`, message: { ...userMessage, id: `cold-user-${index}` } }
    const context = makeEvent(1, 'invocation-context-committed', {
      contextProtocol: 2, inputMode: index === 0 ? 'baseline' : 'delta',
      messages: [userMessage], inputMessages: [userMessage], failureInputMessages: [userMessage],
      scope: { kind: 'session', sessionId: session.id },
      ...([999].includes(index) ? { requiredUserMessage } : {})
    })
    const request = makeEvent(2, 'model-request-started', { requestId: `${invocationId}:round:1`, modelTurn: 1, attempt: 1 })
    const useTool = index === 499
    const useCompaction = index === 999
    const useFailure = index === 1499
    const attempt = makeEvent(3, 'provider-attempt-result', { requestId: `${invocationId}:round:1`, modelTurn: 1, attempt: 1,
      physical: true, attemptSource: { kind: 'initial' }, outcome: useFailure ? 'failed' : 'succeeded', usage: { status: 'unreported' } })
    const response = makeEvent(4, 'model-response-committed', { modelTurn: 1, message: { role: 'assistant', content: answer } })
    const terminal = useFailure
      ? makeEvent(4, 'invocation-failed', { status: 'failed', contextSelection: { contextProtocol: 2, target: 'failure' } })
      : makeEvent(useTool ? 8 : useCompaction ? 6 : 5, 'invocation-completed', {
        status: 'completed', contextSelection: { contextProtocol: 2, target: 'working' }
      })
    const turnEvents = useTool ? [
      context, request, attempt,
      makeEvent(4, 'model-response-committed', { modelTurn: 1, message: { role: 'assistant', content: '', toolCalls: [{ id: 'cold-tool', name: 'lookup', input: {} }] } }),
      makeEvent(5, 'tool-call-started', { toolCall: { id: 'cold-tool', name: 'lookup', input: {} } }),
      makeEvent(6, 'tool-call-finished', { toolCallId: 'cold-tool', result: 'cold tool result', replayContent: 'cold tool result', isError: false }),
      makeEvent(7, 'model-response-committed', { modelTurn: 2, message: { role: 'assistant', content: answer } }),
      terminal
    ] : useCompaction ? [context, request, attempt,
      makeEvent(4, 'transcript-compacted', { contextProtocol: 2, messages: [
        { role: 'assistant', id: 'cold-summary', content: 'compressed history' }, requiredUserMessage.message
      ], requiredUserMessageId: requiredUserMessage.id, failureCut: 1 }),
      makeEvent(5, 'model-response-committed', { modelTurn: 1, message: { role: 'assistant', content: answer } }), terminal
    ] : useFailure ? [context, request, attempt, terminal] : [context, request, attempt, response, terminal]
    assert.deepEqual(turnEvents.map((event) => event.kind), useTool ? [
      'invocation-context-committed', 'model-request-started', 'provider-attempt-result', 'model-response-committed',
      'tool-call-started', 'tool-call-finished', 'model-response-committed', 'invocation-completed'
    ] : useCompaction ? [
      'invocation-context-committed', 'model-request-started', 'provider-attempt-result', 'transcript-compacted',
      'model-response-committed', 'invocation-completed'
    ] : useFailure ? [
      'invocation-context-committed', 'model-request-started', 'provider-attempt-result', 'invocation-failed'
    ] : [
      'invocation-context-committed', 'model-request-started', 'provider-attempt-result',
      'model-response-committed', 'invocation-completed'
    ])
    await history.appendBatch(turnEvents.slice(0, -1), 0)
    const target = useFailure ? 'failure' : 'working'
    await history.appendBatch([turnEvents.at(-1)!], turnEvents.length - 1, { sessionId: session.id, baseVersion: index, protocol: 2,
      contextSelection: { contextProtocol: 2, target }, outcome: useFailure ? 'failed' : 'completed' })

    const rounds = index + 1
    if (!checkpoints.has(rounds)) continue
    const sqlStart = performance.now()
    const rows = conn.prepare(`SELECT event_id,turn_id,kind,payload_json
      FROM agent_history_events WHERE session_id=? ORDER BY session_seq ASC`).all(session.id) as Array<{
        event_id: string; turn_id: string; kind: string; payload_json: string
      }>
    const sqlMs = performance.now() - sqlStart
    const parseStart = performance.now()
    const events = rows.map((row) => ({ eventId: row.event_id, turnId: row.turn_id, kind: row.kind,
      payload: JSON.parse(row.payload_json) as unknown }))
    const parseMs = performance.now() - parseStart
    const reduceStart = performance.now()
    const restored = restoreSessionContext({ committedVersion: rounds, events })
    const expectedRows = rounds * 5 + (rounds >= 500 ? 3 : 0) + (rounds >= 1000 ? 1 : 0) - (rounds >= 1500 ? 1 : 0)
    assert.equal(rows.length, expectedRows, `unexpected persisted event count at ${rounds} rounds`)
    for (const kind of ['invocation-context-committed', 'model-request-started', 'provider-attempt-result']) {
      assert.equal(events.filter((event) => event.kind === kind).length, rounds, `missing ${kind} events at ${rounds} rounds`)
    }
    assert.equal(events.filter((event) => event.kind === 'tool-call-started').length, rounds >= 500 ? 1 : 0)
    assert.equal(events.filter((event) => event.kind === 'tool-call-finished').length, rounds >= 500 ? 1 : 0)
    assert.equal(events.filter((event) => event.kind === 'transcript-compacted').length, rounds >= 1000 ? 1 : 0)
    assert.equal(events.filter((event) => event.kind === 'invocation-failed').length, rounds >= 1500 ? 1 : 0)
    assert.equal(events.filter((event) => event.kind === 'invocation-completed').length, rounds - (rounds >= 1500 ? 1 : 0))
    assert.equal(events.filter((event) => event.kind === 'model-response-committed').length, rounds + (rounds >= 500 ? 1 : 0) - (rounds >= 1500 ? 1 : 0))
    const reduceMs = performance.now() - reduceStart
    const totalSamples: number[] = []
    const eventLoopSamples: number[] = []
    let maxEventLoopDelayMs = 0
    let transcript: ReturnType<typeof readSessionTranscript> | undefined
    const readStageSamples: Array<{ sample: number; readMs: number; sqlMs: number; jsonParseMs: number; reducerMs: number; remainingMs: number }> = []
    for (let sample = 0; sample < 30; sample += 1) {
      let timerDelayMs = 0
      const timerStart = performance.now()
      const tick = new Promise<void>((resolve) => setImmediate(() => { timerDelayMs = performance.now() - timerStart; resolve() }))
      let readSqlMs = 0
      let readJsonParseMs = 0
      let readReducerMs = 0
      const originalPrepare = conn.prepare
      const originalJsonParse = JSON.parse
      if (profileReadPhases) {
        conn.prepare = ((sql: string) => {
          const statement = originalPrepare.call(conn, sql)
          return new Proxy(statement, { get(target, property) {
            const method = Reflect.get(target, property, target)
            if (property !== 'get' && property !== 'all') return typeof method === 'function' ? method.bind(target) : method
            return (...args: unknown[]) => {
              const queryStart = performance.now()
              try { return method.apply(target, args) }
              finally { readSqlMs += performance.now() - queryStart }
            }
          } })
        }) as typeof conn.prepare
        JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
          const parseStart = performance.now()
          try { return originalJsonParse(...args) }
          finally { readJsonParseMs += performance.now() - parseStart }
        }) as typeof JSON.parse
      }
      const totalStart = performance.now()
      try { transcript = readSessionTranscript(db, session.id, {}, profileReadPhases
        ? (durationMs) => { readReducerMs = durationMs }
        : undefined) }
      finally {
        if (profileReadPhases) {
          conn.prepare = originalPrepare
          JSON.parse = originalJsonParse
        }
      }
      const readMs = performance.now() - totalStart
      totalSamples.push(readMs)
      if (profileReadPhases) readStageSamples.push({ sample, readMs, sqlMs: readSqlMs, jsonParseMs: readJsonParseMs,
        reducerMs: readReducerMs, remainingMs: Math.max(0, readMs - readSqlMs - readJsonParseMs - readReducerMs) })
      await tick
      eventLoopSamples.push(timerDelayMs)
      maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, timerDelayMs)
    }
    assert.deepEqual(transcript?.messages, restored.committed, `warm/cold transcript mismatch at ${rounds} rounds`)
    const sortedTotalSamples = [...totalSamples].sort((left, right) => left - right)
    const totalReadP95Ms = sortedTotalSamples[Math.ceil(sortedTotalSamples.length * 0.95) - 1]!
    const maxReadSampleMs = Math.max(...totalSamples)
    const maxContinuousBlockMs = Math.max(maxReadSampleMs, maxEventLoopDelayMs)
    const slowestRead = readStageSamples.length
      ? readStageSamples.reduce((slowest, candidate) => candidate.readMs > slowest.readMs ? candidate : slowest)
      : undefined
    const summarizeStage = (select: (sample: typeof readStageSamples[number]) => number) => {
      const sorted = readStageSamples.map(select).sort((left, right) => left - right)
      return { p50: Number(sorted[Math.floor(sorted.length * 0.5)]!.toFixed(2)),
        p95: Number(sorted[Math.ceil(sorted.length * 0.95) - 1]!.toFixed(2)), max: Number(sorted.at(-1)!.toFixed(2)) }
    }
    console.log(JSON.stringify({ rounds, rows: transcript!.messages.length, historyEventRows: rows.length, historyBytes: rounds * 4096,
      sqlMs, parseMs, reduceMs, totalReadSampleCount: totalSamples.length, eventLoopDelayMs: maxEventLoopDelayMs,
      totalReadP95Ms, maxReadSampleMs, maxContinuousBlockMs,
      ...(slowestRead ? { readStageSummary: { sql: summarizeStage((sample) => sample.sqlMs), jsonParse: summarizeStage((sample) => sample.jsonParseMs),
        reducer: summarizeStage((sample) => sample.reducerMs), remaining: summarizeStage((sample) => sample.remainingMs) },
        slowestRead: { sample: slowestRead.sample, readMs: Number(slowestRead.readMs.toFixed(2)),
          sqlMs: Number(slowestRead.sqlMs.toFixed(2)), jsonParseMs: Number(slowestRead.jsonParseMs.toFixed(2)), reducerMs: Number(slowestRead.reducerMs.toFixed(2)),
          remainingMs: Number(slowestRead.remainingMs.toFixed(2)) } } : {}),
      readSamplesMs: totalSamples.map((sample) => Number(sample.toFixed(2))),
      eventLoopSamplesMs: eventLoopSamples.map((sample) => Number(sample.toFixed(2))),
      reducerMessageCount: restored.committed.length }))
    assert.ok(maxContinuousBlockMs <= 50, `${rounds * 4096} byte cold replay blocked main thread for ${maxContinuousBlockMs.toFixed(1)} ms (read=${maxReadSampleMs.toFixed(1)} ms, event-loop=${maxEventLoopDelayMs.toFixed(1)} ms)`)
  }
} finally {
  db.close()
}
