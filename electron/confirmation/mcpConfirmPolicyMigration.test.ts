import { afterEach, describe, expect, it } from 'vitest'
import { getConfigValue, openSqliteDatabase, setConfigValue } from '../database'
import type { AppDatabase } from '../database'
import { PolicyRuleStore } from './policyRuleStore'
import { loadEffectivePolicyRules, POLICY_PACKAGES_CONFIG_KEY, readPolicyPackages, writePolicyPackages } from './policyRulesRuntime'
import type { AuditSink } from './audit'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'
import {
  MCP_CONFIRM_POLICY_MIGRATION_VERSION,
  MCP_CONFIRM_POLICY_MIGRATION_VERSION_KEY,
  rawProfilesContainAlwaysPolicy,
  runMcpConfirmPolicyMigrationOnce
} from './mcpConfirmPolicyMigration'
import { getDbConnection } from '../database'

const dbs: AppDatabase[] = []
afterEach(() => dbs.splice(0).forEach((db) => db.close()))

function fakeAudit(): { sink: AuditSink; events: SecurityAuditEvent[] } {
  const events: SecurityAuditEvent[] = []
  return { sink: { record: (e) => events.push(e) }, events }
}

function seedProfiles(db: AppDatabase, profiles: unknown[]): void {
  setConfigValue(db, 'config.mcpServers', JSON.stringify(profiles))
}

describe('rawProfilesContainAlwaysPolicy（R5 迁移探测）', () => {
  it('任一 profile 带 toolConfirmPolicy:always → true', () => {
    expect(
      rawProfilesContainAlwaysPolicy(
        JSON.stringify([{ id: 'a', toolConfirmPolicy: 'readonly-auto' }, { id: 'b', toolConfirmPolicy: 'always' }])
      )
    ).toBe(true)
  })
  it('全部 readonly-auto / 无字段 / 空 / 损坏 JSON → false', () => {
    expect(rawProfilesContainAlwaysPolicy(JSON.stringify([{ toolConfirmPolicy: 'readonly-auto' }]))).toBe(false)
    expect(rawProfilesContainAlwaysPolicy(JSON.stringify([{ id: 'a' }]))).toBe(false)
    expect(rawProfilesContainAlwaysPolicy('[]')).toBe(false)
    expect(rawProfilesContainAlwaysPolicy(null)).toBe(false)
    expect(rawProfilesContainAlwaysPolicy('not-json')).toBe(false)
    expect(rawProfilesContainAlwaysPolicy('{}')).toBe(false)
  })
})

