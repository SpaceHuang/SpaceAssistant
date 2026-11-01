import { parentPort, threadId } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { summarizeContextHistoryRows, type ContextHistorySummarySourceRow } from './contextHistorySummaryWorker'
import type { ContextHistorySummaryEntry } from '../../public/model'

if (!parentPort) throw new Error('context history summary worker requires a parent port')

type Request = Readonly<{ requestId: string; rows: readonly ContextHistorySummarySourceRow[] } | {
  requestId: string; dbPath: string; sessionId: string; expectedGeneration: string; expectedMessageRevision: number
}>
type Response = Readonly<{ requestId: string; entries?: readonly ContextHistorySummaryEntry[]; workerThreadId?: number;
  generation?: string; messageRevision?: number; error?: string }>

parentPort.once('message', (request: Request) => {
  try {
    if (!request || typeof request.requestId !== 'string') throw new Error('CONTEXT_HISTORY_SUMMARY_REQUEST_INVALID')
    if ('rows' in request) {
      if (!Array.isArray(request.rows)) throw new Error('CONTEXT_HISTORY_SUMMARY_REQUEST_INVALID')
      const entries = summarizeContextHistoryRows(request.rows)
      parentPort!.postMessage({ requestId: request.requestId, entries, workerThreadId: threadId } satisfies Response)
      return
    }
    if (typeof request.dbPath !== 'string' || !path.isAbsolute(request.dbPath) || request.dbPath === ':memory:' ||
      typeof request.sessionId !== 'string' || !request.sessionId || typeof request.expectedGeneration !== 'string' ||
      !Number.isSafeInteger(request.expectedMessageRevision)) throw new Error('CONTEXT_HISTORY_SUMMARY_DATABASE_REQUEST_INVALID')
    const db = new DatabaseSync(request.dbPath, { readOnly: true, timeout: 5000 })
    try {
      db.exec('BEGIN')
      const snapshot = db.prepare(`SELECT sessions.generation AS generation,cutover.message_revision AS messageRevision
        FROM sessions JOIN session_message_content_cutover cutover ON cutover.session_id=sessions.id WHERE sessions.id=?`)
        .get(request.sessionId) as { generation: string; messageRevision: number } | undefined
      if (!snapshot || snapshot.generation !== request.expectedGeneration || snapshot.messageRevision !== request.expectedMessageRevision) {
        throw new Error('CONTEXT_HISTORY_SUMMARY_SOURCE_CHANGED')
      }
      const rows = db.prepare(`SELECT id,role,thinking,attachments,sequence FROM messages
        WHERE session_id=? ORDER BY sequence ASC`).all(request.sessionId) as ContextHistorySummarySourceRow[]
      const entries = summarizeContextHistoryRows(rows)
      db.exec('COMMIT')
      parentPort!.postMessage({ requestId: request.requestId, entries, workerThreadId: threadId,
        generation: snapshot.generation, messageRevision: snapshot.messageRevision } satisfies Response)
    } finally { db.close() }
  } catch (error) {
    parentPort!.postMessage({ requestId: request?.requestId, error: error instanceof Error ? error.message : 'CONTEXT_HISTORY_SUMMARY_WORKER_FAILED' } satisfies Response)
  } finally { parentPort!.close() }
})
