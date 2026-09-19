import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluateToolCallGate, type ToolCallGateArgs } from './toolCallGate'
import { openSqliteDatabase, getDbConnection, type AppDatabase } from '../database'
import { SqliteDecisionCache } from './sqliteDecisionCache'
import { loadEffectivePolicyRules } from './policyRulesRuntime'
import { touchTrustedCommand } from '../shell/shellCommandTrust'
import { DEFAULT_TOOLS_CONFIG, type ToolsConfig } from '../../src/shared/domainTypes'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'

/**
 * P5（偏差 4）：factsProvider 端口与裁决位收口。
 * - 确认事实 = 工具契约事实 ∪ factsProvider 补充，逐项标注来源半区；
 * - 「声明为空」与「忘了声明（未提供端口）」必须可区分；
 * - AutoEvaluator 数据化：预过滤器路由由规则数据（match.toolName + lane）驱动，不再是代码分支。
 */

vi.mock('electron', () => ({ app: { getLocale: vi.fn(() => 'zh-CN') } }))
vi.mock('../agentLogger/agentLogger', () => ({ logAgentEvent: vi.fn(), logAgentError: vi.fn() }))

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

function base(db: AppDatabase, overrides: Partial<ToolCallGateArgs> = {}): ToolCallGateArgs {
  const audit = auditSink()
  return {
    toolName: 'read_file',
    toolInput: { path: 'a.txt' },
    sessionId: 's1',
    workDir: '/tmp/wd',
    userDataDir: '/tmp/ud',
    toolsConfig: toolsConfig(),
    audit,
    effectiveRules: loadEffectivePolicyRules(db, 'desktop'),
    decisionCache: new SqliteDecisionCache(getDbConnection(db)),
    shellPrecheck: { touchTrustedCommand: (command: string) => touchTrustedCommand(db, command) },
    ...overrides
  }
}

describe('factsProvider 端口（P5）', () => {
  it('宿主补充信号并入 facts.signals 且标注来源半区 host-environment', async () => {
    const db = openDb()
    const r = await evaluateToolCallGate(base(db, {
      toolName: 'write_file',
      toolInput: { path: 'x.txt', content: 'v' },
      factsProvider: () => [
        { kind: 'host-fact-probe', detail: 'host provided' } as never
      ]
    }))
    const kinds = r.facts.signals.map((s) => s.kind)
    expect(kinds).toContain('host-fact-probe')
    expect(r.facts.factSources?.['host-fact-probe']).toBe('host-environment')
    // 工具契约事实仍在（write_file 的默认信号）
    expect(r.facts.factSources && Object.values(r.facts.factSources)).toContain('tool-contract')
  })

  it('声明为空（返回 []）与忘了声明（未提供端口）可区分', async () => {
    const db = openDb()
    const declaredEmpty = await evaluateToolCallGate(base(db, { factsProvider: () => [] }))
    expect(declaredEmpty.facts.factsProviderDeclared).toBe(true)

    const notDeclared = await evaluateToolCallGate(base(db, {}))
    expect(notDeclared.facts.factsProviderDeclared).toBe(false)
  })

  it('审计 policy.decision 携带事实来源标注（可回答「结论基于谁提供的事实」）', async () => {
    const db = openDb()
    const audit = auditSink()
    await evaluateToolCallGate(base(db, {
      audit,
      toolName: 'write_file',
      toolInput: { path: 'x.txt', content: 'v' },
      factsProvider: () => [{ kind: 'host-fact-probe' } as never]
    }))
    const evt = audit.events.find((e) => e.event === 'policy.decision')
    expect(evt).toBeDefined()
    expect((evt as unknown as { factSources?: Record<string, string> }).factSources?.['host-fact-probe']).toBe('host-environment')
  })
})

describe('AutoEvaluator 数据化（P5：预过滤器路由由规则数据驱动）', () => {
  it('等价性：desktop-auto-approve 规则在 → confirmMode=auto 批准 write_file（auto-allow）', async () => {
    const db = openDb()
    const r = await evaluateToolCallGate(base(db, {
      toolName: 'write_file',
      toolInput: { path: 'x.txt', content: 'v' },
      toolsConfig: { ...toolsConfig(), confirmMode: 'auto' },
      fileAutoApproval: async () => ({ approve: true, reason: 'ok', reasonCode: 'ok' })
    }))
    expect(r.decision.type).toBe('auto-allow')
    if (r.decision.type === 'auto-allow') expect(r.decision.ruleId).toBe('desktop-auto-approve')
  })

  it('数据驱动：规则集移除 desktop-auto-approve 条目 → write_file 不再走自动审批（落 ask）', async () => {
    const db = openDb()
    const rules = loadEffectivePolicyRules(db, 'desktop').filter((rule) => rule.id !== 'desktop-auto-approve')
    const r = await evaluateToolCallGate(base(db, {
      toolName: 'write_file',
      toolInput: { path: 'x.txt', content: 'v' },
      toolsConfig: { ...toolsConfig(), confirmMode: 'auto' },
      fileAutoApproval: async () => ({ approve: true, reason: 'ok', reasonCode: 'ok' }),
      effectiveRules: rules
    }))
    // 规则数据不在 → 预过滤器不路由 → 评估器不批准 → 落默认表 require-confirm
    expect(r.decision.type).toBe('require-confirm')
  })

  it('数据驱动：shell-precheck-auto-allow 规则移除 → 预检放行不再 auto-allow', async () => {
    const db = openDb()
    const rules = loadEffectivePolicyRules(db, 'desktop').filter((rule) => rule.id !== 'shell-precheck-auto-allow')
    const r = await evaluateToolCallGate(base(db, {
      toolName: 'run_shell',
      toolInput: { command: 'ping baidu.com' },
      effectiveRules: rules,
      runShellPrecheck: async () => ({
        ok: true,
        analysis: { verdict: 'allow' } as never,
        legacyAutoAllowEligible: true,
        legacyPolicy: { permissionDecision: 'allow', trustedCacheKeys: [] },
        hints: {} as never
      })
    }))
    expect(r.decision.type).toBe('require-confirm')
  })
})
