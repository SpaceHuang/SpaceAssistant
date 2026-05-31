import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, getConfigValue, type AppDatabase } from '../database'
import {
  persistShellConfig,
  readShellConfigFromDb,
  SHELL_CONFIG_KEY,
  syncShellDeniedTools
} from './shellConfigDb'
import { DEFAULT_SHELL_CONFIG } from '../../src/shared/domainTypes'

describe('shellConfigDb', () => {
  let dbPath: string
  let db: AppDatabase

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `sa-shell-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    db = openDatabase(dbPath)
  })

  afterEach(() => {
    try {
      fs.unlinkSync(dbPath)
    } catch {
      /* ignore */
    }
  })

  it('returns defaults when config missing', () => {
    expect(readShellConfigFromDb(db)).toEqual(DEFAULT_SHELL_CONFIG)
  })

  it('persists and merges partial updates', () => {
    const next = persistShellConfig(db, { enabled: true, shellDefaultTimeoutSec: 120 })
    expect(next.enabled).toBe(true)
    expect(next.shellDefaultTimeoutSec).toBe(120)
    expect(getConfigValue(db, SHELL_CONFIG_KEY)).toContain('"enabled":true')
    expect(readShellConfigFromDb(db).shellDefaultTimeoutSec).toBe(120)
  })

  it('syncShellDeniedTools adds run_shell when disabled', () => {
    expect(syncShellDeniedTools({ ...DEFAULT_SHELL_CONFIG, enabled: false }, [])).toContain('run_shell')
  })

  it('syncShellDeniedTools removes run_shell when enabled', () => {
    expect(syncShellDeniedTools({ ...DEFAULT_SHELL_CONFIG, enabled: true }, ['run_shell'])).not.toContain(
      'run_shell'
    )
  })
})
