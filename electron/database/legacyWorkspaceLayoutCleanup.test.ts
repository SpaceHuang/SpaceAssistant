import { describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'
import { createMemoryAppDb } from './testHelpers'
import { createSession, getConfigValue, getSession, listSessions, setConfigValue, updateSession } from './operations'
import { getDbConnection, getSchemaMeta } from './sqliteStore'
import { SCHEMA_META_KEYS } from './schema'
import { cleanupLegacyWorkspaceLayoutOnStartup } from './legacyWorkspaceLayoutCleanup'
import {
  resolveArtifactDefaultDir,
  sanitizeArtifactSessionMetadataOnSave
} from '../artifacts/legacyMigration'

const WORKSPACE_LAYOUT_CONFIG_KEY = 'config.workspaceLayout'
const CLEANED_AT = SCHEMA_META_KEYS.legacyWorkspaceLayoutCleanedAt

function rawSessionSnapshot(db: ReturnType<typeof createMemoryAppDb>) {
  const conn = getDbConnection(db)
  return conn
    .prepare('SELECT id, metadata, updated_at FROM sessions ORDER BY id')
    .all() as Array<{ id: string; metadata: string; updated_at: number }>
}

describe('cleanupLegacyWorkspaceLayoutOnStartup', () => {
  it('strips writeDirChoice and config without changing updated_at or listSessions order', () => {
    const db = createMemoryAppDb()
    const older = createSession(db, {
      name: 'older',
      artifactManagementEnabled: false,
      metadata: {
        writeDirChoice: { dir: '/tmp/legacy', confirmedAt: 1 },
        keepMe: 'yes'
      }
    })
    const newer = createSession(db, {
      name: 'newer',
      artifactManagementEnabled: true,
      metadata: {
        writeDirChoice: { dir: '/tmp/other', confirmedAt: 2 },
        artifactDefaultDir: 'Docs'
      }
    })
    const clean = createSession(db, {
      name: 'clean',
      artifactManagementEnabled: false,
      metadata: { note: 'untouched' }
    })

    const conn = getDbConnection(db)
    conn.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(1000, older.id)
    conn.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(3000, newer.id)
    conn.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(2000, clean.id)

    setConfigValue(
      db,
      WORKSPACE_LAYOUT_CONFIG_KEY,
      JSON.stringify({ enabled: true, writeDirConfirmEnabled: true, extensionSubdirMap: [] })
    )

    const beforeOrder = listSessions(db).map((s) => s.id)
    expect(beforeOrder).toEqual([newer.id, clean.id, older.id])
    const beforeRows = rawSessionSnapshot(db)

    const result = cleanupLegacyWorkspaceLayoutOnStartup(db)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.scanned).toBe(3)
    expect(result.strippedSessions).toBe(2)
    expect(result.deletedConfig).toBe(true)

    expect(getConfigValue(db, WORKSPACE_LAYOUT_CONFIG_KEY)).toBeUndefined()
    expect(getSchemaMeta(conn, CLEANED_AT)).toBeTruthy()

    const afterRows = rawSessionSnapshot(db)
    expect(afterRows.map((r) => r.updated_at)).toEqual(beforeRows.map((r) => r.updated_at))
    expect(listSessions(db).map((s) => s.id)).toEqual(beforeOrder)

    const olderSaved = getSession(db, older.id)!
    expect(olderSaved.metadata.writeDirChoice).toBeUndefined()
    expect(olderSaved.metadata.keepMe).toBe('yes')
    expect(olderSaved.metadata.artifactDefaultDir).toBeUndefined()

    const newerSaved = getSession(db, newer.id)!
    expect(newerSaved.metadata.writeDirChoice).toBeUndefined()
    expect(newerSaved.metadata.artifactDefaultDir).toBe('Docs')

    const cleanSaved = getSession(db, clean.id)!
    expect(cleanSaved.metadata).toEqual({ note: 'untouched', artifactManagementEnabled: false })
  })

  it('is idempotent: writes marker when nothing to strip, second run is a no-op', () => {
    const db = createMemoryAppDb()
    createSession(db, { name: 'plain', metadata: { ok: true } })
    const first = cleanupLegacyWorkspaceLayoutOnStartup(db)
    expect(first.ok).toBe(true)
    const marker = getSchemaMeta(getDbConnection(db), CLEANED_AT)
    expect(marker).toBeTruthy()

    const second = cleanupLegacyWorkspaceLayoutOnStartup(db)
    expect(second).toEqual({ ok: true, skipped: true })
    expect(getSchemaMeta(getDbConnection(db), CLEANED_AT)).toBe(marker)
  })

  it('fail-closed: bad metadata rolls back config/session/marker; retry succeeds after fix', () => {
    const db = createMemoryAppDb()
    const good = createSession(db, {
      name: 'good',
      metadata: { writeDirChoice: { dir: '/tmp/x', confirmedAt: 1 }, keep: 1 }
    })
    setConfigValue(
      db,
      WORKSPACE_LAYOUT_CONFIG_KEY,
      JSON.stringify({ enabled: true, writeDirConfirmEnabled: false, extensionSubdirMap: [] })
    )

    const badId = randomUUID()
    const now = Date.now()
    getDbConnection(db)
      .prepare(
        `INSERT INTO sessions (
          id, name, preview, model, llm_service_id, temperature, max_tokens,
          created_at, updated_at, message_count, skills_state, metadata, schema_version, work_dir_profile_id
        ) VALUES (?, ?, '', 'm', NULL, 0.7, 4096, ?, ?, 0, '{}', ?, 1, NULL)`
      )
      .run(badId, 'bad', now, now + 1, '{not-json')

    const before = {
      config: getConfigValue(db, WORKSPACE_LAYOUT_CONFIG_KEY),
      rows: rawSessionSnapshot(db),
      marker: getSchemaMeta(getDbConnection(db), CLEANED_AT)
    }

    const failed = cleanupLegacyWorkspaceLayoutOnStartup(db)
    expect(failed.ok).toBe(false)
    if (failed.ok) return
    expect(failed.sessionId).toBe(badId)

    expect(getConfigValue(db, WORKSPACE_LAYOUT_CONFIG_KEY)).toBe(before.config)
    expect(rawSessionSnapshot(db)).toEqual(before.rows)
    expect(getSchemaMeta(getDbConnection(db), CLEANED_AT)).toBe(before.marker)

    getDbConnection(db)
      .prepare('UPDATE sessions SET metadata = ? WHERE id = ?')
      .run(JSON.stringify({ fixed: true }), badId)

    const ok = cleanupLegacyWorkspaceLayoutOnStartup(db)
    expect(ok.ok).toBe(true)
    expect(getConfigValue(db, WORKSPACE_LAYOUT_CONFIG_KEY)).toBeUndefined()
    expect(getSession(db, good.id)!.metadata.writeDirChoice).toBeUndefined()
    expect(getSession(db, good.id)!.metadata.keep).toBe(1)
    expect(getSchemaMeta(getDbConnection(db), CLEANED_AT)).toBeTruthy()
  })
})

