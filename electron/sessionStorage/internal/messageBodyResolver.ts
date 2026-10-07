import type { Message } from '../../../src/shared/domainTypes'
import type { AppDatabase } from '../../database/sqliteStore'
import { getDbConnection } from '../../database/sqliteStore'

export type ResolvedTranscriptSnapshot = Readonly<{
  source: string
  messages: readonly Message[]
}>

/** Resolves selected message skeletons without changing selector order or loading a session twice. */
export function resolveSelectedMessageBodies(
  db: AppDatabase,
  selected: readonly Message[],
  readTranscript: (sessionId: string) => ResolvedTranscriptSnapshot
): Message[] {
  if (selected.length === 0) return []
  const conn = getDbConnection(db)
  // Lightweight adapter tests may provide selected DTOs without a SQLite connection.
  if (typeof conn.prepare !== 'function') return [...selected]
  const sessionIds = new Set(selected.map(({ sessionId }) => sessionId))
  if (sessionIds.size !== 1) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
  const sessionId = selected[0]!.sessionId
  const ids = selected.map(({ id }) => id)
  const states = conn.prepare(`SELECT messages.id,messages.content_storage_state,cutover.write_mode
    FROM messages LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=messages.session_id
    WHERE messages.session_id=? AND messages.id IN (${ids.map(() => '?').join(',')})`)
    .all(sessionId, ...ids) as Array<{ id: string; content_storage_state: string; write_mode: string | null }>
  const stateById = new Map(states.map((row) => [row.id, row]))
  for (const message of selected) {
    const state = stateById.get(message.id)
    if (!state || (state.content_storage_state !== 'legacy' &&
      !['canonical-backed-dual-write', 'canonical-backed-only'].includes(state.content_storage_state))) {
      throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    }
    if (state.content_storage_state !== 'legacy' && state.write_mode !== 'canonical') {
      throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    }
  }
  const backedIds = new Set(states.filter((row) => row.content_storage_state !== 'legacy').map(({ id }) => id))
  if (backedIds.size === 0) return [...selected]
  const transcript = readTranscript(sessionId)
  if (transcript.source === 'legacy') throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
  const canonicalById = new Map(transcript.messages.map((message) => [message.id, message]))
  return selected.map((message) => {
    if (!backedIds.has(message.id)) return message
    const resolved = canonicalById.get(message.id)
    if (!resolved) throw new Error('CANONICAL_SESSION_CONTENT_UNAVAILABLE')
    return resolved
  })
}
