import { afterEach, describe, expect, it } from 'vitest'
import { evaluateToolCallGate, type ToolCallGateArgs } from './toolCallGate'
import { openSqliteDatabase, getDbConnection, type AppDatabase } from '../database'
import { SqliteDecisionCache, canonicalKeyJson } from './sqliteDecisionCache'
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

function base(overrides: Partial<ToolCallGateArgs> = {}): ToolCallGateArgs {
  return {
    toolName: 'read_file',
    toolInput: { path: 'a.txt' },
    sessionId: 's1',
    workDir: '/tmp/wd',
    userDataDir: '/tmp/ud',
    toolsConfig: toolsConfig(),
    audit: { record: () => undefined },
    ...overrides
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
  })

  it('桌面 write_file confirmMode=auto：评估器批准 → auto-allow(desktop-auto-approve)', async () => {
    const r = await evaluateToolCallGate(
      base({
        toolName: 'write_file',
        toolInput: { path: 'a.txt', content: 'x' },
        toolsConfig: toolsConfig({ confirmMode: 'auto' }),
        fileAutoApproval: async () => ({ approve: true })
      })
    )
    expect(r.decision.type).toBe('auto-allow')
    expect(r.decision.ruleId).toBe('desktop-auto-approve')
  })

  it('桌面 write_file confirmMode=auto 评估器拒绝 → require-confirm + fallback', async () => {
    const r = await evaluateToolCallGate(
      base({
        toolName: 'write_file',
        toolInput: { path: 'a.txt', content: 'x' },
        toolsConfig: toolsConfig({ confirmMode: 'auto' }),
        fileAutoApproval: async () => ({ approve: false, reason: '过大', reasonCode: 'oversize' })
      })
    )
    expect(r.decision.type).toBe('require-confirm')
    expect(r.autoApproveFallback?.reasonCode).toBe('oversize')
  })

  it('桌面 write_file confirmMode=diff → require-confirm，带 path 记忆档位', async () => {
    const r = await evaluateToolCallGate(
      base({ toolName: 'write_file', toolInput: { path: 'a.txt', content: 'x' } })
    )
    expect(r.decision.type).toBe('require-confirm')
    if (r.decision.type === 'require-confirm') {
      expect(r.decision.memoryTiers.length).toBeGreaterThan(0)
    }
  })

  it('run_shell 预检 deny → gate 前置短路（shellPrecheckDeny），不进引擎', async () => {
    const r = await evaluateToolCallGate(
      base({
        toolName: 'run_shell',
        toolInput: { command: 'rm -rf /' },
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
  })

  it('run_shell 预检 skipConfirm → auto-allow(shell-precheck-auto-allow)', async () => {
    const r = await evaluateToolCallGate(
      base({
        toolName: 'run_shell',
        toolInput: { command: 'ping baidu.com' },
        runShellPrecheck: async () => ({
          ok: true,
          analysis: { verdict: 'allow' } as never,
          skipConfirm: true,
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
          skipConfirm: false,
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
          skipConfirm: true,
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

describe('desktop-auto-approve 规则覆盖（确认模式并入规则列表，§7）', () => {
  function dbWithDesktopOverride(action: 'ask' | 'allow' | 'auto-evaluator'): AppDatabase {
    const db = openDb()
    writePolicyPackages(db, { desktop: 'custom', wechat: 'standard', feishu: 'standard', automation: 'standard' })
    new PolicyRuleStore(getDbConnection(db)).setOverride({ ruleId: 'desktop-auto-approve', action })
    return db
  }

  it('覆盖为"询问"：confirmMode=auto 也一律确认（覆盖剥离 confirmMode 门控）', async () => {
    const db = dbWithDesktopOverride('ask')
    let evaluatorCalled = false
    const r = await evaluateToolCallGate(
      base({
        toolName: 'write_file',
        toolInput: { path: 'a.txt', content: 'x' },
        toolsConfig: toolsConfig({ confirmMode: 'auto' }),
        appDb: db,
        fileAutoApproval: async () => {
          evaluatorCalled = true
          return { approve: true }
        }
      })
    )
    expect(r.decision.type).toBe('require-confirm')
    if (r.decision.type === 'require-confirm') expect(r.decision.ruleId).toBe('desktop-auto-approve')
    expect(evaluatorCalled).toBe(false)
  })

  it('覆盖为"允许"：confirmMode=diff 也直接放行（不经过评估器）', async () => {
    const db = dbWithDesktopOverride('allow')
    let evaluatorCalled = false
    const r = await evaluateToolCallGate(
      base({
        toolName: 'write_file',
        toolInput: { path: 'a.txt', content: 'x' },
        toolsConfig: toolsConfig({ confirmMode: 'diff' }),
        appDb: db,
        fileAutoApproval: async () => {
          evaluatorCalled = true
          return { approve: false }
        }
      })
    )
    expect(r.decision.type).toBe('auto-allow')
    expect(r.decision.ruleId).toBe('desktop-auto-approve')
    expect(evaluatorCalled).toBe(false)
  })

  it('覆盖为"自动"：confirmMode=diff 也走评估器裁决', async () => {
    const db = dbWithDesktopOverride('auto-evaluator')
    let evaluatorCalled = false
    const r = await evaluateToolCallGate(
      base({
        toolName: 'write_file',
        toolInput: { path: 'a.txt', content: 'x' },
        toolsConfig: toolsConfig({ confirmMode: 'diff' }),
        appDb: db,
        fileAutoApproval: async () => {
          evaluatorCalled = true
          return { approve: true }
        }
      })
    )
    expect(evaluatorCalled).toBe(true)
    expect(r.decision.type).toBe('auto-allow')
    expect(r.decision.ruleId).toBe('desktop-auto-approve')
  })
})
