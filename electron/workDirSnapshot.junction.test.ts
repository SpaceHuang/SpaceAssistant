import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './database'
import { createSession } from './database'
import { createWorkDirManager } from './workDirManager'
import { createWorkspaceSnapshotTracker } from './workDirSnapshot'
import { workspacePathKey } from '../src/shared/agent/workspace'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-ws-junction-'))
}

/**
 * C2（评审 2026-09-28）：basis-mismatch 误报修复的行为验证——
 * legacy 侧（buildResolveWorkDirCallback 返回 profile.path 字面拼写）与快照侧
 * （realpath 归一）必须同口径比较，junction / 8.3 等合法字面变体不得触发分歧。
 */
describe('workDirSnapshot：字面变体与 realpath 归一不误报（C2）', () => {
  const dirs: string[] = []
  const openDbs: Array<{ close: () => void }> = []

  afterEach(() => {
    for (const db of openDbs.splice(0)) db.close()
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  it('junction 指向的目录：字面（junction 路径）与快照（realpath 真实路径）同 key，不触发分歧', () => {
    if (process.platform !== 'win32') return
    const base = tempDir()
    dirs.push(base)
    const real = path.join(base, 'real-target')
    fs.mkdirSync(real, { recursive: true })
    const link = path.join(base, 'link-junction')
    fs.symlinkSync(real, link, 'junction')
    dirs.push(link)

    const db = openDatabase(path.join(base, 'db.db'))
    openDbs.push(db)
    const manager = createWorkDirManager({ db, getWorkDir: () => link, setWorkDir: () => {} })
    const added = manager.addProfile({ name: 'J', path: link })
    const session = createSession(db, { name: 'S', workDirProfileId: added.profile!.id })

    const tracker = createWorkspaceSnapshotTracker({
      db,
      sessionId: session.id,
      workDirManager: manager,
      fallbackWorkDir: link
    })
    const snapshot = tracker.snapshot()
    // 快照侧：realpath 归一到真实目标
    expect(snapshot.rootPath).toBe(fs.realpathSync(real))
    // 同口径后两侧 key 相等（修复前：legacy=link 字面 vs 快照=real realpath → 误报 mismatch）
    expect(workspacePathKey(fs.realpathSync(link))).toBe(snapshot.key)
  })

  it('尾分隔符 / 大小写字面变体不触发分歧（与盘符根修复一致）', () => {
    const base = tempDir()
    dirs.push(base)
    const db = openDatabase(path.join(base, 'db.db'))
    openDbs.push(db)
    const manager = createWorkDirManager({ db, getWorkDir: () => base, setWorkDir: () => {} })
    manager.addProfile({ name: 'B', path: base })
    const tracker = createWorkspaceSnapshotTracker({
      db,
      sessionId: 'sess-x',
      workDirManager: manager,
      fallbackWorkDir: base + path.sep
    })
    const snapshot = tracker.snapshot()
    expect(workspacePathKey(fs.realpathSync(base) + path.sep)).toBe(snapshot.key)
  })
})
