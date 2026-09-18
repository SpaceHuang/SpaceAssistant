import { afterEach, describe, expect, it } from 'vitest'
import { evaluateToolCallGate, type ToolCallGateArgs } from './toolCallGate'
import { openSqliteDatabase, getDbConnection, type AppDatabase } from '../database'
import { SqliteDecisionCache, canonicalKeyJson } from './sqliteDecisionCache'
import { PolicyRuleStore } from './policyRuleStore'
import { writePolicyPackages } from './policyRulesRuntime'
import { persistShellConfig, readShellConfigFromDb } from '../shell/shellConfigDb'
import type { ToolsConfig, TrustedShellCommand } from '../../src/shared/domainTypes'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'

/**
 * P0 特征化基线：钉住门控对 appDb 的两条静默回退与 trusted-command 记账停写。
 * 这些是偏差 3 的缺陷本体（缺料 = 静默降级），P2 端口化后本组用例将改写为
 * fail-loud 断言（缺料 = 调用失败 + 审计），届时删除本注释。
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

const readonlyEntry = {
  serverId: 'srv1',
  serverName: 'Srv',
  originalName: 'list_issues',
  mappedName: 'mcp__srv1__list_issues',
  description: '',
  inputSchema: {},
  annotations: { readOnlyHint: true }
}

/** 播种 MCP 会话级 allow 缓存（等价 toolCallGate.test.ts 的信任链播种） */
function seedMcpSessionAllow(db: AppDatabase, lane: 'desktop' | 'automation' = 'desktop'): void {
  const key = {
    kind: 'mcp-tool' as const,
    serverId: 'srv1',
    toolName: 'list_issues',
    sessionId: 's1'
  }
  const now = Date.now()
  new SqliteDecisionCache(getDbConnection(db)).record({
    id: canonicalKeyJson(key),
    key,
    decision: 'allow',
    lane,
    scope: 'session',
    createdAt: now,
    lastHitAt: now,
    hitCount: 0,
    source: 'user-confirm'
  })
}

