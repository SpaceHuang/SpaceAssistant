import { afterEach, describe, expect, it } from 'vitest'
import { getDbConnection, openSqliteDatabase } from '../database'
import type { AppDatabase } from '../database'
import { PolicyRuleStore } from './policyRuleStore'

const dbs: AppDatabase[] = []
afterEach(() => dbs.splice(0).forEach((db) => db.close()))

function store(): PolicyRuleStore {
  const db = openSqliteDatabase(':memory:')
  dbs.push(db)
  return new PolicyRuleStore(getDbConnection(db))
}

describe('PolicyRuleStore（policy_rules 表）', () => {
  it('setOverride → getOverride 往返（幂等 upsert）', () => {
    const s = store()
    s.setOverride({ ruleId: 'im-write-ask', action: 'allow', params: {} })
    const o = s.getOverride('im-write-ask')
    expect(o).not.toBeNull()
    expect(o!.action).toBe('allow')
    // 再次设置同 ruleId → 更新而非新增
    s.setOverride({ ruleId: 'im-write-ask', action: 'deny', params: {} })
    expect(s.getOverride('im-write-ask')!.action).toBe('deny')
    expect(s.listOverrides()).toHaveLength(1)
  })

  it('applyOverrides 把覆盖 action 合并回默认规则', () => {
    const s = store()
    s.setOverride({ ruleId: 'im-write-ask', action: 'allow', params: {} })
    const rules = [{ id: 'im-write-ask', when: 'invocation', action: 'ask', reason: 'r' } as const]
    const merged = s.applyOverrides(rules as never[])
    expect(merged[0]!.action).toBe('allow')
  })

  it('removeOverride 删除覆盖', () => {
    const s = store()
    s.setOverride({ ruleId: 'x', action: 'deny', params: {} })
    expect(s.removeOverride('x')).toBe(1)
    expect(s.getOverride('x')).toBeNull()
  })
})
