/**
 * P2-4 递归守卫（I5，硬约束）：internalConfirmExemption 引擎级标记——
 * 审批会话内 require-confirm 决策被改写为 deny（cause=recursion-blocked），不进规则集、不可配置。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { evaluateToolCallGate, type ToolCallGateArgs } from './toolCallGate'
import { openSqliteDatabase, type AppDatabase } from '../database'
import { DEFAULT_TOOLS_CONFIG, type ToolsConfig } from '../../src/shared/domainTypes'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'

const shells: AppDatabase[] = []
function openDb(): AppDatabase {
  const db = openSqliteDatabase(':memory:')
  shells.push(db)
  return db
}

afterEach(() => {
  shells.splice(0).forEach((db) => db.close())
})

function base(overrides: Partial<ToolCallGateArgs> = {}): ToolCallGateArgs {
  return {
    toolName: 'write_file',
    toolInput: { path: 'a.txt', content: 'x' },
    sessionId: 's-recursion',
    workDir: '/tmp/wd',
    userDataDir: '/tmp/ud',
    lane: 'automation',
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, deniedTools: [] } as ToolsConfig,
    ...overrides
  }
}

function auditSink(): { record: (e: SecurityAuditEvent) => void; events: SecurityAuditEvent[] } {
  const events: SecurityAuditEvent[] = []
  return { record: (e) => events.push(e), events }
}

describe('递归守卫（I5：internalConfirmExemption）', () => {
  it('负向：审批会话内 require-confirm → 改写 deny（ruleId=recursion-guard）+ 审计 cause=recursion-blocked', async () => {
    const audit = auditSink()
    const r = await evaluateToolCallGate(base({ appDb: openDb(), audit, internalConfirmExemption: 'approval-agent' }))
    expect(r.decision.type).toBe('deny')
    if (r.decision.type === 'deny') {
      expect(r.decision.ruleId).toBe('recursion-guard')
      expect(r.decision.reason).toContain('裁决')
    }
    const ev = audit.events.find((e) => e.event === 'policy.decision')
    expect(ev?.cause).toBe('recursion-blocked')
    expect(ev?.decision).toBe('deny')
  })

  it('正向：审批会话内只读工具不产生确认（auto-allow 不受守卫影响）', async () => {
    const audit = auditSink()
    const r = await evaluateToolCallGate(
      base({
        toolName: 'read_file',
        toolInput: { path: 'a.txt' },
        appDb: openDb(),
        audit,
        internalConfirmExemption: 'approval-agent'
      })
    )
    expect(r.decision.type).toBe('auto-allow')
  })

  it('对照：无豁免标记的 automation 写操作仍是 require-confirm（守卫只认标记）', async () => {
    const r = await evaluateToolCallGate(base({ appDb: openDb() }))
    expect(r.decision.type).toBe('require-confirm')
  })

  it('deny cause 与 agent-deny 可区分：审计 reason/ruleId 携带 recursion 标识', async () => {
    const audit = auditSink()
    await evaluateToolCallGate(base({ appDb: openDb(), audit, internalConfirmExemption: 'approval-agent' }))
    const ev = audit.events.find((e) => e.event === 'policy.decision')
    expect(ev?.ruleId).toBe('recursion-guard')
    expect(ev?.reason).not.toContain('agent')
  })
})
