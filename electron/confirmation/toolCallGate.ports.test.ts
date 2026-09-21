import { afterEach, describe, expect, it } from 'vitest'
import { evaluateToolCallGate, type ToolCallGateArgs } from './toolCallGate'
import { openSqliteDatabase, getDbConnection, type AppDatabase } from '../database'
import { SqliteDecisionCache, canonicalKeyJson } from './sqliteDecisionCache'
import { loadEffectivePolicyRules } from './policyRulesRuntime'
import { persistShellConfig, readShellConfigFromDb } from '../shell/shellConfigDb'
import { DEFAULT_TOOLS_CONFIG, type ToolsConfig, type TrustedShellCommand } from '../../src/shared/domainTypes'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'
import { touchTrustedCommand } from '../shell/shellCommandTrust'

/**
 * P2 门控入参端口化（B1 修订）：evaluateToolCallGate 不再持有 appDb——
 * 必填 effectiveRules / decisionCache / shellPrecheck 由装配期解析注入；
 * 缺料 = 调用失败（fail-loud）+ 审计，不回退任何静默默认。
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

const readonlyEntry = {
  serverId: 'srv1',
  serverName: 'Srv',
  originalName: 'list_issues',
  mappedName: 'mcp__srv1__list_issues',
  description: '',
  inputSchema: {},
  annotations: { readOnlyHint: true }
}

/** 装配期等价物：从 db 解析门控端口材料（与 invocationAssembler 同一机制的最小内联版） */
function gateMaterialsFromDb(db: AppDatabase, lane: 'desktop' | 'automation' = 'desktop') {
  const audit = auditSink()
  return {
    audit,
    effectiveRules: loadEffectivePolicyRules(db, lane),
    decisionCache: new SqliteDecisionCache(getDbConnection(db)),
    shellPrecheck: {
      touchTrustedCommand: (command: string) => {
        touchTrustedCommand(db, command)
      }
    }
  }
}

function base(overrides: Partial<ToolCallGateArgs> = {}): ToolCallGateArgs {
  const db = openDb()
  const materials = gateMaterialsFromDb(db)
  return {
    toolName: 'read_file',
    toolInput: { path: 'a.txt' },
    sessionId: 's1',
    workDir: '/tmp/wd',
    userDataDir: '/tmp/ud',
    toolsConfig: toolsConfig(),
    audit: materials.audit,
    effectiveRules: materials.effectiveRules,
    decisionCache: materials.decisionCache,
    shellPrecheck: materials.shellPrecheck,
    ...overrides
  }
}

describe('evaluateToolCallGate 端口化缺料 fail-loud（B1）', () => {
  it('缺 effectiveRules → 调用失败 + 审计 cause 可区分，不回退 DEFAULT_POLICY_RULES', async () => {
    const audit = auditSink()
    const args = base({ audit })
    const broken = { ...args, effectiveRules: undefined } as never
    await expect(evaluateToolCallGate(broken)).rejects.toThrow('TOOL_GATE_MATERIALS_MISSING')
    const evt = audit.events.find((e) => e.event === 'policy.decision' && e.ruleId === 'gate-materials-missing')
    expect(evt).toMatchObject({ toolName: 'read_file', decision: 'deny' })
  })

  it('缺 decisionCache 视图 → 调用失败 + 审计（EMPTY_CACHE 静默回退已消除）', async () => {
    const audit = auditSink()
    const args = base({ audit })
    const broken = { ...args, decisionCache: undefined } as never
    await expect(evaluateToolCallGate(broken)).rejects.toThrow('TOOL_GATE_MATERIALS_MISSING')
    expect(audit.events.some((e) => e.event === 'policy.decision' && e.ruleId === 'gate-materials-missing')).toBe(true)
  })

  it('缺 shellPrecheck 材料 → 调用失败 + 审计（trusted-command 停写不再静默）', async () => {
    const audit = auditSink()
    const args = base({ audit })
    const broken = { ...args, shellPrecheck: undefined } as never
    await expect(evaluateToolCallGate(broken)).rejects.toThrow('TOOL_GATE_MATERIALS_MISSING')
    expect(audit.events.some((e) => e.event === 'policy.decision' && e.ruleId === 'gate-materials-missing')).toBe(true)
  })
})

