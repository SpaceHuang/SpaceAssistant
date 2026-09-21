import { afterEach, describe, expect, it } from 'vitest'
import { loadEffectivePolicyRules, readPolicyPackages } from './policyRulesRuntime'
import { SqliteDecisionCache } from './sqliteDecisionCache'
import { getDbConnection, openSqliteDatabase, type AppDatabase } from '../database'
import { touchTrustedCommand } from '../shell/shellCommandTrust'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { evaluateToolCallGate, type ToolCallGateArgs } from './toolCallGate'
import { canonicalKeyJson } from './sqliteDecisionCache'
import { PolicyRuleStore } from './policyRuleStore'
import { writePolicyPackages } from './policyRulesRuntime'
import { createRemoteTaskBudgetState } from '../remote/remoteTaskBudget'
import { resetRunningRemoteAgentRegistryForTests } from '../remote/remoteAgentRegistry'
import type { RemoteContext } from '../tools/types'
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
  resetRunningRemoteAgentRegistryForTests()
})

const toolsConfig = (overrides: Partial<ToolsConfig> = {}): ToolsConfig => ({
  ...DEFAULT_TOOLS_CONFIG,
  deniedTools: [],
  ...overrides
})

const remoteContext = (overrides: Partial<RemoteContext> = {}): RemoteContext => ({
  source: 'feishu',
  messageId: 'm1',
  confirmPolicy: 'im_confirm',
  ...overrides
})


/** P2（B1）：把旧的 appDb 覆盖项装配为门控端口材料；无 db 时提供显式默认材料（原静默回退的显式化）。 */
function gateMaterialsFor(db: AppDatabase | undefined, lane: import('../../src/shared/confirmation/types').ExecutionLane) {
  if (db) {
    return {
      effectiveRules: loadEffectivePolicyRules(db, lane),
      lanePackage: readPolicyPackages(db)[lane] ?? 'standard',
      decisionCache: new SqliteDecisionCache(getDbConnection(db)),
      shellPrecheck: { touchTrustedCommand: (command: string) => touchTrustedCommand(db, command) }
    }
  }
  return {
    effectiveRules: DEFAULT_POLICY_RULES,
    lanePackage: 'standard',
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
    toolName: 'read_file',
    toolInput: { path: 'a.txt' },
    sessionId: 's1',
    workDir: '/tmp/wd',
    userDataDir: '/tmp/ud',
    toolsConfig: toolsConfig(),
    audit: { record: () => undefined },
    ...gateMaterialsFor(legacyDb, lane),
    ...rest
  }
}

function auditSink(): { record: (e: SecurityAuditEvent) => void; events: SecurityAuditEvent[] } {
  const events: SecurityAuditEvent[] = []
  return { record: (e) => events.push(e), events }
}

