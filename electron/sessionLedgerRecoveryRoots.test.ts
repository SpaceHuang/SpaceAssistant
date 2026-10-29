import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isManagedButlerSessionLedgerRoot, isSessionLedgerRecoveryRootAllowed, listManagedButlerSessionLedgerRoots } from './sessionLedgerRecoveryRoots'

describe('managed Butler ledger roots', () => {
  it('treats an unreadable optional root as a diagnostic and allows a later rescan', async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-butler-roots-unreadable-'))
    const automationRoot = path.join(userDataDir, 'automation-sessions')
    const taskRoot = path.join(automationRoot, 'task-retry')
    await fs.mkdir(taskRoot, { recursive: true })
    const canonicalAutomationRoot = await fs.realpath(automationRoot)
    const original = fsSync.readdirSync
    const diagnostics: unknown[] = []
    try {
      fsSync.readdirSync = ((target: fsSync.PathLike, ...args: unknown[]) => {
        if (path.resolve(String(target)) === canonicalAutomationRoot) throw Object.assign(new Error('denied'), { code: 'EACCES' })
        return (original as (...values: unknown[]) => unknown)(target, ...args)
      }) as typeof fsSync.readdirSync
      expect(listManagedButlerSessionLedgerRoots(userDataDir, (diagnostic) => diagnostics.push(diagnostic))).toEqual([])
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]).toMatchObject({ path: canonicalAutomationRoot, operation: 'readdir' })
      fsSync.readdirSync = original
      expect(listManagedButlerSessionLedgerRoots(userDataDir)).toEqual([await fs.realpath(taskRoot)])
    } finally {
      fsSync.readdirSync = original
      await fs.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('recognizes existing task roots and accepts task roots created after startup', async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-butler-roots-'))
    const automationRoot = path.join(userDataDir, 'automation-sessions')
    const existing = path.join(automationRoot, 'task-existing')
    const createdLater = path.join(automationRoot, 'task-created-later')
    await fs.mkdir(existing, { recursive: true })
    expect(listManagedButlerSessionLedgerRoots(userDataDir)).toEqual([await fs.realpath(existing)])
    await fs.mkdir(createdLater)
    expect(isManagedButlerSessionLedgerRoot(userDataDir, await fs.realpath(createdLater))).toBe(true)
    expect(isManagedButlerSessionLedgerRoot(userDataDir, path.join(userDataDir, 'elsewhere'))).toBe(false)
    const canonicalCreatedLater = await fs.realpath(createdLater)
    expect(isSessionLedgerRecoveryRootAllowed({ userDataDir, workDir: canonicalCreatedLater, sessionId: 'owner-session',
      configuredRoots: [], hasButlerTaskSessionLink: (taskId, sessionId) => taskId === 'task-created-later' && sessionId === 'owner-session' })).toBe(true)
    expect(isSessionLedgerRecoveryRootAllowed({ userDataDir, workDir: canonicalCreatedLater, sessionId: 'other-session',
      configuredRoots: [], hasButlerTaskSessionLink: () => false })).toBe(false)
    await fs.rm(userDataDir, { recursive: true, force: true })
  })
})
