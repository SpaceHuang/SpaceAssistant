import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getLocale: vi.fn(() => 'zh-CN') } }))
vi.mock('../agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn(),
  logAgentError: vi.fn()
}))
import { evaluateToolCallGate, validatePolicyRulesFloor, type ToolCallGateArgs } from './toolCallGate'
import { openSqliteDatabase, getDbConnection, type AppDatabase } from '../database'
import { SqliteDecisionCache } from './sqliteDecisionCache'
import { PolicyRuleStore } from './policyRuleStore'
import { loadEffectivePolicyRules, resolveEffectivePolicyRulesWithOrigin } from './policyRulesRuntime'
import { writePolicyPackages } from './policyRulesRuntime'
import { touchTrustedCommand } from '../shell/shellCommandTrust'
import { DEFAULT_TOOLS_CONFIG, type ToolsConfig } from '../../src/shared/domainTypes'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'
import { assembleInvocation } from '../runtime/invocationAssembler'

/**
 * P3（偏差 3 语义收口）：
 * - 门控入口底线校验：传入规则集相对 locked 底线「可收紧不可放宽」，违规 → deny(rules-violated) + cause 审计
 * - 嵌套调用相对父调用取交集（放行集合只收窄；授权不继承——替换 + 上界）
 * - 规则来源标注：builtin / package / user-override + 被遮蔽痕迹
 */

const shells: AppDatabase[] = []
function openDb(): AppDatabase {
  const db = openSqliteDatabase(':memory:')
  shells.push(db)
  return db
}

afterEach(() => {
  shells.splice(0).forEach((db) => db.close())
})

const toolsConfig = (overrides: Partial<ToolsConfig> = {}): ToolsConfig => ({
  ...DEFAULT_TOOLS_CONFIG,
  deniedTools: [],
  ...overrides
})

function auditSink(): { record: (e: SecurityAuditEvent) => void; events: SecurityAuditEvent[] } {
  const events: SecurityAuditEvent[] = []
  return { record: (e) => events.push(e), events }
}

function gateMaterials(db: AppDatabase) {
  const audit = auditSink()
  return {
    audit,
    effectiveRules: loadEffectivePolicyRules(db, 'desktop'),
    decisionCache: new SqliteDecisionCache(getDbConnection(db)),
    shellPrecheck: { touchTrustedCommand: (command: string) => touchTrustedCommand(db, command) }
  }
}

function base(db: AppDatabase, overrides: Partial<ToolCallGateArgs> = {}): ToolCallGateArgs {
  const m = gateMaterials(db)
  return {
    toolName: 'read_file',
    toolInput: { path: 'a.txt' },
    sessionId: 's1',
    workDir: '/tmp/wd',
    userDataDir: '/tmp/ud',
    toolsConfig: toolsConfig(),
    audit: m.audit,
    effectiveRules: m.effectiveRules,
    decisionCache: m.decisionCache,
    shellPrecheck: m.shellPrecheck,
    ...overrides
  }
}

describe('validatePolicyRulesFloor（locked 底线校验，纯函数）', () => {
  it('默认规则集通过校验', () => {
    expect(validatePolicyRulesFloor(DEFAULT_POLICY_RULES)).toEqual({ ok: true })
  })

  it('locked 条目动作被放宽 → 违规（列出条目 id）', () => {
    const relaxed = DEFAULT_POLICY_RULES.map((r) =>
      r.id === 'remote-shell-disabled' ? { ...r, action: 'allow' as const } : r
    )
    const res = validatePolicyRulesFloor(relaxed)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.violations).toContain('remote-shell-disabled')
  })

  it('locked 条目缺失 → 违规（移除保护等价放宽）', () => {
    const dropped = DEFAULT_POLICY_RULES.filter((r) => r.id !== 'remote-shell-disabled')
    const res = validatePolicyRulesFloor(dropped)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.violations).toContain('remote-shell-disabled')
  })

  it('非 locked 条目放宽不构成违规（底线只管 locked）', () => {
    const relaxed = DEFAULT_POLICY_RULES.map((r) =>
      r.id === 'mcp-readonly-allow' ? { ...r, action: 'allow' as const } : r
    )
    expect(validatePolicyRulesFloor(relaxed)).toEqual({ ok: true })
  })
})

