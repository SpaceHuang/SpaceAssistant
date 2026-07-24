import { logAgentEvent } from '../agentLogger/agentLogger'
import type { AppDatabase } from './index'
import { SCHEMA_META_KEYS } from './schema'
import { getDbConnection, getSchemaMeta, runInTransaction, setSchemaMeta } from './sqliteStore'

const WORKSPACE_LAYOUT_CONFIG_KEY = 'config.workspaceLayout'
const WRITE_DIR_CHOICE_KEY = 'writeDirChoice'

export type LegacyWorkspaceLayoutCleanupResult =
  | { ok: true; skipped: true }
  | { ok: true; skipped?: false; scanned: number; strippedSessions: number; deletedConfig: boolean }
  | { ok: false; sessionId?: string; errorName: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSessionMetadata(raw: string, sessionId: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const err = new Error(`legacy_workspace_layout_cleanup_invalid_metadata:${sessionId}`)
    err.name = 'LegacyWorkspaceLayoutCleanupError'
    throw err
  }
  if (!isPlainObject(parsed)) {
    const err = new Error(`legacy_workspace_layout_cleanup_non_object_metadata:${sessionId}`)
    err.name = 'LegacyWorkspaceLayoutCleanupError'
    throw err
  }
  return parsed
}

/**
 * One-shot startup cleanup: DELETE ONLY writeDirChoice / config.workspaceLayout.
 * Never calls updateSession; never creates artifactDefaultDir; fail-closed on bad metadata.
 */
export function cleanupLegacyWorkspaceLayoutOnStartup(db: AppDatabase): LegacyWorkspaceLayoutCleanupResult {
  const conn = getDbConnection(db)
  if (getSchemaMeta(conn, SCHEMA_META_KEYS.legacyWorkspaceLayoutCleanedAt)) {
    return { ok: true, skipped: true }
  }

  try {
    const summary = runInTransaction(db, () => {
      if (getSchemaMeta(conn, SCHEMA_META_KEYS.legacyWorkspaceLayoutCleanedAt)) {
        return { skipped: true as const }
      }

      const rows = conn.prepare('SELECT id, metadata FROM sessions').all() as Array<{
        id: string
        metadata: string
      }>

      const updates: Array<{ id: string; metadata: string }> = []
      for (const row of rows) {
        const meta = parseSessionMetadata(row.metadata, row.id)
        if (!(WRITE_DIR_CHOICE_KEY in meta)) continue
        const next = { ...meta }
        delete next[WRITE_DIR_CHOICE_KEY]
        updates.push({ id: row.id, metadata: JSON.stringify(next) })
      }

      const deleteResult = conn.prepare('DELETE FROM configs WHERE key = ?').run(WORKSPACE_LAYOUT_CONFIG_KEY)
      const deletedConfig = deleteResult.changes > 0

      const updateStmt = conn.prepare('UPDATE sessions SET metadata = ? WHERE id = ?')
      for (const u of updates) {
        updateStmt.run(u.metadata, u.id)
      }

      for (const row of conn.prepare('SELECT id, metadata FROM sessions').all() as Array<{
        id: string
        metadata: string
      }>) {
        const meta = parseSessionMetadata(row.metadata, row.id)
        if (WRITE_DIR_CHOICE_KEY in meta) {
          const err = new Error(`legacy_workspace_layout_cleanup_remaining:${row.id}`)
          err.name = 'LegacyWorkspaceLayoutCleanupError'
          throw err
        }
      }

      setSchemaMeta(conn, SCHEMA_META_KEYS.legacyWorkspaceLayoutCleanedAt, new Date().toISOString())

      return {
        skipped: false as const,
        scanned: rows.length,
        strippedSessions: updates.length,
        deletedConfig
      }
    })

    if (summary.skipped) {
      return { ok: true, skipped: true }
    }

    db.save()
    logAgentEvent('info', 'startup.legacy_workspace_layout_cleanup', {
      scanned: summary.scanned,
      strippedSessions: summary.strippedSessions,
      deletedConfig: summary.deletedConfig
    })
    return {
      ok: true,
      scanned: summary.scanned,
      strippedSessions: summary.strippedSessions,
      deletedConfig: summary.deletedConfig
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const sessionIdMatch = /:([0-9a-f-]{36})$/i.exec(message)
    const sessionId = sessionIdMatch?.[1]
    logAgentEvent('error', 'startup.legacy_workspace_layout_cleanup_failed', {
      sessionId,
      errorName: err instanceof Error ? err.name : 'Error'
    })
    return {
      ok: false,
      sessionId,
      errorName: err instanceof Error ? err.name : 'Error'
    }
  }
}
