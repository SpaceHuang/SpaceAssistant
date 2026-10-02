import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { readCanonicalSpillReferences } from '../storage/spillStore'

type TableMetric = { rows: number; textBytes: number }

/** Collects storage sizes and canonical coverage counts without reading message bodies or writing to the DB. */
export function collectSessionStorageProfile(dbPath: string): Record<string, unknown> {
  const file = fs.statSync(dbPath)
  const databaseFiles = (() => {
    const walPath = `${dbPath}-wal`
    const shmPath = `${dbPath}-shm`
    const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0
    const shmBytes = fs.existsSync(shmPath) ? fs.statSync(shmPath).size : 0
    return { dbBytes: file.size, walBytes, shmBytes, totalBytes: file.size + walBytes + shmBytes }
  })()
  const conn = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const tables = new Set((conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(({ name }) => name))
    const metric = (table: string, expression: string): TableMetric | null => {
      if (!tables.has(table)) return null
      return conn.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(${expression}), 0) AS textBytes FROM ${table}`).get() as TableMetric
    }
    const dbstat = (() => {
      try {
        return conn.prepare('SELECT name, COUNT(*) AS pages, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 30').all()
      } catch { return null }
    })()
    const spillFiles = (() => {
      try {
        const spillRoot = path.join(path.dirname(dbPath), 'spill')
        const references = readCanonicalSpillReferences(conn)
        const kindByLocator = new Map(references.descriptors.map(({ locator, kind }) => [locator, kind]))
        const files = fs.readdirSync(spillRoot).filter((name) => name.endsWith('.spill')).map((name) => {
          const bytes = fs.statSync(path.join(spillRoot, name)).size
          const kind = kindByLocator.get(name)
          return { locator: name, bytes, kind: kind ?? 'orphan' }
        })
        return {
          root: spillRoot,
          files: files.length,
          totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
          sourceOfTruthBytes: files.filter(({ kind }) => kind === 'source-of-truth').reduce((sum, file) => sum + file.bytes, 0),
          degradableBytes: files.filter(({ kind }) => kind === 'degradable').reduce((sum, file) => sum + file.bytes, 0),
          orphanBytes: files.filter(({ kind }) => kind === 'orphan').reduce((sum, file) => sum + file.bytes, 0)
        }
      } catch {
        return { root: path.join(path.dirname(dbPath), 'spill'), files: 0, totalBytes: 0, sourceOfTruthBytes: 0, degradableBytes: 0, orphanBytes: 0 }
      }
    })()
    const spillDegraded = (() => {
      const root = path.join(path.dirname(dbPath), 'spill-degraded')
      try {
        const files = fs.readdirSync(root).filter((name) => name.endsWith('.spill')).map((name) => ({ locator: name, bytes: fs.statSync(path.join(root, name)).size }))
        return { root, files: files.length, totalBytes: files.reduce((sum, item) => sum + item.bytes, 0) }
      } catch { return { root, files: 0, totalBytes: 0 } }
    })()
    const canonicalCoverage = tables.has('agent_history_streams') && tables.has('agent_history_events')
      ? conn.prepare(`SELECT COUNT(*) AS streams,
          SUM(has_ctx) AS withContext, SUM(has_response) AS withResponse,
          SUM(has_ctx AND has_response) AS withBoth,
          SUM(has_input AND NOT has_ctx) AS fingerprintOnly,
          SUM(has_compacted AND NOT has_ctx) AS compactedWithoutContext
        FROM (SELECT s.invocation_id,
          MAX(e.kind='invocation-context-committed') AS has_ctx,
          MAX(e.kind='model-response-committed') AS has_response,
          MAX(e.kind='session-input-committed') AS has_input,
          MAX(e.kind='transcript-compacted') AS has_compacted
          FROM agent_history_streams s LEFT JOIN agent_history_events e ON e.invocation_id=s.invocation_id
          GROUP BY s.invocation_id)`).get()
      : null
    const canonicalSessionCoverage = tables.has('agent_history_streams') && tables.has('agent_history_events')
      ? conn.prepare(`SELECT COUNT(*) AS sessions,
          SUM(has_ctx) AS sessionsWithContext, SUM(has_response) AS sessionsWithResponse,
          SUM(has_ctx AND has_response) AS sessionsWithBoth,
          SUM(has_input AND NOT has_ctx) AS fingerprintOnlySessions,
          SUM(has_compacted AND NOT has_ctx) AS compactedWithoutContextSessions,
          (SELECT COUNT(*) FROM agent_history_streams WHERE session_id IS NULL) AS unownedStreams
        FROM (SELECT s.session_id,
          MAX(e.kind='invocation-context-committed') AS has_ctx,
          MAX(e.kind='model-response-committed') AS has_response,
          MAX(e.kind='session-input-committed') AS has_input,
          MAX(e.kind='transcript-compacted') AS has_compacted
          FROM agent_history_streams s LEFT JOIN agent_history_events e ON e.invocation_id=s.invocation_id
          WHERE s.session_id IS NOT NULL GROUP BY s.session_id)`).get()
      : null
    const canonicalBodies = new Set<string>()
    const canonicalIdentities = new Set<string>()
    const identityDigest = (sessionId: string, id: string, role: string, content: string) => createHash('sha256')
      .update(sessionId).update('\0').update(id).update('\0').update(role).update('\0').update(content).digest('hex')
    let malformedPayloads = 0
    if (tables.has('agent_history_events') && tables.has('messages')) {
      const digest = (role: string, content: string) => createHash('sha256').update(role).update('\0').update(content).digest('hex')
      const text = (content: unknown): string | undefined => {
        if (typeof content === 'string') return content
        if (!Array.isArray(content)) return undefined
        const parts = content.filter((part): part is { type: string; text: string } => Boolean(part) && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string')
        return parts.map(({ text: part }) => part).join('')
      }
      const events = conn.prepare(`SELECT e.kind, e.payload_json, s.session_id FROM agent_history_events e
        LEFT JOIN agent_history_streams s ON s.invocation_id=e.invocation_id
        WHERE e.kind IN ('invocation-context-committed','model-response-committed')`).iterate() as Iterable<{ kind: string; payload_json: string; session_id: string | null }>
      for (const row of events) {
        let payload: { messages?: unknown; message?: unknown }
        try { payload = JSON.parse(row.payload_json) }
        catch { malformedPayloads += 1; continue }
        const messages = row.kind === 'invocation-context-committed'
          ? (Array.isArray(payload.messages) ? payload.messages : [])
          : [payload.message]
        for (const candidate of messages) {
          if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
          const message = candidate as { id?: unknown; role?: unknown; content?: unknown }
          const body = text(message.content)
          if (typeof message.role === 'string' && body !== undefined) {
            canonicalBodies.add(digest(message.role, body))
            if (row.session_id && typeof message.id === 'string' && message.id.trim()) {
              canonicalIdentities.add(identityDigest(row.session_id, message.id, message.role, body))
            }
          }
        }
      }
    }
    const messageBodyCoverage = tables.has('messages')
      ? (() => {
          let messages = 0
          let bodyMatched = 0
          let identityBodyCandidateCount = 0
          const byRole: Record<string, { messages: number; bodyMatched: number }> = {}
          const identityBodyCandidatesByRole: Record<string, { messages: number; candidateMatches: number }> = {}
          const rows = conn.prepare('SELECT id, session_id, role, content FROM messages').iterate() as Iterable<{ id: string; session_id: string; role: string; content: string }>
          for (const row of rows) {
            messages += 1
            const roleCoverage = byRole[row.role] ??= { messages: 0, bodyMatched: 0 }
            roleCoverage.messages += 1
            const roleIdentityCoverage = identityBodyCandidatesByRole[row.role] ??= { messages: 0, candidateMatches: 0 }
            roleIdentityCoverage.messages += 1
            if (canonicalBodies.has(createHash('sha256').update(row.role).update('\0').update(row.content).digest('hex'))) {
              bodyMatched += 1
              roleCoverage.bodyMatched += 1
            }
            if (canonicalIdentities.has(identityDigest(row.session_id, row.id, row.role, row.content))) {
              identityBodyCandidateCount += 1
              roleIdentityCoverage.candidateMatches += 1
            }
          }
          return { messages, bodyMatched, byRole, identityBodyCandidateCount, identityBodyCandidatesByRole, canonicalIdentityCount: canonicalIdentities.size, canonicalUniqueBodies: canonicalBodies.size, malformedPayloads }
        })()
      : null
    return {
      dbBytes: file.size,
      databaseFiles,
      spillDegraded,
      totalBytes: databaseFiles.totalBytes + Number((spillFiles as { totalBytes: number }).totalBytes) + spillDegraded.totalBytes,
      pageSize: conn.prepare('PRAGMA page_size').get(),
      pageCount: conn.prepare('PRAGMA page_count').get(),
      freelistCount: conn.prepare('PRAGMA freelist_count').get(),
      autoVacuum: conn.prepare('PRAGMA auto_vacuum').get(),
      dbstat,
      spillFiles,
      tables: {
        messages: metric('messages', "length(content)+length(COALESCE(tool_calls,''))+length(COALESCE(thinking,''))+length(COALESCE(attachments,''))+length(COALESCE(content_segments,''))"),
        canonicalHistory: metric('agent_history_events', 'length(payload_json)'),
        transcriptSnapshots: metric('session_transcript_entries', 'length(messages_json)')
      },
      canonicalCoverage,
      canonicalSessionCoverage,
      messageBodyCoverage
    }
  } finally {
    conn.close()
  }
}