describe('evaluateToolCallGate 端口语义等价（与 appDb 路径同判）', () => {
  it('effectiveRules 携带 custom 覆盖 → 覆盖生效（mcp-readonly-allow → ask）', async () => {
    const db = openDb()
    // 装配期解析（在 db 写入覆盖后）——与 loadEffectivePolicyRules(appDb, lane) 等价
    const { PolicyRuleStore } = await import('./policyRuleStore')
    const { writePolicyPackages } = await import('./policyRulesRuntime')
    new PolicyRuleStore(getDbConnection(db)).setOverride({ ruleId: 'mcp-readonly-allow', action: 'ask', params: {} })
    writePolicyPackages(db, { desktop: 'custom', wechat: 'custom', feishu: 'custom', automation: 'custom' })
    const materials = gateMaterialsFromDb(db)

    const r = await evaluateToolCallGate(base({
      toolName: readonlyEntry.mappedName,
      toolInput: {},
      mcpEntry: readonlyEntry,
      audit: materials.audit,
      effectiveRules: materials.effectiveRules,
      decisionCache: materials.decisionCache,
      shellPrecheck: materials.shellPrecheck
    }))
    expect(r.decision.type).toBe('require-confirm')
  })

  it('decisionCache 播种会话信任 → cache-hit 放行 + 审计', async () => {
    const db = openDb()
    const key = { kind: 'mcp-tool' as const, serverId: 'srv1', toolName: 'list_issues', sessionId: 's1' }
    const now = Date.now()
    new SqliteDecisionCache(getDbConnection(db)).record({
      id: canonicalKeyJson(key), key, decision: 'allow', lane: 'desktop', scope: 'session',
      createdAt: now, lastHitAt: now, hitCount: 0, source: 'user-confirm'
    })
    const materials = gateMaterialsFromDb(db)

    const r = await evaluateToolCallGate(base({
      toolName: readonlyEntry.mappedName,
      toolInput: {},
      mcpEntry: readonlyEntry,
      audit: materials.audit,
      effectiveRules: materials.effectiveRules,
      decisionCache: materials.decisionCache,
      shellPrecheck: materials.shellPrecheck
    }))
    expect(r.decision.type).toBe('auto-allow')
    if (r.decision.type === 'auto-allow') expect(r.decision.ruleId).toBe('cache-hit')
    expect(materials.audit.events.some((e) => e.event === 'cache.hit')).toBe(true)
  })

  it('shellPrecheck 端口接管 trusted-command touch：预检放行时记账写发生', async () => {
    const trusted: TrustedShellCommand = {
      id: 't1', schemaVersion: 2, executable: 'git', fixedArgvPrefix: ['status'],
      trailingArgv: 'exact', createdAt: 1, lastUsedAt: 0
    }
    const db = openDb()
    persistShellConfig(db, { trustedCommands: [{ ...trusted, lastUsedAt: 0 }] })
    const materials = gateMaterialsFromDb(db)
    const shellConfig = { enabled: true, shellDefaultTimeoutSec: 300, trustedCommands: [trusted] }

    const r = await evaluateToolCallGate(base({
      toolName: 'run_shell',
      toolInput: { command: 'git status' },
      shellConfig: shellConfig as never,
      audit: materials.audit,
      effectiveRules: materials.effectiveRules,
      decisionCache: materials.decisionCache,
      shellPrecheck: materials.shellPrecheck
    }))
    expect(r.decision.type).toBe('auto-allow')
    const persisted = readShellConfigFromDb(db).trustedCommands?.find((t) => t.id === 't1')
    expect(persisted?.lastUsedAt ?? 0).toBeGreaterThan(0)
  })

  it('裁决顺序特征化保留：deny 覆盖落 ask 后，既有 allow 缓存仍可放行', async () => {
    const db = openDb()
    const { PolicyRuleStore } = await import('./policyRuleStore')
    const { writePolicyPackages } = await import('./policyRulesRuntime')
    new PolicyRuleStore(getDbConnection(db)).setOverride({ ruleId: 'mcp-readonly-allow', action: 'deny', params: {} })
    writePolicyPackages(db, { desktop: 'custom', wechat: 'custom', feishu: 'custom', automation: 'custom' })

    const noCacheMaterials = gateMaterialsFromDb(db)
    const noCache = await evaluateToolCallGate(base({
      toolName: readonlyEntry.mappedName, toolInput: {}, mcpEntry: readonlyEntry,
      audit: noCacheMaterials.audit, effectiveRules: noCacheMaterials.effectiveRules,
      decisionCache: noCacheMaterials.decisionCache, shellPrecheck: noCacheMaterials.shellPrecheck
    }))
    expect(noCache.decision.type).toBe('require-confirm')

    const key = { kind: 'mcp-tool' as const, serverId: 'srv1', toolName: 'list_issues', sessionId: 's1' }
    const now = Date.now()
    new SqliteDecisionCache(getDbConnection(db)).record({
      id: canonicalKeyJson(key), key, decision: 'allow', lane: 'desktop', scope: 'session',
      createdAt: now, lastHitAt: now, hitCount: 0, source: 'user-confirm'
    })
    const withCacheMaterials = gateMaterialsFromDb(db)
    const withCache = await evaluateToolCallGate(base({
      toolName: readonlyEntry.mappedName, toolInput: {}, mcpEntry: readonlyEntry,
      audit: withCacheMaterials.audit, effectiveRules: withCacheMaterials.effectiveRules,
      decisionCache: withCacheMaterials.decisionCache, shellPrecheck: withCacheMaterials.shellPrecheck
    }))
    expect(withCache.decision.type).toBe('auto-allow')
    if (withCache.decision.type === 'auto-allow') expect(withCache.decision.ruleId).toBe('cache-hit')
  })
})