describe('evaluateToolCallGate', () => {
  it('桌面 read_file：默认表 read → auto-allow，落 policy.decision 审计', async () => {
    const audit = auditSink()
    const r = await evaluateToolCallGate(base({ audit }))
    expect(r.decision.type).toBe('auto-allow')
    const ev = audit.events.find((e) => e.event === 'policy.decision')
    expect(ev).toBeTruthy()
    expect(ev!.lane).toBe('desktop')
    expect(ev!.decision).toBe('auto-allow')
    // P0-4 归因收窄：policy.decision 发生在询问之前，此刻不存在回答者，actor 保持 system
    expect(ev!.actor).toBe('system')
  })

  it('桌面 write_file（standard「自动」）：快通道批准 → auto-allow(default-write-execute-ask 经 transform)', async () => {
    const r = await evaluateToolCallGate(
      base({
        toolName: 'write_file',
        toolInput: { path: 'a.txt', content: 'x' },
        fileAutoApproval: async () => ({ approve: true })
      })
    )
    expect(r.decision.type).toBe('auto-allow')
    expect(r.decision.ruleId).toBe('default-write-execute-ask')
  })

  it('桌面 write_file 快通道拒绝 → require-confirm(agent) + fallback', async () => {
    const r = await evaluateToolCallGate(
      base({
        toolName: 'write_file',
        toolInput: { path: 'a.txt', content: 'x' },
        fileAutoApproval: async () => ({ approve: false, reason: '过大', reasonCode: 'oversize' })
      })
    )
    expect(r.decision.type).toBe('require-confirm')
    expect(r.autoApproveFallback?.reasonCode).toBe('oversize')
  })

  it('桌面 write_file 未过快通道 → require-confirm(answerer=agent)，带 path 记忆档位', async () => {
    const r = await evaluateToolCallGate(
      base({
        toolName: 'write_file',
        toolInput: { path: 'a.txt', content: 'x' },
        fileAutoApproval: async () => ({ approve: false, reason: '过大', reasonCode: 'oversize' })
      })
    )
    expect(r.decision.type).toBe('require-confirm')
    if (r.decision.type === 'require-confirm') {
      expect(r.decision.answerer).toBe('agent')
      expect(r.decision.memoryTiers.length).toBeGreaterThan(0)
    }
  })

  it('run_shell 预检 deny → gate 前置短路（shellPrecheckDeny），不进引擎', async () => {
    const audit = auditSink()
    const r = await evaluateToolCallGate(
      base({
        toolName: 'run_shell',
        toolInput: { command: 'rm -rf /' },
        audit,
        runShellPrecheck: async () => ({
          ok: false,
          error: '命令未通过安全检查',
          auditReason: 'security_deny',
          denyType: 'strong'
        })
      })
    )
    expect(r.decision.type).toBe('deny')
    expect(r.decision.ruleId).toBe('shell-precheck-deny')
    expect(r.shellPrecheckDeny?.error).toBe('命令未通过安全检查')
    // 审计断点修复：最高频的硬拒也必须落 policy.decision（"判定即记录"）
    const evt = audit.events.find((e) => e.event === 'policy.decision')
    expect(evt).toBeDefined()
    expect(evt).toMatchObject({
      decision: 'deny',
      ruleId: 'shell-precheck-deny',
      toolName: 'run_shell',
      reason: 'security_deny'
    })
  })

  it('run_shell 预检 skipConfirm → auto-allow(shell-precheck-auto-allow)', async () => {
    const r = await evaluateToolCallGate(
      base({
        toolName: 'run_shell',
        toolInput: { command: 'ping baidu.com' },
        runShellPrecheck: async () => ({
          ok: true,
          analysis: { verdict: 'allow' } as never,
          legacyAutoAllowEligible: true,
          legacyPolicy: { permissionDecision: 'allow', trustedCacheKeys: [] },
          hints: {} as never
        })
      })
    )
    expect(r.decision.type).toBe('auto-allow')
    expect(r.decision.ruleId).toBe('shell-precheck-auto-allow')
  })

  it('run_shell 预检不跳过 → require-confirm', async () => {
    const r = await evaluateToolCallGate(
      base({
        toolName: 'run_shell',
        toolInput: { command: 'make deploy' },
        runShellPrecheck: async () => ({
          ok: true,
          analysis: { verdict: 'ask' } as never,
          legacyAutoAllowEligible: false,
          legacyPolicy: { permissionDecision: 'ask', trustedCacheKeys: [] },
          hints: {} as never
        })
      })
    )
    expect(r.decision.type).toBe('require-confirm')
  })

  it('远程 run_shell → locked deny(remote-shell-disabled)', async () => {
    const r = await evaluateToolCallGate(
      base({
        toolName: 'run_shell',
        toolInput: { command: 'ls' },
        remoteContext: remoteContext(),
        runShellPrecheck: async () => ({
          ok: true,
          analysis: { verdict: 'allow' } as never,
          legacyAutoAllowEligible: true,
          legacyPolicy: { permissionDecision: 'allow', trustedCacheKeys: [] },
          hints: {} as never
        })
      })
    )
    expect(r.decision).toMatchObject({ type: 'deny', ruleId: 'remote-shell-disabled' })
  })

  it('远程 browser + allowRemoteSessions=false → deny(remote-browser-disabled)', async () => {
    const r = await evaluateToolCallGate(
      base({
        toolName: 'browser',
        toolInput: { action: 'navigate', url: 'https://example.com' },
        remoteContext: remoteContext(),
        browserConfig: { allowRemoteSessions: false } as never
      })
    )
    expect(r.decision).toMatchObject({ type: 'deny', ruleId: 'remote-browser-disabled' })
  })

  it('远程 lark 写 + remoteDenyOutbound → deny(remote-deny-lark-write-outbound)', async () => {
    const r = await evaluateToolCallGate(
      base({
        toolName: 'run_lark_cli',
        toolInput: { args: ['doc', 'create'] },
        remoteContext: remoteContext(),
        feishuConfig: { remoteDenyOutbound: true } as never
      })
    )
    expect(r.decision).toMatchObject({ type: 'deny', ruleId: 'remote-deny-lark-write-outbound' })
  })

  it('出站写预算耗尽 → deny(remote-outbound-budget-pause-*) + budgetPause 消息', async () => {
    const budget = createRemoteTaskBudgetState('t1')
    budget.stopped = true
    const r = await evaluateToolCallGate(
      base({
        toolName: 'wechat_send',
        toolInput: { userId: 'u1', text: 'hi' },
        remoteContext: remoteContext({ source: 'wechat' }),
        remoteBudgetState: budget
      })
    )
    expect(r.decision.type).toBe('deny')
    expect(r.decision.ruleId).toBe('remote-outbound-budget-pause-wechat')
    expect(r.budgetPause?.message).toContain('继续')
  })

  it('远程 write_file 默认（无会话写信任）→ require-confirm(im-write-ask)', async () => {
    const r = await evaluateToolCallGate(
      base({
        toolName: 'write_file',
        toolInput: { path: 'a.txt', content: 'x' },
        remoteContext: remoteContext({ requestId: 'req1', userId: 'owner1' })
      })
    )
    expect(r.decision.type).toBe('require-confirm')
    if (r.decision.type === 'require-confirm') expect(r.decision.ruleId).toBe('im-write-ask')
  })

  it('MCP 需确认工具 → require-confirm(mcp-tool-ask)；缓存命中后 → auto-allow(cache-hit)', async () => {
    const db = openDb()
    const mcpEntry = {
      serverId: 'srv1',
      serverName: 'Srv',
      originalName: 'create_issue',
      mappedName: 'mcp__srv1__create_issue',
      description: '',
      inputSchema: {}
    }
    // 无 profile → 默认需确认
    const r1 = await evaluateToolCallGate(
      base({ toolName: mcpEntry.mappedName, toolInput: {}, mcpEntry, appDb: db })
    )
    expect(r1.decision.type).toBe('require-confirm')
    if (r1.decision.type === 'require-confirm') expect(r1.decision.ruleId).toBe('mcp-tool-ask')

    // 写入会话级信任缓存键 → 命中放行（并落 cache.hit 审计）
    const key = {
      kind: 'mcp-tool' as const,
      serverId: 'srv1',
      toolName: 'create_issue',
      sessionId: 's1'
    }
    const now = Date.now()
    new SqliteDecisionCache(getDbConnection(db)).record({
      id: canonicalKeyJson(key),
      key,
      decision: 'allow',
      lane: 'desktop',
      scope: 'session',
      createdAt: now,
      lastHitAt: now,
      hitCount: 0,
      source: 'user-confirm'
    })
    const audit = auditSink()
    const r2 = await evaluateToolCallGate(
      base({ toolName: mcpEntry.mappedName, toolInput: {}, mcpEntry, appDb: db, audit })
    )
    expect(r2.decision.type).toBe('auto-allow')
    expect(r2.decision.ruleId).toBe('cache-hit')
    expect(audit.events.some((e) => e.event === 'cache.hit')).toBe(true)
  })

  it('MCP 安全注解工具 → auto-allow(mcp-readonly-allow)；无注解 → require-confirm(mcp-tool-ask)', async () => {
    const db = openDb()
    const readonlyEntry = {
      serverId: 'srv1',
      serverName: 'Srv',
      originalName: 'list_issues',
      mappedName: 'mcp__srv1__list_issues',
      description: '',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false }
    }
    // 注解安全：额外产 mcp-readonly 信号 → 命中 mcp-readonly-allow 放行，actionClass 降 read
    const r1 = await evaluateToolCallGate(
      base({ toolName: readonlyEntry.mappedName, toolInput: {}, mcpEntry: readonlyEntry, appDb: db })
    )
    expect(r1.decision.type).toBe('auto-allow')
    expect(r1.decision.ruleId).toBe('mcp-readonly-allow')

    // destructiveHint:true 不算安全注解 → 仍确认
    const r2 = await evaluateToolCallGate(
      base({
        toolName: readonlyEntry.mappedName,
        toolInput: {},
        mcpEntry: { ...readonlyEntry, annotations: { readOnlyHint: true, destructiveHint: true } },
        appDb: db
      })
    )
    expect(r2.decision.type).toBe('require-confirm')
    if (r2.decision.type === 'require-confirm') {
      expect(r2.decision.ruleId).toBe('mcp-tool-ask')
      expect(r2.decision.facts.actionClass).toBe('write')
      // 总是产 mcp-tool 信号；不安全注解不产 mcp-readonly
      expect(r2.decision.facts.signals).toEqual([
        { kind: 'mcp-tool', serverId: 'srv1', toolName: 'list_issues' }
      ])
    }
  })

  it('MCP 安全注解 + custom 套餐覆盖 mcp-readonly-allow→ask → require-confirm（等价原 always 迁移后行为）', async () => {
    const db = openDb()
    new PolicyRuleStore(getDbConnection(db)).setOverride({
      ruleId: 'mcp-readonly-allow',
      action: 'ask',
      params: {}
    })
    writePolicyPackages(db, { desktop: 'custom', wechat: 'custom', feishu: 'custom', automation: 'custom' })
    const readonlyEntry = {
      serverId: 'srv1',
      serverName: 'Srv',
      originalName: 'list_issues',
      mappedName: 'mcp__srv1__list_issues',
      description: '',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    }
    const r = await evaluateToolCallGate(
      base({ toolName: readonlyEntry.mappedName, toolInput: {}, mcpEntry: readonlyEntry, appDb: db })
    )
    expect(r.decision.type).toBe('require-confirm')
    if (r.decision.type === 'require-confirm') expect(r.decision.ruleId).toBe('mcp-readonly-allow')
  })

  it('桌面 browser navigate 命中域名信任缓存 → auto-allow；未命中 → require-confirm', async () => {
    const db = openDb()
    const input = { action: 'navigate', url: 'https://example.com' }
    const r1 = await evaluateToolCallGate(
      base({ toolName: 'browser', toolInput: input, appDb: db, browserConfig: { navigateRequiresConfirm: true } as never })
    )
    expect(r1.decision.type).toBe('require-confirm')

    const key = { kind: 'domain' as const, domain: 'example.com', level: 'domain-any-action' as const }
    const now = Date.now()
    new SqliteDecisionCache(getDbConnection(db)).record({
      id: canonicalKeyJson(key),
      key,
      decision: 'allow',
      lane: 'desktop',
      scope: 'persistent',
      createdAt: now,
      lastHitAt: now,
      hitCount: 0,
      source: 'user-confirm'
    })
    const r2 = await evaluateToolCallGate(
      base({ toolName: 'browser', toolInput: input, appDb: db, browserConfig: { navigateRequiresConfirm: true } as never })
    )
    expect(r2.decision.type).toBe('auto-allow')
    expect(r2.decision.ruleId).toBe('cache-hit')
  })

  it('桌面 browser act 高危 → require-confirm(browser-act-danger-ask)，不派生缓存键', async () => {
    const db = openDb()
    const r = await evaluateToolCallGate(
      base({
        toolName: 'browser',
        toolInput: { action: 'act', instruction: '点击支付' },
        appDb: db,
        browserConfig: { actRequiresConfirm: true } as never,
        currentPageUrl: 'https://shop.example.com',
        dangerAssessment: {
          dangerous: true,
          source: 'keyword',
          userReason: '支付',
          consequence: 'money'
        }
      })
    )
    expect(r.decision.type).toBe('require-confirm')
    if (r.decision.type === 'require-confirm') {
      expect(r.decision.ruleId).toBe('browser-act-danger-ask')
      // 高危 act 不注入 currentHost → 无 domain 记忆档位
      expect(r.decision.memoryTiers).toEqual([])
    }
  })

  it('run_script 远程含网络 → deny(script-network-deny-remote)，回传 rawScriptAnalysis', async () => {
    const r = await evaluateToolCallGate(
      base({
        toolName: 'run_script',
        toolInput: { code: "import requests\nrequests.get('https://x.com')" },
        remoteContext: remoteContext()
      })
    )
    expect(r.decision).toMatchObject({ type: 'deny', ruleId: 'script-network-deny-remote' })
    expect(r.rawScriptAnalysis).toBeTruthy()
  })
})

