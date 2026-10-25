import { afterEach, describe, expect, it } from 'vitest'
import path from 'node:path'
import { createSession } from '../../../database/operations'
import { createTempDatabase } from '../../../database/testHelpers'
import { getDbConnection } from '../../../database/sqliteStore'
import { SqliteAgentHistory } from '../../../runtime/sqliteAgentHistory'
import { createSpillStore } from '../../../storage/spillStore'
import { readProjectionSourceIdentity } from './projectionSourceIdentity'
import { readProjectionHistoryChunk } from './projectionHistoryChunkReader'

describe('large History source reachability probe', () => {
  let temp: ReturnType<typeof createTempDatabase> | undefined
  afterEach(() => { temp?.cleanup(); temp = undefined })

  it('persists a legitimate single event above 32 MiB through the canonical writer', async () => {
    temp = createTempDatabase('projection-history-reachable-large-event-')
    const session = createSession(temp.db, { name: 'large source event' })
    const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, () => 10, session.id,
      createSpillStore(path.join(path.dirname(temp.dbPath), 'spill')))
    const messages = Array.from({ length: 850 }, (_, index) => ({ id: `large-source-${index}`, role: 'user',
      content: 'x'.repeat(40 * 1024), timestamp: index }))
    await history.appendBatch([{ invocationId: 'reachable-large-invocation', turnId: 'reachable-large-turn',
      sequence: 1, schemaVersion: 1, eventId: 'reachable-large-event', idempotencyKey: 'reachable-large-key',
      kind: 'invocation-context-committed', payload: { messages } }], 0)

    const row = getDbConnection(temp.db).prepare(`SELECT length(CAST(payload_json AS BLOB)) AS byte_length,
      instr(payload_json, '__spaceassistant_spill_v1') AS spill_marker FROM agent_history_events WHERE event_id=?`)
      .get('reachable-large-event') as { byte_length: number; spill_marker: number }
    expect(row.byte_length).toBeGreaterThan(32 * 1024 * 1024)
    expect(row.spill_marker).toBe(0)
    const sourceIdentityJson = readProjectionSourceIdentity(getDbConnection(temp.db), session.id, session.generation)!
    expect(readProjectionHistoryChunk({ dbPath: temp.dbPath, sessionId: session.id, sessionGeneration: session.generation,
      scopeKey: 'chatBodyV1', specVersion: 1, sourceIdentityJson, connectionEpoch: 1, processGeneration: 1,
      rebuildToken: 'large-event-reachability' }, { afterSessionSequence: 0, maxRows: 1, maxBytes: 256 * 1024,
      allowOversizedChunk: true })).toMatchObject({ kind: 'deferred-large', eventSequence: 1,
      reason: 'oversized-event-exceeds-staging-budget' })
  }, 60_000)
})
