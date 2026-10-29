import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isManagedButlerSessionLedgerRoot, isSessionLedgerRecoveryRootAllowed, listManagedButlerSessionLedgerRoots } from './sessionLedgerRecoveryRoots'

describe('managed Butler ledger roots', () => {
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