describe('runMcpConfirmPolicyMigrationOnce（R5 MCP 确认策略收敛迁移）', () => {
  it('存在 always profile：写入 mcp-readonly-allow→ask 覆盖，standard 链路置 custom，落审计', () => {
    const db = openSqliteDatabase(':memory:')
    dbs.push(db)
    seedProfiles(db, [
      { id: 'a', toolConfirmPolicy: 'readonly-auto' },
      { id: 'b', toolConfirmPolicy: 'always' }
    ])

    const { sink, events } = fakeAudit()
    const r = runMcpConfirmPolicyMigrationOnce(db, { audit: sink })
    expect(r.status).toBe('done')
    expect(r.migrated).toBe(true)

    const store = new PolicyRuleStore(getDbConnection(db))
    expect(store.getOverride('mcp-readonly-allow')?.action).toBe('ask')
    const packages = readPolicyPackages(db)
    expect(packages).toEqual({ desktop: 'custom', wechat: 'custom', feishu: 'custom', automation: 'custom' })

    // 生效规则：覆盖已应用（custom 套餐），行为等价原 always（只读注解工具转询问）
    const rules = loadEffectivePolicyRules(db, 'desktop')
    expect(rules.find((rule) => rule.id === 'mcp-readonly-allow')?.action).toBe('ask')

    expect(events).toHaveLength(1)
    expect(events[0]!.event.startsWith('migration.')).toBe(true)
    expect(events[0]!.actor).toBe('migration')
    expect(Number(getConfigValue(db, MCP_CONFIRM_POLICY_MIGRATION_VERSION_KEY))).toBe(
      MCP_CONFIRM_POLICY_MIGRATION_VERSION
    )
  })

  it('已有 strict/loose 套餐的链路不被改写，仅 standard 转 custom', () => {
    const db = openSqliteDatabase(':memory:')
    dbs.push(db)
    seedProfiles(db, [{ id: 'a', toolConfirmPolicy: 'always' }])
    writePolicyPackages(db, { desktop: 'strict', wechat: 'loose', feishu: 'standard', automation: 'custom' })

    const r = runMcpConfirmPolicyMigrationOnce(db)
    expect(r.migrated).toBe(true)
    expect(readPolicyPackages(db)).toEqual({
      desktop: 'strict',
      wechat: 'loose',
      feishu: 'custom',
      automation: 'custom'
    })
    // strict 链路：mcp-readonly-allow 经套餐上调已为 ask（不依赖覆盖），迁移意图天然达成
    const rules = loadEffectivePolicyRules(db, 'desktop')
    expect(rules.find((rule) => rule.id === 'mcp-readonly-allow')?.action).toBe('ask')
  })

  it('全部 readonly-auto：无需迁移，不写覆盖不动套餐不落审计，但推进版本', () => {
    const db = openSqliteDatabase(':memory:')
    dbs.push(db)
    seedProfiles(db, [{ id: 'a', toolConfirmPolicy: 'readonly-auto' }])

    const { sink, events } = fakeAudit()
    const r = runMcpConfirmPolicyMigrationOnce(db, { audit: sink })
    expect(r.status).toBe('done')
    expect(r.migrated).toBe(false)

    const store = new PolicyRuleStore(getDbConnection(db))
    expect(store.getOverride('mcp-readonly-allow')).toBeNull()
    expect(readPolicyPackages(db)).toEqual({
      desktop: 'standard',
      wechat: 'standard',
      feishu: 'standard',
      automation: 'standard'
    })
    expect(events).toHaveLength(0)
    expect(Number(getConfigValue(db, MCP_CONFIRM_POLICY_MIGRATION_VERSION_KEY))).toBe(
      MCP_CONFIRM_POLICY_MIGRATION_VERSION
    )
  })

  it('无存量 profile（新装）：done 且 migrated=false', () => {
    const db = openSqliteDatabase(':memory:')
    dbs.push(db)
    const r = runMcpConfirmPolicyMigrationOnce(db)
    expect(r.status).toBe('done')
    expect(r.migrated).toBe(false)
  })

  it('版本已是当前版本 → 跳过', () => {
    const db = openSqliteDatabase(':memory:')
    dbs.push(db)
    seedProfiles(db, [{ id: 'a', toolConfirmPolicy: 'always' }])
    expect(runMcpConfirmPolicyMigrationOnce(db).status).toBe('done')

    const second = fakeAudit()
    const r = runMcpConfirmPolicyMigrationOnce(db, { audit: second.sink })
    expect(r.status).toBe('skipped')
    expect(r.migrated).toBe(false)
    expect(second.events).toHaveLength(0)
  })

  it('失败不阻塞启动：不抛错、版本不推进，重入后完成且幂等（覆盖 upsert 唯一）', () => {
    const db = openSqliteDatabase(':memory:')
    dbs.push(db)
    seedProfiles(db, [{ id: 'a', toolConfirmPolicy: 'always' }])

    const failed = runMcpConfirmPolicyMigrationOnce(db, {
      readRawProfilesJson: () => {
        throw new Error('boom')
      }
    })
    expect(failed.status).toBe('failed')
    expect(getConfigValue(db, MCP_CONFIRM_POLICY_MIGRATION_VERSION_KEY)).toBeUndefined()

    const retried = runMcpConfirmPolicyMigrationOnce(db)
    expect(retried.status).toBe('done')
    expect(retried.migrated).toBe(true)

    // 模拟"中断后版本丢失"重跑：覆盖仍唯一（按 rule_id upsert）
    setConfigValue(db, MCP_CONFIRM_POLICY_MIGRATION_VERSION_KEY, '0')
    const again = runMcpConfirmPolicyMigrationOnce(db)
    expect(again.status).toBe('done')
    const store = new PolicyRuleStore(getDbConnection(db))
    expect(store.listOverrides().filter((o) => o.ruleId === 'mcp-readonly-allow')).toHaveLength(1)
  })

  it('事务中途写入失败：规则覆盖/套餐/版本标记均不部分落盘，修复后重跑完成', () => {
    const db = openSqliteDatabase(':memory:')
    dbs.push(db)
    seedProfiles(db, [{ id: 'a', toolConfirmPolicy: 'always' }])

    // 注入故障：套餐写入（事务中段）触发约束错误，此时规则覆盖已写入
    const conn = getDbConnection(db)
    conn.exec(
      `CREATE TRIGGER fail_policy_packages BEFORE INSERT ON configs
       WHEN NEW.key = '${POLICY_PACKAGES_CONFIG_KEY}'
       BEGIN SELECT RAISE(ABORT, 'injected failure'); END`
    )

    const failed = runMcpConfirmPolicyMigrationOnce(db)
    expect(failed.status).toBe('failed')

    // 前序写入（规则覆盖）随事务回滚，套餐与版本标记均未推进
    const store = new PolicyRuleStore(conn)
    expect(store.getOverride('mcp-readonly-allow')).toBeNull()
    expect(readPolicyPackages(db)).toEqual({
      desktop: 'standard',
      wechat: 'standard',
      feishu: 'standard',
      automation: 'standard'
    })
    expect(getConfigValue(db, MCP_CONFIRM_POLICY_MIGRATION_VERSION_KEY)).toBeUndefined()

    // 故障解除后重跑：完成且行为正确
    conn.exec('DROP TRIGGER fail_policy_packages')
    const retried = runMcpConfirmPolicyMigrationOnce(db)
    expect(retried.status).toBe('done')
    expect(retried.migrated).toBe(true)
    expect(store.getOverride('mcp-readonly-allow')?.action).toBe('ask')
    expect(readPolicyPackages(db)).toEqual({
      desktop: 'custom',
      wechat: 'custom',
      feishu: 'custom',
      automation: 'custom'
    })
    expect(Number(getConfigValue(db, MCP_CONFIRM_POLICY_MIGRATION_VERSION_KEY))).toBe(
      MCP_CONFIRM_POLICY_MIGRATION_VERSION
    )
  })
})
