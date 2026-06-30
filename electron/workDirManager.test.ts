import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './database'
import { createSession } from './database'
import { createWorkDirManager, resolveWorkDirForSession } from './workDirManager'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-workdir-'))
}

describe('WorkDirManager', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const d of dirs) {
      fs.rmSync(d, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  function setupManager() {
    const dbPath = path.join(tempDir(), 'db.json')
    dirs.push(path.dirname(dbPath))
    const db = openDatabase(dbPath)
    let workDir = '/default'
    const manager = createWorkDirManager({
      db,
      getWorkDir: () => workDir,
      setWorkDir: (d) => {
        workDir = d
      }
    })
    return { db, manager, getWorkDir: () => workDir }
  }

  describe('addProfile', () => {
    it('第一个添加的目录自动设为默认', () => {
      const dirA = tempDir()
      dirs.push(dirA)
      const { manager } = setupManager()
      const result = manager.addProfile({ name: 'Project A', path: dirA })
      expect(result.success).toBe(true)
      expect(manager.listProfiles()[0]?.isDefault).toBe(true)
    })

    it('第二个添加的目录不自动设为默认', () => {
      const dirA = tempDir()
      const dirB = tempDir()
      dirs.push(dirA, dirB)
      const { manager } = setupManager()
      manager.addProfile({ name: 'Project A', path: dirA })
      manager.addProfile({ name: 'Project B', path: dirB })
      const defaults = manager.listProfiles().filter((p) => p.isDefault)
      expect(defaults).toHaveLength(1)
      expect(defaults[0]?.name).toBe('Project A')
    })

    it('拒绝重复名称', () => {
      const dirA = tempDir()
      const dirB = tempDir()
      dirs.push(dirA, dirB)
      const { manager } = setupManager()
      manager.addProfile({ name: 'Project A', path: dirA })
      const result = manager.addProfile({ name: 'Project A', path: dirB })
      expect(result.success).toBe(false)
      expect(result.error).toContain('名称不能重复')
    })

    it('拒绝重复路径', () => {
      const dirA = tempDir()
      dirs.push(dirA)
      const { manager } = setupManager()
      manager.addProfile({ name: 'Project A', path: dirA })
      const result = manager.addProfile({ name: 'Project B', path: dirA })
      expect(result.success).toBe(false)
      expect(result.error).toContain('路径不能重复')
    })
  })

  describe('removeProfile', () => {
    it('阻止删除最后一个目录', () => {
      const dirA = tempDir()
      dirs.push(dirA)
      const { manager } = setupManager()
      manager.addProfile({ name: 'Project', path: dirA })
      const id = manager.listProfiles()[0]!.id
      const result = manager.removeProfile(id)
      expect(result.success).toBe(false)
      expect(result.error).toContain('至少保留一个')
    })

    it('删除默认目录后自动转移默认', () => {
      const dirA = tempDir()
      const dirB = tempDir()
      dirs.push(dirA, dirB)
      const { manager } = setupManager()
      manager.addProfile({ name: 'A', path: dirA, isDefault: true })
      manager.addProfile({ name: 'B', path: dirB })
      const aId = manager.listProfiles().find((p) => p.name === 'A')!.id
      const bId = manager.listProfiles().find((p) => p.name === 'B')!.id
      manager.removeProfile(aId)
      expect(manager.listProfiles().find((p) => p.id === bId)?.isDefault).toBe(true)
    })
  })

  describe('switchProfile', () => {
    it('切换后返回新目录的会话', async () => {
      const dirA = tempDir()
      const dirB = tempDir()
      dirs.push(dirA, dirB)
      const { db, manager } = setupManager()
      manager.addProfile({ name: 'A', path: dirA })
      const b = manager.addProfile({ name: 'B', path: dirB }).profile!
      const aId = manager.getActiveProfileId()
      createSession(db, { name: 'S1', workDirProfileId: aId })

      const result = await manager.switchProfile(b.id)
      expect(result.success).toBe(true)
      expect(result.sessions).toHaveLength(0)
    })
  })

  describe('resolveWorkDirForSession', () => {
    it('returns profile path bound to session', () => {
      const dirA = tempDir()
      const dirB = tempDir()
      dirs.push(dirA, dirB)
      const { db, manager } = setupManager()
      manager.addProfile({ name: 'A', path: dirA })
      const b = manager.addProfile({ name: 'B', path: dirB }).profile!
      const session = createSession(db, { name: 'S1', workDirProfileId: b.id })

      const resolved = resolveWorkDirForSession(
        db,
        session.id,
        () => manager.listProfiles(),
        () => manager.getActiveProfileId(),
        () => manager.getActiveWorkDir()
      )

      expect(resolved).toEqual({ profileId: b.id, workDir: dirB })
    })

    it('falls back to active profile when session has no profile id', () => {
      const dirA = tempDir()
      dirs.push(dirA)
      const { db, manager, getWorkDir } = setupManager()
      manager.addProfile({ name: 'A', path: dirA })
      const session = createSession(db, { name: 'S1' })

      const resolved = resolveWorkDirForSession(
        db,
        session.id,
        () => manager.listProfiles(),
        () => manager.getActiveProfileId(),
        () => manager.getActiveWorkDir()
      )

      expect(resolved?.workDir).toBe(getWorkDir())
    })
  })

  describe('migrateFromLegacy', () => {
    it('仅有 workDir 时自动生成默认 profile', () => {
      const legacyDir = tempDir()
      dirs.push(legacyDir)
      const dbPath = path.join(tempDir(), 'db.json')
      dirs.push(path.dirname(dbPath))
      const db = openDatabase(dbPath)
      db.data.configs['config.workDir'] = { value: legacyDir, createdAt: 1, updatedAt: 1 }
      db.flushSave()

      let workDir = legacyDir
      const manager = createWorkDirManager({
        db,
        getWorkDir: () => workDir,
        setWorkDir: (d) => {
          workDir = d
        }
      })
      manager.migrateFromLegacy()
      const profiles = manager.listProfiles()
      expect(profiles).toHaveLength(1)
      expect(profiles[0]?.path).toBe(legacyDir)
      expect(profiles[0]?.name).toBe('工作目录')
      expect(profiles[0]?.isDefault).toBe(true)
    })
  })
})
