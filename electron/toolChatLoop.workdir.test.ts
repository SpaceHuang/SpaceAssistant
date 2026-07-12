import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSession, openDatabase, updateSession } from './database'
import { buildResolveWorkDirCallback, createWorkDirManager } from './workDirManager'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sa-tcl-wd-'))
}

describe('toolChatLoop dynamic workDir contract', () => {
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

  it('resolveWorkDir callback reflects session binding changes within a tool loop round', () => {
    const dirA = tempDir()
    const dirB = tempDir()
    dirs.push(dirA, dirB)
    const dbPath = path.join(tempDir(), 'db.db')
    dirs.push(path.dirname(dbPath))
    const db = openDatabase(dbPath)
    openDbs.push(db)

    let workDir = dirA
    const manager = createWorkDirManager({
      db,
      getWorkDir: () => workDir,
      setWorkDir: (d) => {
        workDir = d
      }
    })
    const a = manager.addProfile({ name: 'A', path: dirA })
    const b = manager.addProfile({ name: 'B', path: dirB })
    const session = createSession(db, { name: 'S1', workDirProfileId: a.profile!.id })

    const resolveWorkDir = buildResolveWorkDirCallback(db, session.id, manager, dirA)
    expect(resolveWorkDir()).toBe(dirA)

    // Simulates switch_work_dir updating binding before next tool iteration
    updateSession(db, session.id, { workDirProfileId: b.profile!.id })
    expect(resolveWorkDir()).toBe(dirB)
  })
})
