import { afterEach, describe, expect, it } from 'vitest'
import { getConfigValue, openSqliteDatabase, setConfigValue, type AppDatabase } from '../database'
import {
  CONFIRM_MODE_RETIREMENT_MIGRATION_VERSION,
  CONFIRM_MODE_RETIREMENT_MIGRATION_VERSION_KEY,
  runConfirmModeRetirementMigrationOnce,
  rawToolsContainConfirmMode
} from './confirmModeRetirementMigration'

const dbs: AppDatabase[] = []
afterEach(() => dbs.splice(0).forEach((db) => db.close()))

function db(): AppDatabase {
  const d = openSqliteDatabase(':memory:')
  dbs.push(d)
  return d
}

describe('runConfirmModeRetirementMigrationOnce（confirmMode 退役迁移，§5.7）', () => {
  it('存量 tools JSON 含 confirmMode：删除该键并落版本标记，其余字段保留', () => {
    const d = db()
    setConfigValue(
      d,
      'config.tools',
      JSON.stringify({
        enabled: true,
        confirmMode: 'auto',
        deniedTools: ['run_shell'],
        pythonPath: 'python'
      })
    )
    const res = runConfirmModeRetirementMigrationOnce(d)
    expect(res.status).toBe('done')
    expect(res.migrated).toBe(true)
    const after = JSON.parse(getConfigValue(d, 'config.tools')!) as Record<string, unknown>
    expect('confirmMode' in after).toBe(false)
    expect(after.enabled).toBe(true)
    expect(after.deniedTools).toEqual(['run_shell'])
    expect(after.pythonPath).toBe('python')
    expect(getConfigValue(d, CONFIRM_MODE_RETIREMENT_MIGRATION_VERSION_KEY)).toBe(
      String(CONFIRM_MODE_RETIREMENT_MIGRATION_VERSION)
    )
  })

  it('tools JSON 不含 confirmMode：仅落版本标记（幂等快路径）', () => {
    const d = db()
    setConfigValue(d, 'config.tools', JSON.stringify({ enabled: true, deniedTools: [] }))
    const res = runConfirmModeRetirementMigrationOnce(d)
    expect(res.migrated).toBe(false)
    expect(res.status).toBe('done')
    const after = JSON.parse(getConfigValue(d, 'config.tools')!) as Record<string, unknown>
    expect(after.enabled).toBe(true)
  })

  it('版本标记已存在：跳过不再解析（幂等）', () => {
    const d = db()
    setConfigValue(d, CONFIRM_MODE_RETIREMENT_MIGRATION_VERSION_KEY, '1')
    setConfigValue(d, 'config.tools', JSON.stringify({ confirmMode: 'diff' }))
    const res = runConfirmModeRetirementMigrationOnce(d)
    expect(res.status).toBe('skipped')
    expect('confirmMode' in (JSON.parse(getConfigValue(d, 'config.tools')!) as Record<string, unknown>)).toBe(true)
  })

  it('tools JSON 损坏：不抛错、不写 tools、仍落版本标记（fail-safe）', () => {
    const d = db()
    setConfigValue(d, 'config.tools', '{not-json')
    const res = runConfirmModeRetirementMigrationOnce(d)
    expect(res.status).toBe('done')
    expect(res.migrated).toBe(false)
    expect(getConfigValue(d, 'config.tools')).toBe('{not-json')
    expect(getConfigValue(d, CONFIRM_MODE_RETIREMENT_MIGRATION_VERSION_KEY)).toBe('1')
  })

  it('rawToolsContainConfirmMode：宽松解析（损坏/缺省 false）', () => {
    expect(rawToolsContainConfirmMode('{"enabled":true,"confirmMode":"auto"}')).toBe(true)
    expect(rawToolsContainConfirmMode('{"enabled":true}')).toBe(false)
    expect(rawToolsContainConfirmMode('{bad')).toBe(false)
    expect(rawToolsContainConfirmMode(null)).toBe(false)
  })
})
