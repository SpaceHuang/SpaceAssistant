import { describe, it, expect } from 'vitest'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import { collectWriteDirCandidates } from './writeDirCandidates'
import { FileStateCache } from '../fileStateCache'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession, setConfigValue } from '../database'
import {
  findLatestWriteDirChoiceInWorkspace,
  isSessionInSameWorkspace,
  setWriteDirChoice
} from './sessionWriteDir'

async function withTempWorkDir<T>(fn: (workDir: string) => Promise<T>): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cand-'))
  try {
    return await fn(tmp)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

describe('collectWriteDirCandidates', () => {
  it('includes workDir as fallback candidate', async () => {
    await withTempWorkDir(async (workDir) => {
      const cache = new FileStateCache()
      const result = await collectWriteDirCandidates({
        workDir,
        sessionId: 's1',
        fileStateCache: cache,
        userMessages: []
      })
      expect(result.some((c) => c.dir === path.resolve(workDir))).toBe(true)
    })
  })

  it('includes dirs of files in fileStateCache', async () => {
    await withTempWorkDir(async (workDir) => {
      await fs.mkdir(path.join(workDir, 'sub1'), { recursive: true })
      await fs.writeFile(path.join(workDir, 'sub1', 'a.py'), 'x')
      const cache = new FileStateCache()
      cache.set(path.join(workDir, 'sub1', 'a.py'), {
        path: path.join(workDir, 'sub1', 'a.py'),
        content: 'x',
        mtime: 0,
        readAt: 0,
        isPartial: false
      })
      const result = await collectWriteDirCandidates({
        workDir,
        sessionId: 's1',
        fileStateCache: cache,
        userMessages: []
      })
      expect(result.some((c) => c.dir === path.resolve(workDir, 'sub1'))).toBe(true)
    })
  })

  it('includes existing dirs mentioned in user messages', async () => {
    await withTempWorkDir(async (workDir) => {
      await fs.mkdir(path.join(workDir, 'docs'), { recursive: true })
      const result = await collectWriteDirCandidates({
        workDir,
        sessionId: 's1',
        fileStateCache: new FileStateCache(),
        userMessages: ['请把文件放到 docs 目录']
      })
      expect(result.some((c) => c.dir === path.resolve(workDir, 'docs'))).toBe(true)
    })
  })

  it('includes latest write dir from another session in same workspace', async () => {
    await withTempWorkDir(async (workDir) => {
      const db = createMemoryAppDb()
      setConfigValue(db, 'config.activeWorkDirProfileId', 'profile-a')

      await fs.mkdir(path.join(workDir, 'Script'), { recursive: true })
      const prevDir = path.join(workDir, 'Script')

      const prevMeta: Record<string, unknown> = {}
      setWriteDirChoice(prevMeta, { dir: prevDir, confirmedAt: 1000 })
      createSession(db, {
        name: 'prev',
        workDirProfileId: 'profile-a',
        metadata: prevMeta
      })

      const result = await collectWriteDirCandidates({
        workDir,
        sessionId: 'current',
        fileStateCache: new FileStateCache(),
        userMessages: [],
        db
      })

      const match = result.find((c) => c.dir === path.resolve(prevDir))
      expect(match).toBeDefined()
      expect(match?.labelKind).toBe('recentSession')
      expect(match?.label).toBe('Script')
      expect(result[0]?.dir).toBe(path.resolve(prevDir))
    })
  })

  it('ignores write dir from session in another workspace profile', async () => {
    await withTempWorkDir(async (workDir) => {
      const db = createMemoryAppDb()
      setConfigValue(db, 'config.activeWorkDirProfileId', 'profile-a')

      const otherDir = path.join(workDir, 'other')
      await fs.mkdir(otherDir, { recursive: true })

      const prevMeta: Record<string, unknown> = {}
      setWriteDirChoice(prevMeta, { dir: otherDir, confirmedAt: 1000 })
      createSession(db, {
        name: 'other workspace',
        workDirProfileId: 'profile-b',
        metadata: prevMeta
      })

      const result = await collectWriteDirCandidates({
        workDir,
        sessionId: 'current',
        fileStateCache: new FileStateCache(),
        userMessages: [],
        db
      })

      expect(result.some((c) => c.labelKind === 'recentSession')).toBe(false)
    })
  })

  it('picks most recent confirmedAt among same-workspace sessions', async () => {
    await withTempWorkDir(async (workDir) => {
      const db = createMemoryAppDb()
      setConfigValue(db, 'config.activeWorkDirProfileId', 'profile-a')

      await fs.mkdir(path.join(workDir, 'older'), { recursive: true })
      await fs.mkdir(path.join(workDir, 'newer'), { recursive: true })

      const olderMeta: Record<string, unknown> = {}
      setWriteDirChoice(olderMeta, { dir: path.join(workDir, 'older'), confirmedAt: 1000 })
      createSession(db, { name: 'older', workDirProfileId: 'profile-a', metadata: olderMeta })

      const newerMeta: Record<string, unknown> = {}
      setWriteDirChoice(newerMeta, { dir: path.join(workDir, 'newer'), confirmedAt: 3000 })
      createSession(db, { name: 'newer', workDirProfileId: 'profile-a', metadata: newerMeta })

      const latest = findLatestWriteDirChoiceInWorkspace(db, {
        workDirProfileId: 'profile-a',
        activeProfileId: 'profile-a',
        excludeSessionId: 'current',
        workDir
      })

      expect(latest?.dir).toBe(path.resolve(workDir, 'newer'))
    })
  })

  it('dedupes by normalized absolute path', async () => {
    await withTempWorkDir(async (workDir) => {
      const result = await collectWriteDirCandidates({
        workDir,
        sessionId: 's1',
        fileStateCache: new FileStateCache(),
        userMessages: []
      })
      const dirs = result.map((c) => c.dir)
      expect(new Set(dirs).size).toBe(dirs.length)
    })
  })

  it('assigns sequential letters A, B, ... up to 25', async () => {
    await withTempWorkDir(async (workDir) => {
      const result = await collectWriteDirCandidates({
        workDir,
        sessionId: 's1',
        fileStateCache: new FileStateCache(),
        userMessages: []
      })
      expect(result.length).toBeLessThanOrEqual(25)
      expect(result[0]?.key).toBe('A')
    })
  })
})

describe('isSessionInSameWorkspace', () => {
  it('matches by workDirProfileId', () => {
    expect(
      isSessionInSameWorkspace(
        { workDirProfileId: 'p1' } as import('../../src/shared/domainTypes').Session,
        'p1',
        'active'
      )
    ).toBe(true)
    expect(
      isSessionInSameWorkspace(
        { workDirProfileId: 'p2' } as import('../../src/shared/domainTypes').Session,
        'p1',
        'active'
      )
    ).toBe(false)
  })

  it('treats legacy session without profile as active workspace', () => {
    expect(
      isSessionInSameWorkspace({} as import('../../src/shared/domainTypes').Session, 'active', 'active')
    ).toBe(true)
    expect(
      isSessionInSameWorkspace({} as import('../../src/shared/domainTypes').Session, 'other', 'active')
    ).toBe(false)
  })
})
