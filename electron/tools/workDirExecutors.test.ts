import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSession, openDatabase } from '../database'
import { createWorkDirManager } from '../workDirManager'
import { listWorkDirsExecutor, switchWorkDirExecutor } from './workDirExecutors'
import { createSwitchWorkDirRegisteredTool } from './workDirRegisteredTools'
import { executeRegisteredTool } from './toolInvocationCoordinator'
import { createPermitBoundCoordinatorDispatch } from './permitBoundCoordinatorDispatch'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'
import type { ToolExecutionContext } from './types'
import {
  releaseRemoteSession,
  resetRunningRemoteAgentRegistryForTests,
  tryClaimRemoteSession
} from '../remote/remoteAgentRegistry'
import { REMOTE_WORKDIR_SWITCH_BUSY_MESSAGE } from '../remote/remoteSessionGuardMessages'
import { remoteWriteGrantRegistry } from '../remote/remoteWriteGrantRegistry'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'

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

  it('确认后别名被重定向时在 dispatch 前拒绝切换', async () => {
    let profiles = [{ id: 'profile-approved', name: 'Beta', path: '/work/beta', aliases: ['beta'], sensitive: false }]
    const manager = { listProfiles: () => profiles } as never
    const tool = createSwitchWorkDirRegisteredTool(switchWorkDirExecutor)
    const executor = vi.spyOn(switchWorkDirExecutor, 'execute')
    let dispatched = false

    await expect(executeRegisteredTool(tool, { name: 'beta' }, {
      requestId: 'req-switch', toolUseId: 'call-switch', signal: new AbortController().signal,
      executionContext: { workDirManager: manager } as never
    }, {
      confirm: async () => {
        profiles = [{ id: 'profile-retargeted', name: 'Beta', path: '/work/private', aliases: ['beta'], sensitive: true }]
        return true
      },
      dispatch: async (_handle, _context, run) => {
        dispatched = true
        return run(new AbortController().signal)
      }
    })).rejects.toThrow('WORKDIR_PREPARED_TARGET_CHANGED')

    expect(dispatched).toBe(false)
    expect(executor).not.toHaveBeenCalled()
    executor.mockRestore()
  })

  it('switch_work_dir 在 claim barrier 中授权版本变化时不调用切换 executor', async () => {
    const profiles = [{ id: 'profile-approved', name: 'Beta', path: '/work/beta', aliases: ['beta'], sensitive: false }]
    const manager = { listProfiles: () => profiles } as never
    const tool = createSwitchWorkDirRegisteredTool(switchWorkDirExecutor)
    const executor = vi.spyOn(switchWorkDirExecutor, 'execute').mockResolvedValue({ success: true })
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest('req-switch', 'feishu', 'req-switch')
    const ledger = new InMemoryExecutionAdmissionCoordinator()
    let reachedClaim!: () => void
    let releaseClaim!: () => void
    const atClaim = new Promise<void>((resolve) => { reachedClaim = resolve })
    const barrier = new Promise<void>((resolve) => { releaseClaim = resolve })
    const admission = {
      markPermitConsumed: (...args: Parameters<typeof ledger.markPermitConsumed>) => ledger.markPermitConsumed(...args),
      beginDispatch: async (...args: Parameters<typeof ledger.beginDispatch>) => {
        reachedClaim()
        await barrier
        return ledger.beginDispatch(...args)
      },
      invalidate: (...args: Parameters<typeof ledger.invalidate>) => ledger.invalidate(...args),
      settle: (...args: Parameters<typeof ledger.settle>) => ledger.settle(...args)
    }
    let authorizationVersion = 'rule-v1'
    const dispatch = createPermitBoundCoordinatorDispatch({
      requestId: 'req-switch', turnId: 'turn-switch', canonicalInput: { name: 'beta' },
      authorizationVersion, currentAuthorizationVersion: () => authorizationVersion,
      targetVersion: 'target-v1', phase: 'recheck', initialFactsHash: 'facts-v1',
      recheck: async () => ({ allowed: true, authorizationVersion: 'rule-v1', targetVersion: 'target-v1', factsHash: 'facts-v1' }),
      safetyPolicy: { evaluate: async () => ({ kind: 'allow' as const, authorizationVersion: 'rule-v1' }) },
      isAllowed: () => !revocations.isToolRevoked('req-switch', 'switch_work_dir'), toolRevocations: revocations, admission
    })
    const result = executeRegisteredTool(tool, { name: 'beta' }, {
      requestId: 'req-switch', toolUseId: 'call-switch-version', signal: new AbortController().signal,
      executionContext: { requestId: 'req-switch', toolUseId: 'call-switch-version', workDirManager: manager } as never
    }, { confirm: async () => true, dispatch })
    try {
      await atClaim
      expect(executor).not.toHaveBeenCalled()
      authorizationVersion = 'rule-v2'
      releaseClaim()
      await expect(result).rejects.toThrow('AUTHORIZATION_STALE')
      expect(executor).not.toHaveBeenCalled()
      expect(ledger.activeLeaseCount('req-switch')).toBe(0)
    } finally {
      releaseClaim()
      executor.mockRestore()
    }
  })

  it('稳定匹配时将确认过的 profile id 交给原 executor', async () => {
    const profiles = [{ id: 'profile-approved', name: 'Beta', path: '/work/beta', aliases: ['beta'], sensitive: false }]
    const manager = { listProfiles: () => profiles } as never
    const tool = createSwitchWorkDirRegisteredTool(switchWorkDirExecutor)
    const executor = vi.spyOn(switchWorkDirExecutor, 'execute').mockResolvedValue({ success: true })

    await expect(executeRegisteredTool(tool, { name: 'beta' }, {
      requestId: 'req-switch', toolUseId: 'call-switch-stable', signal: new AbortController().signal,
      executionContext: { workDirManager: manager } as never
    }, {
      confirm: async () => true,
      dispatch: async (_handle, _context, run) => run(new AbortController().signal)
    })).resolves.toMatchObject({ success: true })

    expect(executor).toHaveBeenCalledWith(
      { name: 'beta', profile_id: 'profile-approved' },
      expect.objectContaining({ requestId: 'req-switch', toolUseId: 'call-switch-stable' })
    )
    executor.mockRestore()
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
      sessionQueries: createSqliteSessionStorage(db).queries,
      sessionCommands: createSqliteSessionStorage(db).commands,
      workDirManager: manager,
      remoteContext: {
        source: 'feishu' as const,
        messageId: 'msg-1',
        confirmPolicy: 'always' as const
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

    tryClaimRemoteSession(session.id, 'req-1', 3)
    const result = await switchWorkDirExecutor.execute(
      { name: 'beta' },
      makeRemoteCtx(db, manager, session.id)
    )
    releaseRemoteSession(session.id, 'req-1')

    expect(result.success).toBe(true)
    const data = result.data as { profileId: string; workDir: string }
    expect(data.profileId).toBe(b.profile!.id)
    expect(data.workDir).toBe(dirB)
  })

  it('switch_work_dir rejects when no live lease exists', async () => {
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
    manager.addProfile({ name: 'Beta', path: dirB, aliases: ['beta'] })
    const session = createSession(db, { name: 'S1' })

    const result = await switchWorkDirExecutor.execute(
      { name: 'beta' },
      makeRemoteCtx(db, manager, session.id)
    )

    expect(result.success).toBe(false)
    expect(result.error).toBe(REMOTE_WORKDIR_SWITCH_BUSY_MESSAGE)
  })

  it('执行时发现目标 profile 已变为敏感时返回可审计的机制诊断', async () => {
    const dirA = tempDir()
    const dirB = tempDir()
    dirs.push(dirA, dirB)
    const dbPath = path.join(tempDir(), 'db.db')
    dirs.push(path.dirname(dbPath))
    const db = openDatabase(dbPath)
    openDbs.push(db)
    const manager = createWorkDirManager({ db, getWorkDir: () => dirA, setWorkDir: () => undefined })
    manager.addProfile({ name: 'Secret', path: dirB, sensitive: true })
    const session = createSession(db, { name: 'S1' })
    tryClaimRemoteSession(session.id, 'req-1', 3)
    const result = await switchWorkDirExecutor.execute({ name: 'Secret' }, makeRemoteCtx(db, manager, session.id))
    releaseRemoteSession(session.id, 'req-1')

    expect(result).toMatchObject({
      success: false,
      diagnostic: { caseId: 'workdir-profile-sensitive-at-execution', category: 'environment', retryable: true }
    })
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
    tryClaimRemoteSession(session.id, 'req-other', 3)

    const result = await listWorkDirsExecutor.execute({}, makeRemoteCtx(db, manager, session.id))
    releaseRemoteSession(session.id, 'req-other')

    expect(result.success).toBe(true)
  })

  it('switch_work_dir rejects profile change while busy for another requestId', async () => {
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
    // makeRemoteCtx uses requestId 'req-1'; claim under a different requestId to simulate
    // another Agent holding the origin lease for this session.
    tryClaimRemoteSession(session.id, 'req-other', 3)

    const result = await switchWorkDirExecutor.execute({ name: 'B' }, makeRemoteCtx(db, manager, session.id))
    releaseRemoteSession(session.id, 'req-other')

    expect(result.success).toBe(false)
    expect(result.error).toBe(REMOTE_WORKDIR_SWITCH_BUSY_MESSAGE)
  })

  it('switch_work_dir allows profile change for the Agent holding its own origin lease', async () => {
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
    // Same requestId as makeRemoteCtx ('req-1'): the current Agent owns the origin lease.
    tryClaimRemoteSession(session.id, 'req-1', 3)

    const revoked: Array<[string, string]> = []
    const unregister = remoteWriteGrantRegistry.onRevokeByOriginSession((originSessionId, reason) => {
      revoked.push([originSessionId, reason])
    })
    const result = await switchWorkDirExecutor.execute({ name: 'B' }, makeRemoteCtx(db, manager, session.id))
    unregister()
    releaseRemoteSession(session.id, 'req-1')

    expect(result.success).toBe(true)
    expect(revoked).toEqual([[session.id, 'workdir_switch']])
  })
})