describe('evaluateToolCallGate 底线违规拒绝（cause 可区分）', () => {
  it('传入放宽 locked 的规则集 → deny(rules-violated) + cause=rules-violated 审计', async () => {
    const db = openDb()
    const m = gateMaterials(db)
    const relaxed = m.effectiveRules.map((r) =>
      r.locked ? { ...r, action: 'allow' as const } : r
    )
    const r = await evaluateToolCallGate(base(db, {
      audit: m.audit,
      effectiveRules: relaxed,
      decisionCache: m.decisionCache,
      shellPrecheck: m.shellPrecheck,
      remoteContext: { source: 'feishu', messageId: 'm1', confirmPolicy: 'always' } as never,
      toolName: 'run_shell',
      toolInput: { command: 'echo hi' }
    }))
    expect(r.decision.type).toBe('deny')
    if (r.decision.type === 'deny') expect(r.decision.ruleId).toBe('rules-violated')
    const evt = m.audit.events.find((e) => e.event === 'policy.decision')
    expect(evt).toMatchObject({ cause: 'rules-violated', decision: 'deny' })
  })
})

describe('嵌套调用规则交集（放行集合取交集，授权不继承）', () => {
  it('装配器 policyRuleFloor：内层 allow 条目被父 ask 收严；floor 特有保护条目保留', () => {
    const db = openDb()
    const parentFloor = DEFAULT_POLICY_RULES.map((r) =>
      r.id === 'desktop-auto-approve' ? { ...r, action: 'ask' as const } : r
    )
    const { ports } = assembleInvocation({
      requestId: 'r-nest', sessionId: 's-nest', model: 'm',
      messages: [{ role: 'user', content: 'x' }] as never,
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp',
      getApiKey: async () => 'k', appDb: db,
      policyRuleFloor: parentFloor,
      emitFactEvent: () => undefined, emitSessionEvent: async () => undefined
    } as never)
    const rules = ports.policy?.effectiveRules as import('../../src/shared/confirmation/types').PolicyRule[]
    const autoApprove = rules.find((r) => r.id === 'desktop-auto-approve')
    expect(autoApprove?.action).toBe('ask')
    // floor 的 locked 保护条目在内层不缺失
    expect(rules.some((r) => r.id === 'remote-shell-disabled' && r.locked)).toBe(true)
  })
})

describe('规则来源标注（resolveEffectivePolicyRulesWithOrigin）', () => {
  it('standard 无覆盖：全部 builtin', () => {
    const db = openDb()
    const { origins } = resolveEffectivePolicyRulesWithOrigin(db, 'desktop')
    expect(origins['remote-shell-disabled']?.source).toBe('builtin')
    expect(origins['mcp-readonly-allow']?.source).toBe('builtin')
  })

  it('custom 用户覆盖：命中条目 user-override，保留被遮蔽痕迹', () => {
    const db = openDb()
    new PolicyRuleStore(getDbConnection(db)).setOverride({ ruleId: 'mcp-readonly-allow', action: 'deny', params: {} })
    writePolicyPackages(db, { desktop: 'custom', wechat: 'custom', feishu: 'custom', automation: 'custom' })
    const { rules, origins } = resolveEffectivePolicyRulesWithOrigin(db, 'desktop')
    const readonlyRule = rules.find((r) => r.id === 'mcp-readonly-allow')
    expect(readonlyRule?.action).toBe('deny')
    expect(origins['mcp-readonly-allow']?.source).toBe('user-override')
    expect(origins['mcp-readonly-allow']?.shadowed?.[0]).toMatchObject({ source: 'builtin' })
  })
})

describe('装配期默认解析留痕（P3 收尾：内置默认只作显式数据源）', () => {
  it('无 db 宿主装配默认门控材料时落 agent.policy.default_materials 日志', async () => {
    const logAgentEvent = await import('../agentLogger/agentLogger')
    const spy = vi.mocked(logAgentEvent.logAgentEvent)
    spy.mockClear()
    assembleInvocation({
      requestId: 'r-default', sessionId: 's-default', model: 'm',
      messages: [{ role: 'user', content: 'x' }] as never,
      toolsConfig: DEFAULT_TOOLS_CONFIG, workDir: '/tmp', userDataDir: '/tmp',
      getApiKey: async () => 'k',
      emitFactEvent: () => undefined, emitSessionEvent: async () => undefined
    } as never)
    expect(spy).toHaveBeenCalledWith('info', 'agent.policy.default_materials', expect.objectContaining({
      requestId: 'r-default',
      reason: 'no-database-host'
    }))
  })
})
