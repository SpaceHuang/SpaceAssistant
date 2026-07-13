import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSession, openDatabase } from '../database'
import { createWorkDirManager } from '../workDirManager'
import { listWorkDirsExecutor, switchWorkDirExecutor } from './workDirExecutors'
import type { ToolExecutionContext } from './types'
import {
  releaseRemoteSession,
  resetRunningRemoteAgentRegistryForTests,
  tryClaimRemoteSession
} from '../remote/remoteAgentRegistry'
import { REMOTE_WORKDIR_SWITCH_BUSY_MESSAGE } from '../remote/remoteSessionGuardMessages'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-wde-'))
}

describe('workDirExecutors', () => {
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

  function makeRemoteCtx(db: ReturnType<typeof openDatabase>, manager: ReturnType<typeof createWorkDirManager>, sessionId: string) {
    return {
      workDir: manager.getActiveWorkDir(),
      userDataDir: tempDir(),
      requestId: 'req-1',
      toolUseId: 'tu-1',
      sessionId,
      sendProgress: () => undefined,
      signal: new AbortController().signal,
      fileStateCache: {} as ToolExecutionContext['fileStateCache'],
      toolsConfig: { enabled: true, allowedTools: [], deniedTools: [] },
      appDatabase: db,
      workDirManager: manager,
      remoteContext: {
        source: 'feishu' as const,
        messageId: 'msg-1',
        confirmPolicy: 'remote_confirm' as const
      }
    } satisfies ToolExecutionContext
  }

  it('list_work_dirs marks bound and active profiles', async () => {
    const dirA = tempDir()
    const dirB = tempDir()
    dirs.push(dirA, dirB)
    const dbPath = path.join(tempDir(), 'db.db')
    dirs.push(path.dirname(dbPath))
    const db = openDatabase(dbPath)
    openDbs.push(db)
    const manager = createWorkDirManager({
      db,
      getWorkDir: () => dirA,
      setWorkDir: () => undefined
    })
    const a = manager.addProfile({ name: 'A', path: dirA, isDefault: true })
    const b = manager.addProfile({ name: 'B', path: dirB })
    await manager.switchProfile(b.profile!.id)
    const session = createSession(db, { name: 'S1', workDirProfileId: a.profile!.id })

    const result = await listWorkDirsExecutor.execute({}, makeRemoteCtx(db, manager, session.id))
    expect(result.success).toBe(true)
    const data = result.data as {
      directories: Array<{ id: string; isBound: boolean; isActive: boolean; isSensitive: boolean }>
      currentBoundId: string
      activeProfileId: string
    }
    expect(data.currentBoundId).toBe(a.profile!.id)
    expect(data.activeProfileId).toBe(b.profile!.id)
    const bound = data.directories.find((d) => d.id === a.profile!.id)
    const active = data.directories.find((d) => d.id === b.profile!.id)
    expect(bound?.isBound).toBe(true)
    expect(active?.isActive).toBe(true)
  })

  it('switch_work_dir binds session by name', async () => {
    const dirA = tempDir()
    const dirB = tempDir()
    dirs.push(dirA, dirB)
    const dbPath = path.join(tempDir(), 'db.db')
    dirs.push(path.dirname(dbPath))
    const db = openDatabase(dbPath)
    openDbs.push(db)
    const manager = createWorkDirManager({
      db,
      getWorkDir: () => dirA,
      setWorkDir: () => undefined
    })
    const b = manager.addProfile({ name: 'Beta', path: dirB, aliases: ['beta'] })
    const session = createSession(db, { name: 'S1' })

    const result = await switchWorkDirExecutor.execute({ name: 'beta' }, makeRemoteCtx(db, manager, session.id))
    expect(result.success).toBe(true)
    const data = result.data as { profileId: string; workDir: string }
    expect(data.profileId).toBe(b.profile!.id)
    expect(data.workDir).toBe(dirB)
  })

  it('switch_work_dir returns ambiguous matches', async () => {
    const dirA = tempDir()
    const dirB = tempDir()
    const dirC = tempDir()
    dirs.push(dirA, dirB, dirC)
    const dbPath = path.join(tempDir(), 'db.db')
    dirs.push(path.dirname(dbPath))
    const db = openDatabase(dbPath)
    openDbs.push(db)
    const manager = createWorkDirManager({
      db,
      getWorkDir: () => dirA,
      setWorkDir: () => undefined
    })
    manager.addProfile({ name: 'Alpha One', path: dirA })
    manager.addProfile({ name: 'Alpha Two', path: dirB })
    const session = createSession(db, { name: 'S1' })

    const result = await switchWorkDirExecutor.execute({ name: 'alpha' }, makeRemoteCtx(db, manager, session.id))
    expect(result.success).toBe(false)
    const data = result.data as { ambiguous: Array<{ id: string }> }
    expect(data.ambiguous.length).toBeGreaterThan(1)
  })

  it('rejects desktop invocation', async () => {
    const dirA = tempDir()
    dirs.push(dirA)
    const dbPath = path.join(tempDir(), 'db.db')
    dirs.push(path.dirname(dbPath))
    const db = openDatabase(dbPath)
    openDbs.push(db)
    const manager = createWorkDirManager({
      db,
      getWorkDir: () => dirA,
      setWorkDir: () => undefined
    })
    const session = createSession(db, { name: 'S1' })
    const ctx = makeRemoteCtx(db, manager, session.id)
    delete ctx.remoteContext

    const listResult = await listWorkDirsExecutor.execute({}, ctx)
    expect(listResult.success).toBe(false)
    expect(listResult.error).toContain('远程会话')
  })

  it('list_work_dirs works while session is busy', async () => {
    const dirA = tempDir()
    dirs.push(dirA)
    const dbPath = path.join(tempDir(), 'db.db')
    dirs.push(path.dirname(dbPath))
    const db = openDatabase(dbPath)
    openDbs.push(db)
    const manager = createWorkDirManager({
      db,
      getWorkDir: () => dirA,
      setWorkDir: () => undefined
    })
    manager.addProfile({ name: 'A', path: dirA })
    const session = createSession(db, { name: 'S1' })
    tryClaimRemoteSession(session.id, 3)

    const result = await listWorkDirsExecutor.execute({}, makeRemoteCtx(db, manager, session.id))
    releaseRemoteSession(session.id)

    expect(result.success).toBe(true)
  })

  it('switch_work_dir rejects profile change while busy', async () => {
    const dirA = tempDir()
    const dirB = tempDir()
    dirs.push(dirA, dirB)
    const dbPath = path.join(tempDir(), 'db.db')
    dirs.push(path.dirname(dbPath))
    const db = openDatabase(dbPath)
    openDbs.push(db)
    const manager = createWorkDirManager({
      db,
      getWorkDir: () => dirA,
      setWorkDir: () => undefined
    })
    const a = manager.addProfile({ name: 'A', path: dirA })
    manager.addProfile({ name: 'B', path: dirB })
    const session = createSession(db, { name: 'S1', workDirProfileId: a.profile!.id })
    tryClaimRemoteSession(session.id, 3)

    const result = await switchWorkDirExecutor.execute({ name: 'B' }, makeRemoteCtx(db, manager, session.id))
    releaseRemoteSession(session.id)

    expect(result.success).toBe(false)
    expect(result.error).toBe(REMOTE_WORKDIR_SWITCH_BUSY_MESSAGE)
  })
})