describe('sanitizeArtifactSessionMetadataOnSave (all sessions)', () => {
  it('strips writeDirChoice for non-artifact sessions without creating artifactDefaultDir', () => {
    const metadata = {
      artifactManagementEnabled: false,
      writeDirChoice: { dir: '/tmp/legacy', confirmedAt: 1 },
      keep: true
    }
    const sanitized = sanitizeArtifactSessionMetadataOnSave(metadata)
    expect(sanitized.changed).toBe(true)
    expect(sanitized.metadata.writeDirChoice).toBeUndefined()
    expect(sanitized.metadata.keep).toBe(true)
    expect(resolveArtifactDefaultDir(sanitized.metadata)).toBeUndefined()
  })

  it('strips writeDirChoice on save for legacy sessions via updateSession', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, {
      name: 'legacy',
      artifactManagementEnabled: false,
      metadata: { writeDirChoice: { dir: '/tmp/legacy', confirmedAt: 1 } }
    })
    updateSession(db, session.id, {
      metadata: { ...(getSession(db, session.id)?.metadata ?? {}), previewNote: 'touch' }
    })
    const saved = getSession(db, session.id)!
    expect(saved.metadata.writeDirChoice).toBeUndefined()
    expect(saved.metadata.previewNote).toBe('touch')
    expect(saved.metadata.artifactDefaultDir).toBeUndefined()
  })
})
