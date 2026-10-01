import { createAcceptedTurn, type AcceptedTurn } from '../../src/shared/acceptedTurn'
import type { AppDatabase } from './sqliteStore'
import { getDbConnection } from './sqliteStore'
import { runInTransaction } from './transaction'

/** First acceptance wins; retries reuse its exact config/transcript version but may not rebind identity. */
export function acceptTurnContext(db: AppDatabase, candidate: AcceptedTurn, now = Date.now()): AcceptedTurn {
  const conn = getDbConnection(db)
  const result = runInTransaction(conn, () => {
    const byTurn = conn.prepare('SELECT accepted_turn_json FROM accepted_turn_contexts WHERE turn_id=?').get(candidate.turnId) as { accepted_turn_json: string } | undefined
    const byRequest = conn.prepare('SELECT accepted_turn_json FROM accepted_turn_contexts WHERE session_id=? AND request_id=?').get(candidate.sessionId, candidate.requestId) as { accepted_turn_json: string } | undefined
    if (byTurn && byRequest && byTurn.accepted_turn_json !== byRequest.accepted_turn_json) throw new Error('ACCEPTED_TURN_IDENTITY_CONFLICT')
    const existing = byTurn ?? byRequest
    if (existing) {
      const accepted = createAcceptedTurn(JSON.parse(existing.accepted_turn_json) as AcceptedTurn)
      if (accepted.turnId !== candidate.turnId || accepted.requestId !== candidate.requestId || accepted.sessionId !== candidate.sessionId ||
        accepted.lane !== candidate.lane || accepted.startToken !== candidate.startToken || accepted.currentUserMessageId !== candidate.currentUserMessageId) {
        throw new Error('ACCEPTED_TURN_IDENTITY_CONFLICT')
      }
      return { accepted, inserted: false }
    }
    conn.prepare('INSERT INTO accepted_turn_contexts(turn_id,session_id,request_id,accepted_turn_json,created_at) VALUES(?,?,?,?,?)')
      .run(candidate.turnId, candidate.sessionId, candidate.requestId, JSON.stringify(candidate), now)
    return { accepted: candidate, inserted: true }
  })
  if (result.inserted) db.save()
  return result.accepted
}

export function readAcceptedTurn(db: AppDatabase, sessionId: string, requestId: string): AcceptedTurn | undefined {
  const row = getDbConnection(db).prepare('SELECT accepted_turn_json FROM accepted_turn_contexts WHERE session_id=? AND request_id=?').get(sessionId, requestId) as { accepted_turn_json: string } | undefined
  if (!row) return undefined
  return createAcceptedTurn(JSON.parse(row.accepted_turn_json) as AcceptedTurn)
}
