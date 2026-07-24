import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession, getSession, updateSession } from '../database'
import { getDbConnection } from '../database/sqliteStore'
import {
  resolveArtifactDefaultDir,
  sanitizeArtifactSessionMetadataOnSave
} from './legacyMigration'

function plantWriteDirChoice(db: ReturnType<typeof createMemoryAppDb>, sessionId: string): void {
  const meta = { ...getSession(db, sessionId)!.metadata, writeDirChoice: { dir: '/tmp/legacy', confirmedAt: 1 } }
  getDbConnection(db)
    .prepare('UPDATE sessions SET metadata = ? WHERE id = ?')
    .run(JSON.stringify(meta), sessionId)
}

describe('legacy artifact migration', () => {
  it('does not migrate writeDirChoice to artifactDefaultDir', () => {
    const metadata = {
      artifactManagementEnabled: true,
      writeDirChoice: { dir: '/tmp/legacy', confirmedAt: 1 }
    }
    expect(resolveArtifactDefaultDir(metadata)).toBeUndefined()
    const sanitized = sanitizeArtifactSessionMetadataOnSave(metadata)
    expect(sanitized.changed).toBe(true)
    expect(sanitized.metadata.writeDirChoice).toBeUndefined()
    expect(sanitized.metadata.artifactDefaultDir).toBeUndefined()
  })

  it('cleans writeDirChoice on next normal session save for artifact sessions', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, {
      name: 'artifact',
      artifactManagementEnabled: true,
      metadata: {}
    })
    plantWriteDirChoice(db, session.id)
    updateSession(db, session.id, {
      metadata: { ...(getSession(db, session.id)?.metadata ?? {}), previewNote: 'touch' }
    })
    const saved = getSession(db, session.id)!
    expect(saved.metadata.writeDirChoice).toBeUndefined()
    expect(saved.metadata.previewNote).toBe('touch')
  })

  it('strips writeDirChoice for non-artifact sessions on save', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, {
      name: 'legacy',
      artifactManagementEnabled: false,
      metadata: {}
    })
    plantWriteDirChoice(db, session.id)
    updateSession(db, session.id, {
      metadata: { ...(getSession(db, session.id)?.metadata ?? {}), previewNote: 'touch' }
    })
    const saved = getSession(db, session.id)!
    expect(saved.metadata.writeDirChoice).toBeUndefined()
    expect(saved.metadata.previewNote).toBe('touch')
    expect(saved.metadata.artifactDefaultDir).toBeUndefined()
  })
})