describe('custom 套餐规则覆盖（动作域按 lane，B2）', () => {
  function dbWithDesktopOverride(action: 'ask' | 'allow' | 'auto-evaluator'): AppDatabase {
    const db = openDb()
    writePolicyPackages(db, { desktop: 'custom', wechat: 'standard', feishu: 'standard', automation: 'standard' })
    new PolicyRuleStore(getDbConnection(db)).setOverride({ ruleId: 'mcp-tool-ask', action })
    return db
  }

  it('覆盖为"询问"：user 确认（不经过快通道/评估器）', async () => {
    const db = dbWithDesktopOverride('ask')
    let evaluatorCalled = false
    const r = await evaluateToolCallGate(
      base({
        toolName: 'mcp__srv__query',
        toolInput: {},
        appDb: db,
        mcpEntry: {
          serverId: 'srv',
          serverName: 'Srv',
          originalName: 'query',
          mappedName: 'mcp__srv__query',
          description: '',
          inputSchema: {}
        },
        fileAutoApproval: async () => {
          evaluatorCalled = true
          return { approve: true }
        }
      })
    )
    expect(r.decision.type).toBe('require-confirm')
    if (r.decision.type === 'require-confirm') {
      expect(r.decision.ruleId).toBe('mcp-tool-ask')
      expect(r.decision.answerer).toBe('user')
    }
    expect(evaluatorCalled).toBe(false)
  })

  it('覆盖为"允许"：直接放行（不经过评估器）', async () => {
    const db = dbWithDesktopOverride('allow')
    let evaluatorCalled = false
    const r = await evaluateToolCallGate(
      base({
        toolName: 'mcp__srv__query',
        toolInput: {},
        appDb: db,
        mcpEntry: {
          serverId: 'srv',
          serverName: 'Srv',
          originalName: 'query',
          mappedName: 'mcp__srv__query',
          description: '',
          inputSchema: {}
        },
        fileAutoApproval: async () => {
          evaluatorCalled = true
          return { approve: false }
        }
      })
    )
    expect(r.decision.type).toBe('auto-allow')
    expect(r.decision.ruleId).toBe('mcp-tool-ask')
    expect(evaluatorCalled).toBe(false)
  })

  it('覆盖为"自动"：无确定性快通道（MCP 工具）→ 审批 Agent 裁决', async () => {
    const db = dbWithDesktopOverride('auto-evaluator')
    const declined = await evaluateToolCallGate(
      base({
        toolName: 'mcp__srv__query',
        toolInput: {},
        appDb: db,
        mcpEntry: {
          serverId: 'srv',
          serverName: 'Srv',
          originalName: 'query',
          mappedName: 'mcp__srv__query',
          description: '',
          inputSchema: {}
        }
      })
    )
    expect(declined.decision.type).toBe('require-confirm')
    if (declined.decision.type === 'require-confirm') {
      expect(declined.decision.ruleId).toBe('mcp-tool-ask')
      expect(declined.decision.answerer).toBe('agent')
    }
  })
})

describe('fileAutoApproved 显式结果字段（H2：自动批准审计不再依赖 ruleId）', () => {
  it('desktop write_file 快通道批准 → fileAutoApproved=true；未批准 → false', async () => {
    const approved = await evaluateToolCallGate(
      base({
        toolName: 'write_file',
        toolInput: { path: 'a.txt', content: 'x' },
        fileAutoApproval: async () => ({ approve: true })
      })
    )
    expect(approved.decision.type).toBe('auto-allow')
    expect(approved.fileAutoApproved).toBe(true)

    const declined = await evaluateToolCallGate(
      base({
        toolName: 'write_file',
        toolInput: { path: 'a.txt', content: 'x' },
        fileAutoApproval: async () => ({ approve: false, reason: '过大', reasonCode: 'oversize' })
      })
    )
    expect(declined.fileAutoApproved).toBe(false)
  })

  it('非写文件工具恒 false（预计算未跑）', async () => {
    const r = await evaluateToolCallGate(base())
    expect(r.fileAutoApproved).toBe(false)
  })
})
