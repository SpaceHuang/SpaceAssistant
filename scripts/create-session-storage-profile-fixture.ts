import fs from 'node:fs/promises'
import path from 'node:path'
import { appendSqliteAgentHistoryBatchInTransaction } from '../electron/database/agentHistoryStorage'
import { createSession } from '../electron/database/operations'
import { getDbConnection } from '../electron/database/sqliteStore'
import { openDatabase } from '../electron/database'
import { DB_SCHEMA_VERSION } from '../electron/database/schema'
import type { HistoryEvent } from '../packages/agent-sdk/src/history'

const outputPath = process.argv[2]
if (!outputPath) throw new Error('Usage: node --import tsx scripts/create-session-storage-profile-fixture.ts <output-db-path>')

async function main(): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true })
  const db = openDatabase(path.resolve(outputPath))
  try {
    const conn = getDbConnection(db)
    const sessions = Array.from({ length: 144 }, (_, index) => createSession(db, { name: `Synthetic profile session ${index + 1}` }))
    const largeMessage = 'synthetic-message-body-'.repeat(2_260)
    let messageId = 0
    for (let index = 0; index < 335; index += 1) {
      const session = sessions[index % sessions.length]!
      messageId += 1
      conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
        VALUES(?,?,? ,?,'completed',1,?,?)`).run(
        `synthetic-message-${messageId}`, session.id, index % 2 === 0 ? 'user' : 'assistant', largeMessage,
        Date.now() + index, Math.floor(index / sessions.length)
      )
    }
    conn.prepare('UPDATE sessions SET message_count=(SELECT COUNT(*) FROM messages WHERE messages.session_id=sessions.id)')
      .run()

    const transcriptText = 'synthetic-transcript-snapshot-'.repeat(2_020)
    const insertTranscript = conn.prepare(`INSERT INTO session_transcript_entries
      (session_id,turn_id,base_version,version,outcome,messages_json,created_at) VALUES(?,?,?,?,'completed',?,?)`)
    for (let index = 0; index < 177; index += 1) {
      const version = Math.floor(index / sessions.length) + 1
      insertTranscript.run(sessions[index % sessions.length]!.id, `synthetic-transcript-turn-${index + 1}`, version - 1, version,
        JSON.stringify([{ role: 'assistant', content: transcriptText }]), Date.now() + index)
    }

    const contextText = 'synthetic-canonical-context-'.repeat(16_500)
    const responseText = 'synthetic-canonical-response-'.repeat(16_300)
    const streamCount = 182
    for (let index = 0; index < streamCount; index += 1) {
      const session = sessions[index % sessions.length]!
      const invocationId = `synthetic-invocation-${index + 1}`
      const turnId = `synthetic-turn-${index + 1}`
      const events: HistoryEvent[] = [
        { invocationId, turnId, sequence: 1, schemaVersion: 1, eventId: `${invocationId}-context`, idempotencyKey: `${invocationId}-context`, kind: 'invocation-context-committed', payload: {
          messages: [{ id: `${invocationId}-user`, role: 'user', content: contextText, timestamp: index * 2 }]
        } },
        { invocationId, turnId, sequence: 2, schemaVersion: 1, eventId: `${invocationId}-response`, idempotencyKey: `${invocationId}-response`, kind: 'model-response-committed', payload: {
          modelTurn: 1, message: { id: `${invocationId}-assistant`, role: 'assistant', content: responseText, timestamp: index * 2 + 1 }
        } },
        { invocationId, turnId, sequence: 3, schemaVersion: 1, eventId: `${invocationId}-terminal`, idempotencyKey: `${invocationId}-terminal`, kind: 'invocation-completed', payload: { status: 'completed' } }
      ]
      appendSqliteAgentHistoryBatchInTransaction(conn, events, 0, { sessionId: session.id })
    }

    db.flushSave()
    const summary = {
      fixture: 'synthetic-session-storage-profile-v1',
      containsUserData: false,
      schemaVersion: DB_SCHEMA_VERSION,
      sessions: sessions.length,
      messages: 335,
      transcriptSnapshots: 177,
      canonicalStreams: streamCount,
      canonicalEvents: streamCount * 3,
      outputPath: path.resolve(outputPath)
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  } finally {
    db.close()
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
