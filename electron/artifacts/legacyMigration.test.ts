import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession, getSession, updateSession } from '../database'
import {
  resolveArtifactDefaultDir,
  sanitizeArtifactSessionMetadataOnSave,
  shouldApplyLegacyWorkspaceLayout
} from './legacyMigration'
import { applyWorkspaceLayoutRedirect } from '../workspaceLayout/redirect'
import { shouldUseLegacyWorkspaceRedirect } from './featureFlag'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'

describe('legacy artifact migration', () => {
  it('does not apply workspace layout redirect semantics when artifact management is enabled', () => {
    const metadata = { artifactManagementEnabled: true }
    expect(shouldApplyLegacyWorkspaceLayout(metadata, true)).toBe(false)
    expect(shouldUseLegacyWorkspaceRedirect(metadata)).toBe(false)
  })

  it('still allows legacy redirect when artifact management is disabled', () => {
    const metadata = { artifactManagementEnabled: false }
    expect(shouldApplyLegacyWorkspaceLayout(metadata, true)).toBe(true)
    expect(shouldUseLegacyWorkspaceRedirect(metadata)).toBe(true)
  })

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
      metadata: { writeDirChoice: { dir: '/tmp/legacy', confirmedAt: 1 } }
    })
    updateSession(db, session.id, {
      metadata: { ...(getSession(db, session.id)?.metadata ?? {}), previewNote: 'touch' }
    })
    const saved = getSession(db, session.id)!
    expect(saved.metadata.writeDirChoice).toBeUndefined()
    expect(saved.metadata.previewNote).toBe('touch')
  })

  it('keeps writeDirChoice for legacy sessions on save', () => {
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
    expect(saved.metadata.writeDirChoice).toEqual({ dir: '/tmp/legacy', confirmedAt: 1 })
  })

  it('reading workspaceLayout config does not redirect when artifact flag is on', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-mig-'))
    try {
      const inputObj: Record<string, unknown> = { path: 'foo.py', content: 'x' }
      const out = await applyWorkspaceLayoutRedirect({
        toolName: 'write_file',
        input: inputObj,
        workDir: tmp,
        sessionId: 's1',
        workspaceLayout: {
          enabled: true,
          writeDirConfirmEnabled: false,
          extensionSubdirMap: [{ extension: 'py', subdir: 'Script' }]
        },
        writeDirChoice: { dir: tmp }
      })
      expect(out.redirected).toBe(true)
      expect(shouldApplyLegacyWorkspaceLayout({ artifactManagementEnabled: true }, true)).toBe(false)
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })
})