describe('evaluateToolCallGate appDb 静默回退特征化（P2 端口化后改写）', () => {
  it('custom 覆盖 ask：传 appDb 生效；缺 appDb 静默回退内置默认 auto-allow', async () => {
    const db = openDb()
    new PolicyRuleStore(getDbConnection(db)).setOverride({
      ruleId: 'mcp-readonly-allow',
      action: 'ask',
      params: {}
    })
    writePolicyPackages(db, { desktop: 'custom', wechat: 'custom', feishu: 'custom', automation: 'custom' })

    const withDb = await evaluateToolCallGate(
      base({ toolName: readonlyEntry.mappedName, toolInput: {}, mcpEntry: readonlyEntry, appDb: db })
    )
    expect(withDb.decision.type).toBe('require-confirm')

    const withoutDb = await evaluateToolCallGate(
      base({ toolName: readonlyEntry.mappedName, toolInput: {}, mcpEntry: readonlyEntry })
    )
    // 现状：缺 appDb → 回退 DEFAULT_POLICY_RULES，用户的 ask 覆盖被静默忽略
    expect(withoutDb.decision.type).toBe('auto-allow')
  })

  it('决策缓存：传 appDb 命中 cache-hit；缺 appDb 播种条目不可见（EMPTY_CACHE 恒 miss）', async () => {
    const db = openDb()
    seedMcpSessionAllow(db)

    const withDb = await evaluateToolCallGate(
      base({ toolName: readonlyEntry.mappedName, toolInput: {}, mcpEntry: readonlyEntry, appDb: db })
    )
    expect(withDb.decision.type).toBe('auto-allow')
    if (withDb.decision.type === 'auto-allow') expect(withDb.decision.ruleId).toBe('cache-hit')

    const withoutDb = await evaluateToolCallGate(
      base({ toolName: readonlyEntry.mappedName, toolInput: {}, mcpEntry: readonlyEntry })
    )
    // 现状：缺 appDb → EMPTY_CACHE，已建立的会话信任静默失效，回到 mcp-readonly-allow 默认
    expect(withoutDb.decision.type).toBe('auto-allow')
    if (withoutDb.decision.type === 'auto-allow') expect(withoutDb.decision.ruleId).toBe('mcp-readonly-allow')
  })

  it('裁决顺序：deny 覆盖使 readonly 放行失效落 ask；ask 分支才查缓存，既有 allow 缓存仍可放行', async () => {
    const db = openDb()
    new PolicyRuleStore(getDbConnection(db)).setOverride({
      ruleId: 'mcp-readonly-allow',
      action: 'deny',
      params: {}
    })
    writePolicyPackages(db, { desktop: 'custom', wechat: 'custom', feishu: 'custom', automation: 'custom' })

    // 无缓存：deny 覆盖的现状语义 = readonly 放行规则失效，落兜底 mcp-tool-ask（require-confirm）
    const noCache = await evaluateToolCallGate(
      base({ toolName: readonlyEntry.mappedName, toolInput: {}, mcpEntry: readonlyEntry, appDb: db })
    )
    expect(noCache.decision.type).toBe('require-confirm')

    // 有缓存：require-confirm 分支查缓存，用户此前确认过的会话信任放行（cache-hit）
    seedMcpSessionAllow(db)
    const withCache = await evaluateToolCallGate(
      base({ toolName: readonlyEntry.mappedName, toolInput: {}, mcpEntry: readonlyEntry, appDb: db })
    )
    expect(withCache.decision.type).toBe('auto-allow')
    if (withCache.decision.type === 'auto-allow') expect(withCache.decision.ruleId).toBe('cache-hit')
  })

  it('trusted-command：auto-allow 判定不依赖 appDb，但 touch 记账仅在传 appDb 时发生（停写特征化）', async () => {
    const trusted: TrustedShellCommand = {
      id: 't1',
      schemaVersion: 2,
      executable: 'git',
      fixedArgvPrefix: ['status'],
      trailingArgv: 'exact',
      createdAt: 1,
      lastUsedAt: 0
    }
    const shellConfig = {
      enabled: true,
      shellDefaultTimeoutSec: 300,
      trustedCommands: [trusted]
    }

    // 无 appDb：判定仍可 auto-allow（legacy 判定材料来自 shellConfig，不来自 db）
    const withoutDb = await evaluateToolCallGate(
      base({ toolName: 'run_shell', toolInput: { command: 'git status' }, shellConfig: shellConfig as never })
    )
    expect(withoutDb.decision.type).toBe('auto-allow')

    // 有 appDb：同判定，且 touch 更新 db 内 trusted command 的 lastUsedAt
    const db = openDb()
    persistShellConfig(db, { trustedCommands: [{ ...trusted, lastUsedAt: 0 }] })
    const withDb = await evaluateToolCallGate(
      base({
        toolName: 'run_shell',
        toolInput: { command: 'git status' },
        shellConfig: shellConfig as never,
        appDb: db
      })
    )
    expect(withDb.decision.type).toBe('auto-allow')
    const persisted = readShellConfigFromDb(db).trustedCommands?.find((t) => t.id === 't1')
    expect(persisted?.lastUsedAt ?? 0).toBeGreaterThan(0)

    // 对照：同一 db 上无 appDb 的调用不产生 touch 写
    const before = readShellConfigFromDb(db).trustedCommands?.find((t) => t.id === 't1')?.lastUsedAt ?? 0
    await evaluateToolCallGate(
      base({
        toolName: 'run_shell',
        toolInput: { command: 'git status' },
        shellConfig: { ...shellConfig, trustedCommands: [{ ...trusted, lastUsedAt: before }] } as never
      })
    )
    const after = readShellConfigFromDb(db).trustedCommands?.find((t) => t.id === 't1')?.lastUsedAt ?? 0
    expect(after).toBe(before)
  })
})
