import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSession, openDatabase } from './database'
import { createWorkDirManager } from './workDirManager'
import {
  SENSITIVE_WORKDIR_ERROR,
  bindSessionWorkDir,
  matchWorkDirProfile,
  normalizeWorkDirHint
} from './workDirBinding'
import type { RemoteContext } from './tools/types'
import {
  resetRunningRemoteAgentRegistryForTests,
  tryClaimRemoteSession,
  releaseRemoteSession
} from './remote/remoteAgentRegistry'
import { REMOTE_WORKDIR_SWITCH_BUSY_MESSAGE } from './remote/remoteSessionGuardMessages'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-wdb-'))
}

describe('workDirBinding', () => {
  const dirs: string[] = []
  const openDbs: Array<{ close: () => void }> = []

  afterEach(() => {
    resetRunningRemoteAgentRegistryForTests()
    for (const db of openDbs.splice(0)) {
      db.close()
    }
    for (const d of dirs) {
      fs.rmSync(d, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  function setup() {
    const dbPath = path.join(tempDir(), 'db.db')
    dirs.push(path.dirname(dbPath))
    const db = openDatabase(dbPath)
    openDbs.push(db)
    let workDir = '/default'
    const manager = createWorkDirManager({
      db,
      getWorkDir: () => workDir,
      setWorkDir: (d) => {
        workDir = d
      }
    })
    return { db, manager }
  }

  describe('normalizeWorkDirHint', () => {
    it('trims and lowercases', () => {
      expect(normalizeWorkDirHint('  ProjectA  ')).toBe('projecta')
    })
  })

  describe('matchWorkDirProfile', () => {
    const profiles = [
      { id: 'p1', name: 'Project Alpha', path: '/a', aliases: ['alpha'] },
      { id: 'p2', name: 'Project Beta', path: '/b', aliases: ['beta'] },
      { id: 'p3', name: 'Alpha Test', path: '/c' }
    ]

    it('matches by profile_id', () => {
      const result = matchWorkDirProfile({ profile_id: 'p2' }, profiles)
      expect(result.matches).toHaveLength(1)
      expect(result.matches[0]?.id).toBe('p2')
    })

    it('matches by exact name case-insensitive', () => {
      const result = matchWorkDirProfile({ name: 'project alpha' }, profiles)
      expect(result.matches).toHaveLength(1)
      expect(result.matches[0]?.id).toBe('p1')
    })

    it('matches by alias', () => {
      const result = matchWorkDirProfile({ alias: 'BETA' }, profiles)
      expect(result.matches).toHaveLength(1)
      expect(result.matches[0]?.id).toBe('p2')
    })

    it('returns ambiguous fuzzy name matches', () => {
      const result = matchWorkDirProfile({ name: 'alpha' }, profiles)
      expect(result.matches.length).toBeGreaterThan(1)
    })

    it('returns error when no params', () => {
      const result = matchWorkDirProfile({}, profiles)
      expect(result.error).toBeTruthy()
      expect(result.matches).toHaveLength(0)
    })
  })

  describe('bindSessionWorkDir', () => {
    const feishuRemoteContext: RemoteContext = {
      source: 'feishu',
      messageId: 'msg-1',
      confirmPolicy: 'always'
    }

    it('binds profile and writes audit when changed', async () => {
      const dirA = tempDir()
      dirs.push(dirA)
      const { db, manager } = setup()
      const added = manager.addProfile({ name: 'A', path: dirA })
      const session = createSession(db, { name: 'S1' })
      const appendAudit = vi.fn()

      const result = await bindSessionWorkDir(db, manager, {
        sessionId: session.id,
        profileId: added.profile!.id,
        remoteContext: feishuRemoteContext,
        source: 'tool',
        appendAudit
      })

      expect(result.success).toBe(true)
      expect(result.changed).toBe(true)
      expect(appendAudit).toHaveBeenCalledWith(added.profile!.id, 'A')
    })

    it('skips audit when binding unchanged', async () => {
      const dirA = tempDir()
      dirs.push(dirA)
      const { db, manager } = setup()
      const added = manager.addProfile({ name: 'A', path: dirA })
      const session = createSession(db, { name: 'S1', workDirProfileId: added.profile!.id })
      const appendAudit = vi.fn()

      const result = await bindSessionWorkDir(db, manager, {
        sessionId: session.id,
        profileId: added.profile!.id,
        remoteContext: feishuRemoteContext,
        source: 'inbound',
        appendAudit
      })

      expect(result.success).toBe(true)
      expect(result.changed).toBe(false)
      expect(appendAudit).not.toHaveBeenCalled()
    })

    it('rejects sensitive profile', async () => {
      const dirA = tempDir()
      dirs.push(dirA)
      const { db, manager } = setup()
      const added = manager.addProfile({ name: 'Secret', path: dirA, sensitive: true })
      const session = createSession(db, { name: 'S1' })

      const result = await bindSessionWorkDir(db, manager, {
        sessionId: session.id,
        profileId: added.profile!.id,
        remoteContext: feishuRemoteContext,
        source: 'tool'
      })

      expect(result.success).toBe(false)
      expect(result.error).toBe(SENSITIVE_WORKDIR_ERROR)
    })

    it('rejects non-writable directory', async () => {
      if (process.platform === 'win32') {
        return
      }
      const { db, manager } = setup()
      const added = manager.addProfile({ name: 'Bad', path: path.join(tempDir(), 'missing-nested', 'deep') })
      dirs.push(path.dirname(added.profile!.path))
      const session = createSession(db, { name: 'S1' })

      const readOnlyParent = tempDir()
      dirs.push(readOnlyParent)
      const readOnlyDir = path.join(readOnlyParent, 'ro')
      fs.mkdirSync(readOnlyDir)
      manager.updateProfile(added.profile!.id, { path: readOnlyDir })
      fs.chmodSync(readOnlyDir, 0o444)

      const result = await bindSessionWorkDir(db, manager, {
        sessionId: session.id,
        profileId: added.profile!.id,
        remoteContext: feishuRemoteContext,
        source: 'tool'
      })

      fs.chmodSync(readOnlyDir, 0o755)
      expect(result.success).toBe(false)
      expect(result.error).toContain('无法写入该目录')
    })

    it('rejects tool bind when session is busy and profile changes', async () => {
      const dirA = tempDir()
      const dirB = tempDir()
      dirs.push(dirA, dirB)
      const { db, manager } = setup()
      const a = manager.addProfile({ name: 'A', path: dirA })
      const b = manager.addProfile({ name: 'B', path: dirB })
      const session = createSession(db, { name: 'S1', workDirProfileId: a.profile!.id })

      tryClaimRemoteSession(session.id, 3)
      const result = await bindSessionWorkDir(db, manager, {
        sessionId: session.id,
        profileId: b.profile!.id,
        remoteContext: feishuRemoteContext,
        source: 'tool'
      })
      releaseRemoteSession(session.id)

      expect(result.success).toBe(false)
      expect(result.error).toBe(REMOTE_WORKDIR_SWITCH_BUSY_MESSAGE)
    })

    it('allows inbound bind while session is claimed', async () => {
      const dirA = tempDir()
      const dirB = tempDir()
      dirs.push(dirA, dirB)
      const { db, manager } = setup()
      const a = manager.addProfile({ name: 'A', path: dirA })
      const b = manager.addProfile({ name: 'B', path: dirB })
      const session = createSession(db, { name: 'S1', workDirProfileId: a.profile!.id })

      tryClaimRemoteSession(session.id, 3)
      const result = await bindSessionWorkDir(db, manager, {
        sessionId: session.id,
        profileId: b.profile!.id,
        remoteContext: feishuRemoteContext,
        source: 'inbound'
      })
      releaseRemoteSession(session.id)

      expect(result.success).toBe(true)
      expect(result.changed).toBe(true)
    })
  })
})
