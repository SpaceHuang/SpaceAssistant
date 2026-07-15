import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../database'
import { addTrustedCommand } from './shellCommandTrust'
import { precheckRunShellTool } from './shellToolLoopHelpers'

describe('shellToolLoopHelpers', () => {
  let dbPath: string
  let db: AppDatabase
  let workDir: string

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `sa-shell-loop-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    db = openDatabase(dbPath)
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-shell-wd-'))
  })

  afterEach(() => {
    try {
      fs.unlinkSync(dbPath)
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(workDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('denies sudo even when autoAllowScriptExecution is enabled', async () => {
    const result = await precheckRunShellTool({
      command: 'sudo rm -rf /',
      workDir,
      userDataDir: os.tmpdir(),
      shellConfig: {
        enabled: true,
        shellDefaultTimeoutSec: 300,
        autoAllowScriptExecution: true
      },
      appDb: db
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/提权|sudo|拒绝|规则/)
  })

  it('skips confirm for trusted command and touches lastUsedAt', async () => {
    const entry = addTrustedCommand(db, 'echo hello')
    expect(entry).not.toBeNull()
    const result = await precheckRunShellTool({
      command: 'echo hello world',
      workDir,
      userDataDir: os.tmpdir(),
      shellConfig: {
        enabled: true,
        shellDefaultTimeoutSec: 300,
        trustedCommands: [entry!]
      },
      appDb: db
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skipConfirm).toBe(true)
  })

  it('does not skip confirm for safe command when only autoAllowScriptExecution is enabled', async () => {
    const result = await precheckRunShellTool({
      command: 'echo safe',
      workDir,
      userDataDir: os.tmpdir(),
      shellConfig: {
        enabled: true,
        shellDefaultTimeoutSec: 300,
        autoAllowScriptExecution: true
      },
      appDb: db
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skipConfirm).toBe(false)
  })
})
