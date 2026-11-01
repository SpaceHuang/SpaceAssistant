import { strict as assert } from 'node:assert'
import { performance } from 'node:perf_hooks'
import { openSqliteDatabase, getDbConnection } from '../electron/database/sqliteStore.ts'
import { createSession } from '../electron/database/operations.ts'
import { readSessionTranscript } from '../electron/database/sessionTranscript.ts'
import { SqliteAgentHistory } from '../electron/runtime/sqliteAgentHistory.ts'

const sampleCount = 30

async function measureToolHistory(rounds: number): Promise<void> {
  const db = openSqliteDatabase(':memory:')
  const session = createSession(db, { name: `tool-heavy-${rounds}`, model: 'test' })
  const conn = getDbConnection(db)
  const history = new SqliteAgentHistory(conn, 1, Date.now, session.id)
  const resultBody = 'x'.repeat(4096)

  try {
    for (let index = 0; index < rounds; index += 1) {
      const invocationId = `tool-heavy-${rounds}-${index}`
      const turnId = `tool-turn-${index}`
      const callId = `tool-call-${index}`
      const userMessage = { role: 'user' as const, content: `question-${index}` }
      const event = (sequence: number, kind: string, payload: unknown) => ({ invocationId, turnId,
        eventId: `${invocationId}-${sequence}`, idempotencyKey: `${invocationId}-${sequence}`, sequence,
        schemaVersion: 1, kind, payload })
      const events = [
        event(1, 'invocation-context-committed', { contextProtocol: 2,
          inputMode: index === 0 ? 'baseline' : 'delta', messages: [userMessage], inputMessages: [userMessage],
          failureInputMessages: [userMessage], scope: { kind: 'session', sessionId: session.id } }),
        event(2, 'model-request-started', { requestId: `${invocationId}:round:1`, modelTurn: 1, attempt: 1 }),
        event(3, 'provider-attempt-result', { requestId: `${invocationId}:round:1`, modelTurn: 1, attempt: 1,
          physical: true, attemptSource: { kind: 'initial' }, outcome: 'succeeded', usage: { status: 'unreported' } }),
        event(4, 'model-response-committed', { modelTurn: 1,
          message: { role: 'assistant', content: '', toolCalls: [{ id: callId, name: 'lookup', input: {} }] } }),
        event(5, 'tool-call-started', { toolCall: { id: callId, name: 'lookup', input: {} } }),
        event(6, 'tool-call-finished', { toolCallId: callId, result: resultBody, replayContent: resultBody, isError: false }),
        event(7, 'model-response-committed', { modelTurn: 2, message: { role: 'assistant', content: 'done' } }),
        event(8, 'invocation-completed', { status: 'completed', contextSelection: { contextProtocol: 2, target: 'working' } })
      ]
      await history.appendBatch(events.slice(0, -1), 0)
      await history.appendBatch([events.at(-1)!], events.length - 1, { sessionId: session.id, baseVersion: index,
        protocol: 2, contextSelection: { contextProtocol: 2, target: 'working' }, outcome: 'completed' })
    }

    let transcript: ReturnType<typeof readSessionTranscript> | undefined
    const readSamplesMs: number[] = []
    let maxEventLoopDelayMs = 0
    for (let sample = 0; sample < sampleCount; sample += 1) {
      let timerDelayMs = 0
      const timerStart = performance.now()
      const tick = new Promise<void>((resolve) => setImmediate(() => { timerDelayMs = performance.now() - timerStart; resolve() }))
      const readStart = performance.now()
      transcript = readSessionTranscript(db, session.id)
      readSamplesMs.push(performance.now() - readStart)
      await tick
      maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, timerDelayMs)
    }
    assert.equal(transcript?.messages.length, rounds * 4)
    assert.equal(transcript?.messages.at(-2)?.role, 'tool')
    assert.equal((transcript?.messages.at(-2) as { content?: unknown } | undefined)?.content, resultBody)
    const sorted = [...readSamplesMs].sort((left, right) => left - right)
    const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1]!
    const maxReadMs = Math.max(...readSamplesMs)
    const maxContinuousBlockMs = Math.max(maxReadMs, maxEventLoopDelayMs)
    console.log(JSON.stringify({ toolRounds: rounds, transcriptMessages: transcript!.messages.length,
      samples: sampleCount, p95Ms, maxReadMs, maxEventLoopDelayMs, maxContinuousBlockMs }))
    assert.ok(maxContinuousBlockMs <= 50,
      `${rounds} tool rounds blocked cold transcript replay for ${maxContinuousBlockMs.toFixed(1)} ms (read=${maxReadMs.toFixed(1)} ms, event-loop=${maxEventLoopDelayMs.toFixed(1)} ms)`)
  } finally {
    db.close()
  }
}

for (const rounds of [10, 100, 1000]) await measureToolHistory(rounds)
