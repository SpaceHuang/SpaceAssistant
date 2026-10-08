import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { readCanonicalSpillReferences } from '../storage/spillStore'

type TableMetric = { rows: number; textBytes: number }

function scanSpillDirectory(root: string): { files: Array<{ locator: string; bytes: number }>; complete: boolean; errorCodes: string[] } {
  try {
    const rootStat = fs.lstatSync(root)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { files: [], complete: false, errorCodes: ['SPILL_ROOT_NOT_DIRECTORY'] }
    const files: Array<{ locator: string; bytes: number }> = []
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.name.endsWith('.spill')) continue
      const filePath = path.join(root, entry.name)
      const stat = fs.lstatSync(filePath)
      if (stat.isSymbolicLink() || !stat.isFile()) return { files, complete: false, errorCodes: ['SPILL_ENTRY_NOT_REGULAR_FILE'] }
      files.push({ locator: entry.name, bytes: stat.size })
    }
    return { files, complete: true, errorCodes: [] }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : ''
    if (code === 'ENOENT') return { files: [], complete: true, errorCodes: [] }
    const errorCode = error instanceof Error ? error.name : 'UNKNOWN_ERROR'
    return { files: [], complete: false, errorCodes: [code || errorCode] }
  }
}

/** Collects storage sizes and canonical coverage by inspecting content in memory, without returning bodies or writing to the DB. */
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
  let snapshotOpen = false
  try {
    conn.exec('BEGIN DEFERRED')
    snapshotOpen = true
    const tables = new Set((conn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(({ name }) => name))
    const metric = (table: string, expression: string): TableMetric | null => {
      if (!tables.has(table)) return null
      return conn.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(${expression}), 0) AS textBytes FROM ${table}`).get() as TableMetric
    }
    const dbstat = (() => {
      try {
        return conn.prepare('SELECT name, COUNT(*) AS pages, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC').all()
      } catch { return null }
    })()
    const schemaVersion = tables.has('schema_meta')
      ? conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string } | undefined ?? null
      : null
    const sqliteVersion = (conn.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version
    const spillFiles = (() => {
      const spillRoot = path.join(path.dirname(dbPath), 'spill')
      const scan = scanSpillDirectory(spillRoot)
      let references: ReturnType<typeof readCanonicalSpillReferences> | undefined
      try {
        const indexTables = tables.has('spill_reference_backfill_state') && tables.has('spill_reference_meta') && tables.has('spill_reference_index')
        let trusted = false
        if (indexTables) {
          try {
            const state = conn.prepare(`SELECT owner_table,status,protocol_version,verified_generation FROM spill_reference_backfill_state
              WHERE owner_table IN ('agent_history_events','session_transcript_entries') ORDER BY owner_table`).all() as Array<{
              owner_table: string; status: string; protocol_version: number; verified_generation: number | null
            }>
            const generation = conn.prepare("SELECT meta_value FROM spill_reference_meta WHERE meta_key='canonical_change_generation'").get() as { meta_value: number } | undefined
            if (state.length === 2 && state.every((item) => item.status === 'complete' && item.protocol_version === 1 &&
              generation && item.verified_generation === generation.meta_value)) {
              const rows = conn.prepare(`SELECT locator,kind FROM spill_reference_index
                ORDER BY owner_table,owner_key,descriptor_path`).all() as Array<{ locator: string; kind: 'source-of-truth' | 'degradable' }>
              const descriptors = rows.map(({ locator, kind }) => ({ locator, kind } as ReturnType<typeof readCanonicalSpillReferences>['descriptors'][number]))
              references = { descriptors, referencedLocators: new Set(rows.map(({ locator }) => locator)), stats: {
                eventHistoryRows: 0, transcriptRows: 0, payloadBytes: 0, descriptorCount: descriptors.length,
                uniqueLocatorCount: new Set(rows.map(({ locator }) => locator)).size,
                eventHistoryDurationMs: 0, transcriptDurationMs: 0, durationMs: 0
              } }
              trusted = true
            }
          } catch { /* A failed or malformed index read falls back to the strict canonical scan. */ }
        }
        if (!trusted) references = readCanonicalSpillReferences(conn, { allowMissingTables: true })
      } catch { /* Report unknown reference classes below; do not turn an unreadable source into zero bytes. */ }
      const kindByLocator = new Map(references?.descriptors.map(({ locator, kind }) => [locator, kind]) ?? [])
      const files = scan.files.map(({ locator, bytes }) => ({ locator, bytes, kind: kindByLocator.get(locator) ?? 'orphan' }))
      const referenceScanComplete = references !== undefined
      return {
        root: spillRoot,
        files: files.length,
        observedBytes: files.reduce((sum, file) => sum + file.bytes, 0),
        totalBytes: scan.complete ? files.reduce((sum, file) => sum + file.bytes, 0) : null,
        sourceOfTruthBytes: referenceScanComplete ? files.filter(({ kind }) => kind === 'source-of-truth').reduce((sum, file) => sum + file.bytes, 0) : null,
        degradableBytes: referenceScanComplete ? files.filter(({ kind }) => kind === 'degradable').reduce((sum, file) => sum + file.bytes, 0) : null,
        orphanBytes: referenceScanComplete ? files.filter(({ kind }) => kind === 'orphan').reduce((sum, file) => sum + file.bytes, 0) : null,
        complete: scan.complete && referenceScanComplete,
        errorCodes: [...scan.errorCodes, ...(!referenceScanComplete ? ['CANONICAL_SPILL_REFERENCE_SCAN_FAILED'] : [])]
      }
    })()
    const sourceTruthGc = (() => {
      const root = path.join(path.dirname(dbPath), 'spill')
      try {
        const pending = tables.has('source_truth_spill_gc_queue')
          ? conn.prepare("SELECT locator,session_id FROM source_truth_spill_gc_queue WHERE status='pending'").all() as Array<{ locator: string; session_id: string }>
          : []
        const scan = tables.has('source_truth_spill_gc_scan_state')
          ? conn.prepare("SELECT status,after_name,attempts,last_error FROM source_truth_spill_gc_scan_state WHERE root_key='user-data-spill'").get() as
            { status: string; after_name: string | null; attempts: number; last_error: string | null } | undefined
          : undefined
        let pendingBytes = 0
        let orphanBytes = 0
        for (const item of pending) {
          try {
            const stat = fs.lstatSync(path.join(root, item.locator))
            if (!stat.isFile() || stat.isSymbolicLink()) continue
            pendingBytes += stat.size
            if (!item.session_id) orphanBytes += stat.size
          } catch { /* absent pending files are idempotent work and carry no bytes */ }
        }
        return { pendingFiles: pending.length, pendingBytes, orphanBytes,
          scanStatus: scan?.status ?? 'unavailable', scanCursor: scan?.after_name ?? null,
          attempts: scan?.attempts ?? 0, lastError: scan?.last_error ?? null }
      } catch {
        return { pendingFiles: 0, pendingBytes: 0, orphanBytes: 0, scanStatus: 'unavailable', scanCursor: null, attempts: 0, lastError: 'profile-unavailable' }
      }
    })()
    const spillDegraded = (() => {
      const root = path.join(path.dirname(dbPath), 'spill-degraded')
      const scan = scanSpillDirectory(root)
      const observedBytes = scan.files.reduce((sum, item) => sum + item.bytes, 0)
      return { root, files: scan.files.length, observedBytes, totalBytes: scan.complete ? observedBytes : null,
        complete: scan.complete, errorCodes: scan.errorCodes }
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
    const canonicalRequiredData = (() => {
      const eventPayload = tables.has('agent_history_events')
        ? conn.prepare('SELECT COUNT(*) AS rows, COALESCE(SUM(length(payload_json)),0) AS payloadBytes FROM agent_history_events').get()
        : { rows: 0, payloadBytes: 0 }
      const streamRows = tables.has('agent_history_streams')
        ? conn.prepare('SELECT COUNT(*) AS rows FROM agent_history_streams').get() as { rows: number }
        : { rows: 0 }
      const pages = Array.isArray(dbstat) ? dbstat as Array<{ name: string; bytes: number }> : []
      const streamTableBytes = pages.find(({ name }) => name === 'agent_history_streams')?.bytes ?? null
      return { eventRows: Number((eventPayload as { rows: number }).rows), eventPayloadBytes: Number((eventPayload as { payloadBytes: number }).payloadBytes),
        streamRows: streamRows.rows, streamTableBytes }
    })()
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
          let identityBodyCandidateBytes = 0
          const byRole: Record<string, { messages: number; bodyMatched: number }> = {}
          const identityBodyCandidatesByRole: Record<string, { messages: number; candidateMatches: number; candidateContentBytes: number }> = {}
          const rows = conn.prepare('SELECT id, session_id, role, content FROM messages').iterate() as Iterable<{ id: string; session_id: string; role: string; content: string }>
          for (const row of rows) {
            messages += 1
            const roleCoverage = byRole[row.role] ??= { messages: 0, bodyMatched: 0 }
            roleCoverage.messages += 1
            const roleIdentityCoverage = identityBodyCandidatesByRole[row.role] ??= { messages: 0, candidateMatches: 0, candidateContentBytes: 0 }
            roleIdentityCoverage.messages += 1
            if (canonicalBodies.has(createHash('sha256').update(row.role).update('\0').update(row.content).digest('hex'))) {
              bodyMatched += 1
              roleCoverage.bodyMatched += 1
            }
            if (canonicalIdentities.has(identityDigest(row.session_id, row.id, row.role, row.content))) {
              identityBodyCandidateCount += 1
              const contentBytes = Buffer.byteLength(row.content, 'utf8')
              identityBodyCandidateBytes += contentBytes
              roleIdentityCoverage.candidateMatches += 1
              roleIdentityCoverage.candidateContentBytes += contentBytes
            }
          }
          return { messages, bodyMatched, byRole, identityBodyCandidateCount, identityBodyCandidateBytes, identityBodyCandidatesByRole, canonicalIdentityCount: canonicalIdentities.size, canonicalUniqueBodies: canonicalBodies.size, malformedPayloads }
        })()
      : null
    const profile = {
      collectedAt: new Date().toISOString(),
      runtime: { platform: process.platform, arch: process.arch, osRelease: os.release(), nodeVersion: process.versions.node, sqliteVersion },
      schemaVersion: schemaVersion ? Number(schemaVersion.value) : null,
      dbBytes: file.size,
      databaseFiles,
      spillDegraded,
      totalBytes: spillFiles.complete && spillDegraded.complete
        ? databaseFiles.totalBytes + Number((spillFiles as { totalBytes: number }).totalBytes) + Number(spillDegraded.totalBytes)
        : null,
      pageSize: conn.prepare('PRAGMA page_size').get(),
      pageCount: conn.prepare('PRAGMA page_count').get(),
      freelistCount: conn.prepare('PRAGMA freelist_count').get(),
      autoVacuum: conn.prepare('PRAGMA auto_vacuum').get(),
      dbstat,
      spillFiles,
      sourceTruthGc,
      tables: {
        messages: metric('messages', "length(content)+length(COALESCE(tool_calls,''))+length(COALESCE(thinking,''))+length(COALESCE(attachments,''))+length(COALESCE(content_segments,''))"),
        canonicalHistory: metric('agent_history_events', 'length(payload_json)'),
        transcriptSnapshots: metric('session_transcript_entries', 'length(messages_json)')
      },
      canonicalCoverage,
      canonicalSessionCoverage,
      canonicalRequiredData,
      messageBodyCoverage
    }
    conn.exec('COMMIT')
    snapshotOpen = false
    return profile
  } finally {
    if (snapshotOpen) { try { conn.exec('ROLLBACK') } catch { /* connection close will discard a failed snapshot */ } }
    conn.close()
  }
}
