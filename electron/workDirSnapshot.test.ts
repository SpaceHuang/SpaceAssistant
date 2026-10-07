import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from './database'
import { createSession, updateSession } from './database'
import { createWorkDirManager } from './workDirManager'
import {
  createWorkspaceSnapshotTracker,
  resolveWorkspaceSnapshot,
} from './workDirSnapshot'
import { workspacePathKey } from '../src/shared/agent/workspace'
import { createSqliteSessionStorage } from './sessionStorage/sqliteSessionStorage'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-ws-snapshot-'))
}

describe('resolveWorkspaceSnapshot / createWorkspaceSnapshotTracker', () => {
  const dirs: string[] = []
  const openDbs: Array<{ close: () => void }> = []

  afterEach(() => {
    for (const db of openDbs.splice(0)) {
      db.close()
    }
    for (const d of dirs) {
      fs.rmSync(d, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  function setup() {
    const base = tempDir()
    dirs.push(base)
    const db = openDatabase(path.join(base, 'db.db'))
    openDbs.push(db)
    let workDir = base
    const manager = createWorkDirManager({
      db,
      getWorkDir: () => workDir,
      setWorkDir: (d) => {
        workDir = d
      }
    })
    return { db, manager, base, getWorkDir: () => workDir, queries: createSqliteSessionStorage(db).queries }
  }

  it('会话绑定 profile 时产出 session-binding 快照（rootPath=realpath，key 平台化）', () => {
    const { db, manager, base, queries } = setup()
    const projectDir = path.join(base, 'project-a')
    fs.mkdirSync(projectDir, { recursive: true })
    const added = manager.addProfile({ name: 'A', path: projectDir })
    expect(added.success).toBe(true)
    const session = createSession(db, { name: 'S1', workDirProfileId: added.profile!.id })

    const snapshot = resolveWorkspaceSnapshot(queries, session.id, manager, base)
    expect(snapshot).not.toBeNull()
    expect(snapshot!.source).toBe('session-binding')
    expect(snapshot!.profileId).toBe(added.profile!.id)
    expect(snapshot!.rootPath).toBe(fs.realpathSync(projectDir))
    expect(snapshot!.key).toBe(workspacePathKey(snapshot!.rootPath))
    expect(snapshot!.sensitive).toBe(false)
    expect(snapshot!.revision).toBe(0)
  })

  it('敏感 profile 标记透传 sensitive', () => {
    const { db, manager, base, queries } = setup()
    const projectDir = path.join(base, 'sensitive-dir')
    fs.mkdirSync(projectDir, { recursive: true })
    const added = manager.addProfile({ name: 'S', path: projectDir, sensitive: true })
    const session = createSession(db, { name: 'S1', workDirProfileId: added.profile!.id })
    const snapshot = resolveWorkspaceSnapshot(queries, session.id, manager, base)
    expect(snapshot!.sensitive).toBe(true)
  })

  it('会话无绑定时回退 active profile，source=active-fallback', () => {
    const { db, manager, base, queries } = setup()
    const otherDir = path.join(base, 'other')
    fs.mkdirSync(otherDir, { recursive: true })
    manager.addProfile({ name: 'A', path: base })
    manager.addProfile({ name: 'B', path: otherDir })
    const session = createSession(db, { name: 'S1' })

    const snapshot = resolveWorkspaceSnapshot(queries, session.id, manager, base)
    expect(snapshot!.source).toBe('active-fallback')
    expect(snapshot!.profileId).toBe(manager.getActiveProfileId())
  })

  it('会话不存在时返回 null（由调用方决定 fallback）', () => {
    const { db, manager, base, queries } = setup()
    expect(resolveWorkspaceSnapshot(queries, 'missing-session', manager, base)).toBeNull()
  })

  it('通过注入的 SessionQueries 读取会话资料', () => {
    const { db, manager, base, queries } = setup()
    const session = createSession(db, { name: 'S1' })
    const readSession = vi.fn(queries.readSession)
    const injectedQueries = { ...queries, readSession }

    const snapshot = resolveWorkspaceSnapshot(injectedQueries, session.id, manager, base)

    expect(snapshot).not.toBeNull()
    expect(readSession).toHaveBeenCalledWith(session.id)
  })

  it('refresh：绑定未变返回同一快照对象（revision 不变、不触发 rebound）', () => {
    const { db, manager, base, queries } = setup()
    const projectDir = path.join(base, 'project-a')
    fs.mkdirSync(projectDir, { recursive: true })
    const added = manager.addProfile({ name: 'A', path: projectDir })
    const session = createSession(db, { name: 'S1', workDirProfileId: added.profile!.id })

    const rebounds: unknown[] = []
    const tracker = createWorkspaceSnapshotTracker({
      sessionQueries: queries,
      sessionId: session.id,
      workDirManager: manager,
      fallbackWorkDir: base,
      onRebound: (e) => rebounds.push(e),
    })

    const first = tracker.snapshot()
    const again = tracker.refresh()
    expect(again).toBe(first)
    expect(tracker.refresh()).toBe(first)
    expect(rebounds).toHaveLength(0)
  })

  it('refresh：会话改绑 profile 后返回新快照（revision+1、rootPath 更新、rebound 审计回调）', () => {
    const { db, manager, base, queries } = setup()
    const dirA = path.join(base, 'project-a')
    const dirB = path.join(base, 'project-b')
    fs.mkdirSync(dirA, { recursive: true })
    fs.mkdirSync(dirB, { recursive: true })
    const profileA = manager.addProfile({ name: 'A', path: dirA })
    const profileB = manager.addProfile({ name: 'B', path: dirB })
    const session = createSession(db, { name: 'S1', workDirProfileId: profileA.profile!.id })

    const rebounds: Array<{ fromProfileId: string; toProfileId: string; revision: number }> = []
    const tracker = createWorkspaceSnapshotTracker({
      sessionQueries: queries,
      sessionId: session.id,
      workDirManager: manager,
      fallbackWorkDir: base,
      onRebound: (e) => rebounds.push(e),
    })

    const before = tracker.snapshot()
    expect(before.rootPath).toBe(fs.realpathSync(dirA))

    updateSession(db, session.id, { workDirProfileId: profileB.profile!.id })
    const after = tracker.refresh()
    expect(after).not.toBe(before)
    expect(after.revision).toBe(before.revision + 1)
    expect(after.rootPath).toBe(fs.realpathSync(dirB))
    expect(after.source).toBe('session-binding')

    expect(rebounds).toHaveLength(1)
    expect(rebounds[0]).toMatchObject({
      sessionId: session.id,
      fromProfileId: profileA.profile!.id,
      toProfileId: profileB.profile!.id,
      revision: after.revision,
    })
  })

  it('快照构造走 fallback（会话缺失）时仍可用且可 refresh', () => {
    const { db, manager, base, queries } = setup()
    manager.addProfile({ name: 'A', path: base })
    const tracker = createWorkspaceSnapshotTracker({
      sessionQueries: queries,
      sessionId: 'missing-session',
      workDirManager: manager,
      fallbackWorkDir: base,
    })
    const first = tracker.snapshot()
    expect(first.rootPath).toBe(fs.realpathSync(base))
    expect(first.source).toBe('active-fallback')
    expect(tracker.refresh()).toBe(first)
  })

  it('workDirManager 缺失时 tracker 用 fallbackWorkDir 构造快照', () => {
    const { db, base, queries } = setup()
    const tracker = createWorkspaceSnapshotTracker({
      sessionQueries: undefined,
      sessionId: 'any',
      workDirManager: undefined,
      fallbackWorkDir: base,
    })
    const first = tracker.snapshot()
    expect(first.rootPath).toBe(fs.realpathSync(base))
    expect(first.profileId).toBe('')
    expect(tracker.refresh()).toBe(first)
  })
})
