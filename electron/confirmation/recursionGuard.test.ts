/**
 * P2-4 递归守卫（I5，硬约束）：internalConfirmExemption 引擎级标记——
 * 审批会话内 require-confirm 决策被改写为 deny（cause=recursion-blocked），不进规则集、不可配置。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { loadEffectivePolicyRules } from './policyRulesRuntime'
import { SqliteDecisionCache } from './sqliteDecisionCache'
import { getDbConnection, openSqliteDatabase, type AppDatabase } from '../database'
import { touchTrustedCommand } from '../shell/shellCommandTrust'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { evaluateToolCallGate, type ToolCallGateArgs } from './toolCallGate'
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


/** P2（B1）：把旧的 appDb 覆盖项装配为门控端口材料；无 db 时提供显式默认材料（原静默回退的显式化）。 */
function gateMaterialsFor(db: AppDatabase | undefined, lane: import('../../src/shared/confirmation/types').ExecutionLane) {
  if (db) {
    return {
      effectiveRules: loadEffectivePolicyRules(db, lane),
      decisionCache: new SqliteDecisionCache(getDbConnection(db)),
      shellPrecheck: { touchTrustedCommand: (command: string) => touchTrustedCommand(db, command) }
    }
  }
  return {
    effectiveRules: DEFAULT_POLICY_RULES,
    decisionCache: {
      lookup: () => null,
      record: () => undefined,
      clear: () => 0,
      clearAllSession: () => 0,
      expireDormant: () => 0
    },
    shellPrecheck: { touchTrustedCommand: () => undefined }
  }
}

function base(overrides: Partial<ToolCallGateArgs> = {}): ToolCallGateArgs {
  const legacyDb = (overrides as { appDb?: AppDatabase }).appDb
  const { appDb: _legacyAppDb, ...rest } = overrides as Partial<ToolCallGateArgs> & { appDb?: AppDatabase }
  const lane = (overrides as { lane?: import('../../src/shared/confirmation/types').ExecutionLane }).lane
    ?? (overrides.remoteContext
      ? overrides.remoteContext.source === 'feishu'
        ? 'feishu'
        : 'wechat'
      : 'desktop')
  return {
    toolName: 'write_file',
    toolInput: { path: 'a.txt', content: 'x' },
    sessionId: 's-recursion',
    workDir: '/tmp/wd',
    userDataDir: '/tmp/ud',
    lane: 'automation',
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, deniedTools: [] } as ToolsConfig,
    ...gateMaterialsFor(legacyDb, lane),
    ...rest
  }
}

function auditSink(): { record: (e: SecurityAuditEvent) => void; events: SecurityAuditEvent[] } {
  const events: SecurityAuditEvent[] = []
  return { record: (e) => events.push(e), events }
}

describe('递归守卫（I5：internalConfirmExemption）', () => {
  it('负向：审批会话内 require-confirm → 改写 deny（ruleId=recursion-guard）+ 审计 cause=recursion-blocked', async () => {
    const audit = auditSink()
    const r = await evaluateToolCallGate(base({ toolName: 'unregistered_tool', toolInput: {}, appDb: openDb(), audit, internalConfirmExemption: 'approval-agent' }))
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
    const r = await evaluateToolCallGate(base({ toolName: 'unregistered_tool', toolInput: {}, appDb: openDb() }))
    expect(r.decision.type).toBe('require-confirm')
  })

  it('deny cause 与 agent-deny 可区分：审计 reason/ruleId 携带 recursion 标识', async () => {
    const audit = auditSink()
    await evaluateToolCallGate(base({ toolName: 'unregistered_tool', toolInput: {}, appDb: openDb(), audit, internalConfirmExemption: 'approval-agent' }))
    const ev = audit.events.find((e) => e.event === 'policy.decision')
    expect(ev?.ruleId).toBe('recursion-guard')
    expect(ev?.reason).not.toContain('agent')
  })
})
