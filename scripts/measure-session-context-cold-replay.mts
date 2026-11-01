import { performance } from 'node:perf_hooks'
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

try {
  for (let index = 0; index < 2500; index += 1) {
    const invocationId = `cold-replay-${index}`
    const turnId = `cold-turn-${index}`
    const makeEvent = (sequence: number, kind: string, payload: unknown) => ({ invocationId, turnId,
      eventId: `${invocationId}-${sequence}`, idempotencyKey: `${invocationId}-${sequence}`, sequence,
      schemaVersion: 1, kind, payload })
    const userMessage = { role: 'user' as const, content: `question-${index}` }
    const context = makeEvent(1, 'invocation-context-committed', {
      contextProtocol: 2, inputMode: index === 0 ? 'baseline' : 'delta',
      messages: [userMessage], inputMessages: [userMessage], failureInputMessages: [userMessage],
      scope: { kind: 'session', sessionId: session.id }
    })
    const response = makeEvent(2, 'model-response-committed', { modelTurn: 1, message: { role: 'assistant', content: answer } })
    const terminal = makeEvent(3, 'invocation-completed', { status: 'completed', contextSelection: { contextProtocol: 2, target: 'working' } })
    await history.appendBatch([context, response], 0)
    await history.appendBatch([terminal], 2, { sessionId: session.id, baseVersion: index, protocol: 2,
      contextSelection: { contextProtocol: 2, target: 'working' }, outcome: 'completed' })

    const rounds = index + 1
    if (!checkpoints.has(rounds)) continue
    const sqlStart = performance.now()
    const rows = conn.prepare(`SELECT event_id,turn_id,kind,payload_json
      FROM agent_history_events WHERE session_id=? ORDER BY session_seq ASC`).all(session.id) as Array<{
        event_id: string; turn_id: string; kind: 'invocation-context-committed' | 'model-response-committed' | 'invocation-completed'; payload_json: string
      }>
    const sqlMs = performance.now() - sqlStart
    const parseStart = performance.now()
    const events = rows.map((row) => ({ eventId: row.event_id, turnId: row.turn_id, kind: row.kind,
      payload: JSON.parse(row.payload_json) as unknown }))
    const parseMs = performance.now() - parseStart
    const reduceStart = performance.now()
    const restored = restoreSessionContext({ committedVersion: rounds, events })
    const reduceMs = performance.now() - reduceStart
    const totalSamples: number[] = []
    let maxEventLoopDelayMs = 0
    let transcript: ReturnType<typeof readSessionTranscript> | undefined
    for (let sample = 0; sample < 5; sample += 1) {
      let timerDelayMs = 0
      const timerStart = performance.now()
      const tick = new Promise<void>((resolve) => setImmediate(() => { timerDelayMs = performance.now() - timerStart; resolve() }))
      const totalStart = performance.now()
      transcript = readSessionTranscript(db, session.id)
      totalSamples.push(performance.now() - totalStart)
      await tick
      maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, timerDelayMs)
    }
    console.log(JSON.stringify({ rounds, rows: transcript!.messages.length, historyBytes: rounds * 4096,
      sqlMs, parseMs, reduceMs, totalSamples, eventLoopDelayMs: maxEventLoopDelayMs,
      maxContinuousBlockMs: Math.max(...totalSamples, maxEventLoopDelayMs), reducerMessageCount: restored.committed.length }))
  }
} finally {
  db.close()
}
