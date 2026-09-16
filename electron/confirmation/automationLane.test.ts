import { afterEach, describe, expect, it } from 'vitest'
import { evaluateToolCallGate, type ToolCallGateArgs } from './toolCallGate'
import { channelFor } from './channels'
import { openSqliteDatabase, getDbConnection, type AppDatabase } from '../database'
import { SqliteDecisionCache, canonicalKeyJson } from './sqliteDecisionCache'
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

const toolsConfig = (overrides: Partial<ToolsConfig> = {}): ToolsConfig => ({
  ...DEFAULT_TOOLS_CONFIG,
  deniedTools: [],
  ...overrides
})

function base(overrides: Partial<ToolCallGateArgs> = {}): ToolCallGateArgs {
  return {
    toolName: 'read_file',
    toolInput: { path: 'a.txt' },
    sessionId: 's-auto-1',
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

describe('automation lane 门控运行时行为（评审 B1 核心验收）', () => {
  it('write_file：require-confirm（automation-default-confirm），全程未命中 desktop 规则', async () => {
    const audit = auditSink()
    const r = await evaluateToolCallGate(
      base({
        lane: 'automation',
        toolName: 'write_file',
        toolInput: { path: 'a.txt', content: 'x' },
        appDb: openDb(),
        audit
      })
    )
    expect(r.decision.type).toBe('require-confirm')
    expect(r.decision.ruleId).toBe('automation-default-confirm')
    const ev = audit.events.find((e) => e.event === 'policy.decision')
    expect(ev?.lane).toBe('automation')
  })

  it('desktop-auto-approve 开启（confirmMode=auto）时 automation 的 write_file 仍被确认', async () => {
    const r = await evaluateToolCallGate(
      base({
        lane: 'automation',
        toolName: 'write_file',
        toolInput: { path: 'a.txt', content: 'x' },
        toolsConfig: toolsConfig({ confirmMode: 'auto' }),
        fileAutoApproval: async () => ({ approve: true }),
        appDb: openDb()
      })
    )
    expect(r.decision.type).toBe('require-confirm')
    expect(r.decision.ruleId).not.toBe('desktop-auto-approve')
  })

  it('只读工具命中 automation-readonly-allow 放行', async () => {
    const r = await evaluateToolCallGate(
      base({ lane: 'automation', toolName: 'read_file', toolInput: { path: 'a.txt' }, appDb: openDb() })
    )
    expect(r.decision.type).toBe('auto-allow')
    expect(r.decision.ruleId).toBe('automation-readonly-allow')
  })

  it('run_shell 预检信任命令（legacyAutoAllowEligible=true）也不跳过确认（shell-precheck-auto-allow 不作用于 automation）', async () => {
    const r = await evaluateToolCallGate(
      base({
        lane: 'automation',
        toolName: 'run_shell',
        toolInput: { command: 'echo hi' },
        runShellPrecheck: async () => ({
          ok: true,
          analysis: {} as never,
          legacyAutoAllowEligible: true,
          legacyPolicy: {} as never,
          hints: {} as never
        }),
        appDb: openDb()
      })
    )
    expect(r.decision.type).toBe('require-confirm')
  })

  it('decision cache 隔离：desktop lane 预写的信任条目，automation 同签名不命中', async () => {
    const db = openDb()
    const cache = new SqliteDecisionCache(getDbConnection(db))
    const key = { kind: 'path' as const, path: 'a.txt', level: 'file' as const }
    cache.record({
      id: 'seed-1',
      key,
      decision: 'allow',
      lane: 'desktop',
      scope: 'persistent',
      createdAt: Date.now(),
      lastHitAt: Date.now(),
      hitCount: 0,
      source: 'user-confirm'
    })

    const desktopHit = await evaluateToolCallGate(
      base({ lane: 'desktop', toolName: 'write_file', toolInput: { path: 'a.txt', content: 'x' }, appDb: db })
    )
    expect(desktopHit.decision.type).toBe('auto-allow')
    expect(desktopHit.decision.ruleId).toBe('cache-hit')

    const automationMiss = await evaluateToolCallGate(
      base({ lane: 'automation', toolName: 'write_file', toolInput: { path: 'a.txt', content: 'x' }, appDb: db })
    )
    expect(automationMiss.decision.type).toBe('require-confirm')
    expect(canonicalKeyJson(key)).toBeTruthy()
  })

  it('MCP 工具（mcp-tool 信号）在 automation lane 下落确认而非放行', async () => {
    const r = await evaluateToolCallGate(
      base({
        lane: 'automation',
        toolName: 'some_mcp_tool',
        toolInput: { x: 1 },
        mcpEntry: {
          serverId: 'srv1',
          serverName: 'srv1',
          originalName: 'some_mcp_tool',
          annotations: { readOnlyHint: true }
        } as never,
        appDb: openDb()
      })
    )
    // mcp-readonly-allow 仅限 desktop；automation 无 MCP 豁免 → require-confirm
    expect(r.decision.type).toBe('require-confirm')
  })
})

describe('channelFor automation 通道（偏差 21：channels.ts 可达 automation）', () => {
  it('automation lane 返回 RejectingChannel，confirm.outcome 审计带 cause=no-answerer', async () => {
    const audit = auditSink()
    const channel = channelFor({
      lane: 'automation',
      requestId: 'req-a',
      sessionId: 's-auto-1',
      toolName: 'write_file',
      toolUseId: 'tu-1',
      audit
    })
    const outcome = await channel.request({
      requestId: 'req-a',
      sessionId: 's-auto-1',
      lane: 'automation',
      toolName: 'write_file',
      toolInput: { path: 'a.txt' },
      riskLevel: 'medium',
      facts: { summary: { text: 'write a.txt' }, signals: [] }
    } as never)
    expect(outcome.kind).toBe('rejected')
    expect((outcome as { reason?: string }).reason).toBe('no-answerer')
    const outcomeEv = audit.events.find((e) => e.event === 'confirm.outcome')
    expect(outcomeEv?.lane).toBe('automation')
    expect(outcomeEv?.reason).toBe('no-answerer')
  })
})
