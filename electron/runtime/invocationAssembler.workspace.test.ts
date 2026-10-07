import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSession, openDatabase, updateSession } from '../database'
import { createWorkDirManager } from '../workDirManager'
import { assembleInvocation } from '../testSupport/invocationAssembler'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-asm-ws-'))
}

/** 最小可装配材料（与桌面链路同构：workDir + workDirManager + appDb） */
function buildMaterials(overrides: Record<string, unknown>) {
  return {
    requestId: 'req-ws-1',
    sessionId: 'sess-ws-1',
    model: 'test-model',
    messages: [],
    toolsConfig: {},
    locale: 'zh-CN' as const,
    userDataDir: tempDir(),
    getApiKey: async () => null,
    emitFactEvent: () => {},
    emitSessionEvent: () => {},
    ...overrides
  } as Parameters<typeof assembleInvocation>[0]
}

describe('assembleInvocation workspace snapshot ports（R1）', () => {
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

  it('ports.workspace 快照与绑定目录一致；workDir 是快照 rootPath 投影', () => {
    const base = tempDir()
    dirs.push(base)
    const bound = path.join(base, 'bound-project')
    fs.mkdirSync(bound, { recursive: true })
    const db = openDatabase(path.join(base, 'db.db'))
    openDbs.push(db)
    const manager = createWorkDirManager({ db, getWorkDir: () => base, setWorkDir: () => {} })
    manager.addProfile({ name: 'Base', path: base })
    const added = manager.addProfile({ name: 'Bound', path: bound })
    const session = createSession(db, { name: 'S', workDirProfileId: added.profile!.id })

    const { ports } = assembleInvocation(
      buildMaterials({
        sessionId: session.id,
        workDir: base,
        workDirManager: manager,
        appDb: db
      })
    )
    const snapshot = ports.workspace.snapshot()
    expect(snapshot.source).toBe('session-binding')
    expect(snapshot.rootPath).toBe(fs.realpathSync(bound))
    expect(ports.workspace.workDir).toBe(snapshot.rootPath)
  })

  it('refresh：绑定未变返回同一对象；改绑后 revision+1 且 rootPath 更新', () => {
    const base = tempDir()
    dirs.push(base)
    const dirA = path.join(base, 'a')
    const dirB = path.join(base, 'b')
    fs.mkdirSync(dirA, { recursive: true })
    fs.mkdirSync(dirB, { recursive: true })
    const db = openDatabase(path.join(base, 'db.db'))
    openDbs.push(db)
    const manager = createWorkDirManager({ db, getWorkDir: () => base, setWorkDir: () => {} })
    const pa = manager.addProfile({ name: 'A', path: dirA })
    const pb = manager.addProfile({ name: 'B', path: dirB })
    const session = createSession(db, { name: 'S', workDirProfileId: pa.profile!.id })

    const { ports } = assembleInvocation(
      buildMaterials({
        sessionId: session.id,
        workDir: dirA,
        workDirManager: manager,
        appDb: db
      })
    )
    const first = ports.workspace.snapshot()
    expect(ports.workspace.refresh()).toBe(first)

    updateSession(db, session.id, { workDirProfileId: pb.profile!.id })
    const second = ports.workspace.refresh()
    expect(second).not.toBe(first)
    expect(second.revision).toBe(first.revision + 1)
    expect(second.rootPath).toBe(fs.realpathSync(dirB))
  })

  it('未传 workDirManager 时快照走 fallback（rootPath=workDir 材料），refresh 稳定', () => {
    const base = tempDir()
    dirs.push(base)
    const { ports } = assembleInvocation(buildMaterials({ workDir: base }))
    const first = ports.workspace.snapshot()
    expect(first.source).toBe('active-fallback')
    expect(first.rootPath).toBe(fs.realpathSync(base))
    expect(ports.workspace.refresh()).toBe(first)
  })
})
