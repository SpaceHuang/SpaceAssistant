import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import type { ImLifecycleStage } from './imRemoteOutbound'
import { assertImOutboundAllowed, type ImOutboundFacts } from '../../src/shared/confirmation/outboundClassification'

type OutboxRecord = { eventId: string; sessionId: string; stage: ImLifecycleStage; text: string; state: 'pending' | 'delivered'; createdAt: number }
type OutboxRow = { event_id: string; session_id: string; stage: ImLifecycleStage; text: string; state: OutboxRecord['state']; created_at: number }
const toRecord = (row: OutboxRow): OutboxRecord => ({ eventId: row.event_id, sessionId: row.session_id, stage: row.stage, text: row.text, state: row.state, createdAt: row.created_at })

export function createImLifecycleOutbox(db: AppDatabase) {
  const conn = getDbConnection(db)
  function get(eventId: string): OutboxRecord | null {
    const row = conn.prepare('SELECT event_id,session_id,stage,text,state,created_at FROM im_lifecycle_outbox WHERE event_id=?').get(eventId) as OutboxRow | undefined
    return row ? toRecord(row) : null
  }
  return {
    get,
    listPending(sessionId: string): OutboxRecord[] {
      const rows = conn.prepare(`SELECT event_id,session_id,stage,text,state,created_at FROM im_lifecycle_outbox
        WHERE session_id=? AND state='pending' ORDER BY created_at,event_id`).all(sessionId) as OutboxRow[]
      return rows.map(toRecord)
    },
    async deliver(event: { eventId: string; sessionId: string; stage: ImLifecycleStage; text: string }, send: (text: string) => Promise<void>, authorize?: () => ImOutboundFacts): Promise<OutboxRecord & { duplicate?: boolean }> {
      if (![event.eventId, event.sessionId, event.text].every((value) => value.trim())) throw new TypeError('IM_LIFECYCLE_IDENTITY_REQUIRED')
      const existing = get(event.eventId)
      if (existing) {
        if (existing.sessionId !== event.sessionId || existing.stage !== event.stage || existing.text !== event.text) throw new Error('IM_LIFECYCLE_EVENT_CONFLICT')
        if (existing.state === 'delivered') return { ...existing, duplicate: true }
      } else {
        const now = Date.now()
        conn.prepare(`INSERT INTO im_lifecycle_outbox(event_id,session_id,stage,text,state,created_at,updated_at) VALUES(?,?,?,?, 'pending',?,?)`)
          .run(event.eventId, event.sessionId, event.stage, event.text, now, now)
        db.save()
      }
      if (!authorize) throw new Error('IM_OUTBOUND_FINAL_CHECK_REQUIRED')
      const facts = authorize()
      const recipient = facts.recipient ?? facts.trustedRecipient ?? ''
      try { assertImOutboundAllowed(facts, { channel: facts.channel, body: event.text, sessionId: event.sessionId, recipient }) }
      catch { throw new Error('IM_OUTBOUND_FINAL_CHECK_REQUIRED') }
      await send(event.text)
      conn.prepare("UPDATE im_lifecycle_outbox SET state='delivered',updated_at=? WHERE event_id=? AND state='pending'").run(Date.now(), event.eventId)
      db.save()
      return get(event.eventId)!
    }
  }
}
