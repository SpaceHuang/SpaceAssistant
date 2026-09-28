import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, getConfigValue, setConfigValue, type AppDatabase } from './database'
import { readShellConfigFromDb } from './shell/shellConfigDb'
import {
  SHELL_DEFAULT_ENABLE_MIGRATION_VERSION,
  runShellDefaultEnableMigrationOnce,
} from './shellEnableDefaultMigration'

function tempDb(): { db: AppDatabase; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-shell-mig-'))
  const db = openDatabase(path.join(dir, 'db.db'))
  return { db, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

describe('runShellDefaultEnableMigrationOnce（存量「Shell 命令默认关闭」固化迁移）', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const c of cleanups.splice(0)) c()
  })

  function setup(): AppDatabase {
    const { db, cleanup } = tempDb()
    cleanups.push(cleanup)
    return db
  }

  it('旧默认指纹（deniedTools 恰为 [run_shell]）→ 移除该禁用并置 shell.enabled=true', () => {
    const db = setup()
    setConfigValue(db, 'config.tools', JSON.stringify({ deniedTools: ['run_shell'] }))

    const r = runShellDefaultEnableMigrationOnce(db)
    expect(r.status).toBe('done')
    expect(r.migrated).toBe(true)

    const tools = JSON.parse(getConfigValue(db, 'config.tools') ?? '{}') as { deniedTools: string[] }
    expect(tools.deniedTools).toEqual([])
    expect(readShellConfigFromDb(db).enabled).toBe(true)
  })

  it('旧默认固化（deniedTools=[run_shell] 且 config.shell.enabled=false）→ 一并打开', () => {
    const db = setup()
    setConfigValue(db, 'config.tools', JSON.stringify({ deniedTools: ['run_shell'] }))
    setConfigValue(db, 'config.shell', JSON.stringify({ enabled: false, shellDefaultTimeoutSec: 300 }))

    runShellDefaultEnableMigrationOnce(db)
    expect(JSON.parse(getConfigValue(db, 'config.tools') ?? '{}').deniedTools).toEqual([])
    expect(readShellConfigFromDb(db).enabled).toBe(true)
    // 其余 ShellConfig 字段保留
    expect(readShellConfigFromDb(db).shellDefaultTimeoutSec).toBe(300)
  })

  it('用户已禁用多个工具（deniedTools 含 run_shell + 其他）→ 不迁移（动过开关面板，非旧默认指纹）', () => {
    const db = setup()
    setConfigValue(db, 'config.tools', JSON.stringify({ deniedTools: ['run_shell', 'grep'] }))

    const r = runShellDefaultEnableMigrationOnce(db)
    expect(r.status).toBe('done')
    expect(r.migrated).toBe(false)
    expect(JSON.parse(getConfigValue(db, 'config.tools') ?? '{}').deniedTools).toEqual(['run_shell', 'grep'])
  })

  it('用户已显式开启（deniedTools 不含 run_shell）→ no-op', () => {
    const db = setup()
    setConfigValue(db, 'config.tools', JSON.stringify({ deniedTools: [] }))

    const r = runShellDefaultEnableMigrationOnce(db)
    expect(r.migrated).toBe(false)
    expect(readShellConfigFromDb(db).enabled).toBe(true)
  })

  it('config.tools 不存在（新用户）→ no-op', () => {
    const db = setup()
    const r = runShellDefaultEnableMigrationOnce(db)
    expect(r.status).toBe('done')
    expect(r.migrated).toBe(false)
  })

  it('损坏 JSON → fail-safe 跳过，不阻塞', () => {
    const db = setup()
    setConfigValue(db, 'config.tools', '{not-json')

    const r = runShellDefaultEnableMigrationOnce(db)
    expect(r.status).toBe('done')
    expect(r.migrated).toBe(false)
  })

  it('版本门控幂等：第二次调用 skipped，不再改写', () => {
    const db = setup()
    setConfigValue(db, 'config.tools', JSON.stringify({ deniedTools: ['run_shell'] }))

    expect(runShellDefaultEnableMigrationOnce(db).migrated).toBe(true)
    // 模拟用户随后再次关闭
    setConfigValue(db, 'config.tools', JSON.stringify({ deniedTools: ['run_shell'] }))
    const second = runShellDefaultEnableMigrationOnce(db)
    expect(second.status).toBe('skipped')
    expect(second.migrated).toBe(false)
    // 用户再次关闭的状态被保留
    expect(JSON.parse(getConfigValue(db, 'config.tools') ?? '{}').deniedTools).toEqual(['run_shell'])
  })

  it('版本常量为 1（与 confirmMode 退役迁移同模式）', () => {
    expect(SHELL_DEFAULT_ENABLE_MIGRATION_VERSION).toBe(1)
  })
})
