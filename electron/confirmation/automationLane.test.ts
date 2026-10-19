import { afterEach, describe, expect, it } from 'vitest'
import { loadEffectivePolicyRules } from './policyRulesRuntime'
import { getDbConnection, openSqliteDatabase, type AppDatabase } from '../database'
import { touchTrustedCommand } from '../shell/shellCommandTrust'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { evaluateToolCallGate, type ToolCallGateArgs } from './toolCallGate'
import { channelFor } from './channels'
import { SqliteDecisionCache, canonicalKeyJson } from './sqliteDecisionCache'
import { DEFAULT_TOOLS_CONFIG, type ToolsConfig } from '../../src/shared/domainTypes'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'
import os from 'os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { probeWritePathFact } from './extractors/writePathFacts'
import { probeReadPathFact } from './extractors/readPathFacts'
import { hashMcpToolDescription, hashMcpToolSchema } from '../mcp/mcpToolRegistry'

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
    toolName: 'read_file',
    toolInput: { path: 'a.txt' },
    sessionId: 's-auto-1',
    workDir: os.tmpdir(),
    userDataDir: path.join(os.tmpdir(), 'spaceassistant-test-user-data'),
    toolsConfig: toolsConfig(),
    audit: { record: () => undefined },
    ...gateMaterialsFor(legacyDb, lane),
    ...rest
  }
}

async function createWorkDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'automation-lane-'))
}

function auditSink(): { record: (e: SecurityAuditEvent) => void; events: SecurityAuditEvent[] } {
  const events: SecurityAuditEvent[] = []
  return { record: (e) => events.push(e), events }
}

describe('automation lane 门控运行时行为（评审 B1 核心验收）', () => {
  it('task root 决定相对路径归属，桌面 Profile 路径仍属于任务工作区之外', async () => {
    const taskRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'automation-task-root-')))
    const desktopProfile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'automation-desktop-root-')))
    try {
      const common = { workDir: taskRoot, userDataDir: path.join(taskRoot, '.userdata'), homeDir: os.homedir(), customSensitivePrefixes: [] as string[] }
      const relative = await probeReadPathFact({ ...common, rawPath: 'reports/today.txt' })
      const desktop = await probeReadPathFact({ ...common, rawPath: path.join(desktopProfile, 'private.txt') })
      expect(relative).toMatchObject({ normalizedPath: path.join(taskRoot, 'reports/today.txt'), zone: 'workdir-normal' })
      expect(desktop).toMatchObject({ normalizedPath: path.join(desktopProfile, 'private.txt'), zone: 'outside-workdir' })
    } finally {
      await fs.rm(taskRoot, { recursive: true, force: true })
      await fs.rm(desktopProfile, { recursive: true, force: true })
    }
  })
  it('write_file：automation lane 在 locked 规则终局拒绝', async () => {
    const audit = auditSink()
    const workDir = await createWorkDir()
    try {
      const r = await evaluateToolCallGate(
        base({ lane: 'automation', workDir, toolName: 'write_file', toolInput: { path: 'a.txt', content: 'x' }, appDb: openDb(), audit })
      )
      expect(r.decision.type).toBe('deny')
      expect(r.decision.ruleId).toBe('automation-write-deny')
      const ev = audit.events.find((e) => e.event === 'policy.decision')
      expect(ev?.lane).toBe('automation')
    } finally { await fs.rm(workDir, { recursive: true, force: true }) }
  })

  it('automation 的 write_file 不消费桌面快通道（lane 隔离），恒落 locked deny', async () => {
    const workDir = await createWorkDir()
    try {
      const r = await evaluateToolCallGate(
        base({ lane: 'automation', workDir, toolName: 'write_file', toolInput: { path: 'a.txt', content: 'x' }, fileAutoApproval: async () => ({ approve: true }), appDb: openDb() })
      )
      expect(r.decision.type).toBe('deny')
      expect(r.decision.ruleId).toBe('automation-write-deny')
    } finally { await fs.rm(workDir, { recursive: true, force: true }) }
  })

  it('只读工具命中 automation-readonly-allow 放行', async () => {
    const r = await evaluateToolCallGate(
      base({ lane: 'automation', toolName: 'read_file', toolInput: { path: 'a.txt' }, appDb: openDb() })
    )
    expect(r.decision.type).toBe('auto-allow')
    expect(r.decision.ruleId).toBe('automation-readonly-allow')
  })

  it('run_shell 在 automation lane 没有任务级授权时由 locked 规则终局拒绝', async () => {
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
    expect(r.decision).toMatchObject({ type: 'deny', ruleId: 'automation-shell-deny' })
  })

  it('run_shell 在 automation lane 获得任务级授权后通过策略，并仍执行 Shell 预检', async () => {
    const root = path.resolve(os.tmpdir())
    const precheck = vi.fn(async () => ({
      ok: true as const,
      analysis: { verdict: 'allow', facts: { analysisCompleteness: 'complete' }, shellSecurityHints: { requiresRiskAck: false, outsideWorkDirRisk: false, warnings: [], scannedPaths: [], violationCodes: [] } } as never,
      legacyAutoAllowEligible: false,
      legacyPolicy: {} as never,
      hints: {} as never
    }))
    const r = await evaluateToolCallGate(base({
      lane: 'automation', toolName: 'run_shell', toolInput: { command: 'git log --oneline -5' },
      taskAccessPermissions: { directories: [root], tools: ['run_shell'], authorizationRecord: {
        id: 'receipt-shell', actor: 'user-confirmation', source: 'task-preflight-confirmation', approvedAt: 1, taskRevision: 1,
        permissions: [{ kind: 'local-shell', scopeRoots: [root], commands: [{ command: 'git log --oneline -5', workingDirectory: root }] }]
      } },
      taskWorkDirs: [root], workDir: root, runShellPrecheck: precheck, appDb: openDb()
    }))

    expect(r.decision).toMatchObject({ type: 'auto-allow', ruleId: 'automation-authorized-shell-allow' })
    expect(precheck).toHaveBeenCalledOnce()
    expect(r.facts.signals).toContainEqual({ kind: 'automation-shell-permission', status: 'matched' })
  })

  it('run_shell 的运行时超时可以变化而不影响任务授权匹配', async () => {
    const root = path.resolve(os.tmpdir())
    const permissionRecord = { id: 'receipt-shell', actor: 'user-confirmation' as const, source: 'task-preflight-confirmation' as const,
      approvedAt: 1, taskRevision: 1, permissions: [{ kind: 'local-shell' as const, scopeRoots: [root], commands: [{ command: 'git log --oneline -5', workingDirectory: root }] }] }
    const decisions = await Promise.all([5, 180].map((timeout) => evaluateToolCallGate(base({
      lane: 'automation', toolName: 'run_shell', toolInput: { command: 'git log --oneline -5', timeout },
      taskAccessPermissions: { directories: [root], tools: ['run_shell'], authorizationRecord: permissionRecord }, taskWorkDirs: [root], workDir: root,
      runShellPrecheck: async () => ({ ok: true as const, analysis: {} as never, legacyAutoAllowEligible: false, legacyPolicy: {} as never, hints: {} as never }),
      appDb: openDb()
    }))))

    expect(decisions.map((result) => result.facts.signals.find((signal) => signal.kind === 'automation-shell-permission')))
      .toEqual([{ kind: 'automation-shell-permission', status: 'matched' }, { kind: 'automation-shell-permission', status: 'matched' }])
  })

  it('Shell grant requires the exact approved arguments and does not inherit authorization by tool name', async () => {
    const root = path.resolve(os.tmpdir())
    const permissionRecord = { id: 'receipt-shell', actor: 'user-confirmation' as const, source: 'task-preflight-confirmation' as const,
      approvedAt: 1, taskRevision: 1, permissions: [{ kind: 'local-shell' as const, scopeRoots: [root], commands: [{ command: 'git log --oneline -5', workingDirectory: root }] }] }
    const r = await evaluateToolCallGate(base({
      lane: 'automation', toolName: 'run_shell', toolInput: { command: 'git log --oneline -10' },
      taskAccessPermissions: { directories: [root], tools: ['run_shell'], authorizationRecord: permissionRecord }, taskWorkDirs: [root], workDir: root,
      appDb: openDb()
    }))

    expect(r.facts.signals).toContainEqual({ kind: 'automation-shell-permission', status: 'missing' })
    expect(r.decision).not.toMatchObject({ type: 'auto-allow', ruleId: 'automation-authorized-shell-allow' })
  })

  it('grep requires an approved root and reports its actual query to review evidence', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'automation-grep-root-')))
    try {
      const input = { pattern: 'TODO', path: path.join(root, 'src'), glob: '*.ts' }
      await fs.mkdir(input.path)
      const otherPath = path.join(root, 'other')
      await fs.mkdir(otherPath)
      const record = { id: 'receipt-grep', actor: 'user-confirmation' as const, source: 'task-preflight-confirmation' as const,
        approvedAt: 1, taskRevision: 1, permissions: [{ kind: 'grep' as const, scopeRoots: [input.path] }] }
      const allowed = await evaluateToolCallGate(base({ lane: 'automation', toolName: 'grep', toolInput: input,
        taskAccessPermissions: { directories: [root], tools: ['grep'], authorizationRecord: record }, taskWorkDirs: [root], workDir: root, appDb: openDb() }))
      const denied = await evaluateToolCallGate(base({ lane: 'automation', toolName: 'grep', toolInput: { ...input, path: otherPath },
        taskAccessPermissions: { directories: [root], tools: ['grep'], authorizationRecord: record }, taskWorkDirs: [root], workDir: root, appDb: openDb() }))

      expect(allowed.facts.signals).toContainEqual({ kind: 'automation-grep-permission', status: 'matched' })
      expect(allowed.facts.signals).toContainEqual(expect.objectContaining({ kind: 'grep-invocation', path: input.path, pattern: 'TODO', glob: '*.ts' }))
      expect(denied.facts.signals).toContainEqual({ kind: 'automation-grep-permission', status: 'missing' })
      expect(denied.decision).toMatchObject({ type: 'deny', ruleId: 'automation-grep-permission-missing-deny' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('任务授权不会跳过危险命令预检，也不会写入桌面 Shell 信任缓存', async () => {
    let receivedPrecheckArgs: Record<string, unknown> | undefined
    const precheck = vi.fn(async (args: Record<string, unknown>) => {
      receivedPrecheckArgs = args
      return { ok: false as const, error: '危险命令已拒绝', auditReason: 'dangerous-command', denyType: 'strong' as const }
    })
    const touchTrustedCommand = vi.fn()
    const r = await evaluateToolCallGate(base({
      lane: 'automation', toolName: 'run_shell', toolInput: { command: 'rm -rf /' },
      taskAccessPermissions: { directories: [], tools: ['run_shell'] },
      runShellPrecheck: precheck, shellPrecheck: { touchTrustedCommand }, appDb: openDb()
    }))

    expect(r.decision).toMatchObject({ type: 'deny', ruleId: 'shell-precheck-deny' })
    expect(precheck).toHaveBeenCalledOnce()
    expect(receivedPrecheckArgs).toMatchObject({ command: 'rm -rf /', shellPrecheck: undefined })
    expect(touchTrustedCommand).not.toHaveBeenCalled()
  })

  it('任务授权不会放行无法解析的 Shell 结构', async () => {
    const root = path.resolve(os.tmpdir())
    const r = await evaluateToolCallGate(base({
      lane: 'automation', toolName: 'run_shell', toolInput: { command: 'echo hi' },
      taskAccessPermissions: { directories: [root], tools: ['run_shell'], authorizationRecord: {
        id: 'shell-receipt-unsupported', actor: 'user-confirmation', source: 'task-preflight-confirmation', approvedAt: 1, taskRevision: 1,
        permissions: [{ kind: 'local-shell', scopeRoots: [root], commands: [{ command: 'echo hi', workingDirectory: root }] }]
      } }, taskWorkDirs: [root], workDir: root,
      runShellPrecheck: async () => ({
        ok: true, analysis: { verdict: 'unsupported', unsupportedStructures: ['test-structure'], unsupportedReason: 'structure', facts: { analysisCompleteness: 'partial' }, shellSecurityHints: { requiresRiskAck: false, outsideWorkDirRisk: false, warnings: [], scannedPaths: [], violationCodes: [] } } as never,
        legacyAutoAllowEligible: false, legacyPolicy: {} as never, hints: {} as never
      }), appDb: openDb()
    }))

    expect(r.decision).toMatchObject({ type: 'deny', ruleId: 'automation-unsupported-deny' })
  })

  it('run_script 必须有任务级目录授权，授权状态会交由 policy 判定', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'automation-script-root-')))
    try {
      const call = (authorizationRecord?: unknown) => evaluateToolCallGate(base({
        lane: 'automation', toolName: 'run_script', toolInput: { language: 'python', code: 'print(1)' },
        workDir: root, taskWorkDirs: [root], taskAccessPermissions: authorizationRecord
          ? { directories: [root], tools: ['run_script'], authorizationRecord: authorizationRecord as never }
          : { directories: [root], tools: ['run_script'] }, appDb: openDb()
      }))
      const missing = await call()
      const authorized = await call({ id: 'script-receipt', actor: 'user-confirmation', source: 'task-preflight-confirmation', approvedAt: 1, taskRevision: 1,
        permissions: [{ kind: 'run-script', scopeRoots: [root], scriptHashBinding: 'per-invocation' }] })

      expect(missing.facts.signals).toContainEqual({ kind: 'automation-script-permission', status: 'missing' })
      expect(missing.decision).toMatchObject({ type: 'deny', ruleId: 'automation-script-permission-missing-deny' })
      expect(authorized.facts.signals).toContainEqual({ kind: 'automation-script-permission', status: 'matched' })
      expect(authorized.facts.signals).toContainEqual(expect.objectContaining({ kind: 'script-path-extraction', contentDigest: expect.any(String) }))
      expect(authorized.decision).not.toMatchObject({ type: 'deny', ruleId: 'automation-script-permission-missing-deny' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('MCP 调用必须匹配任务收据中的服务配置和工具描述符，匹配后仍交安全审核 Agent', async () => {
    const inputSchema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    const descriptorHash = hashMcpToolDescription({ serverId: 'server-1', originalName: 'search', description: 'Search issues', inputSchema })
    const profileHash = 'b'.repeat(64)
    const entry = {
      serverId: 'server-1', serverName: 'Issue Tracker', originalName: 'search', mappedName: 'mcp__server_1__search',
      description: 'Search issues', inputSchema, schemaHash: hashMcpToolSchema(inputSchema), descriptorHash, profileHash
    }
    const permission = { kind: 'mcp-tool' as const, serverId: 'server-1', serverName: 'Issue Tracker', toolName: 'search',
      description: 'Search issues', purpose: '查找指定问题', parameters: [{ name: 'query', required: true }], descriptorHash, profileHash }
    const call = (recordPermissions: typeof permission[]) => evaluateToolCallGate(base({
      lane: 'automation', toolName: entry.mappedName, toolInput: { query: 'latest issue' }, mcpEntry: entry,
      taskAccessPermissions: { directories: [], tools: [], authorizationRecord: {
        id: 'mcp-receipt', actor: 'user-confirmation', source: 'task-preflight-confirmation', approvedAt: 1, taskRevision: 1,
        permissions: recordPermissions
      } }, appDb: openDb()
    }))

    const allowed = await call([permission])
    const missing = await call([])
    const changedDescriptor = await call([{ ...permission, descriptorHash: 'c'.repeat(64) }])

    expect(allowed.facts.signals).toContainEqual({ kind: 'automation-mcp-permission', status: 'matched' })
    expect(allowed.decision).toMatchObject({ type: 'require-confirm', ruleId: 'mcp-tool-ask', answerer: 'agent' })
    expect(missing.facts.signals).toContainEqual({ kind: 'automation-mcp-permission', status: 'missing' })
    expect(missing.decision).toMatchObject({ type: 'deny', ruleId: 'automation-mcp-permission-missing-deny' })
    expect(changedDescriptor.decision).toMatchObject({ type: 'deny', ruleId: 'automation-mcp-permission-missing-deny' })
  })

  it('任务授权不会放行触及授权目录以外路径的命令', async () => {
    const authorizedRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'automation-shell-authorized-')))
    const outsideRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'automation-shell-outside-')))
    try {
      const precheck = async () => ({
        ok: true as const,
        analysis: { verdict: 'allow', facts: { analysisCompleteness: 'complete' }, shellSecurityHints: { requiresRiskAck: false, outsideWorkDirRisk: false, warnings: [], scannedPaths: [outsideRoot], violationCodes: [] } } as never,
        legacyAutoAllowEligible: false, legacyPolicy: {} as never, hints: {} as never
      })
      const command = `git -C ${outsideRoot} log --oneline -1`
      const r = await evaluateToolCallGate(base({
        lane: 'automation', toolName: 'run_shell', toolInput: { command },
        taskAccessPermissions: { directories: [authorizedRoot], tools: ['run_shell'], authorizationRecord: {
          id: 'shell-receipt-outside', actor: 'user-confirmation', source: 'task-preflight-confirmation', approvedAt: 1, taskRevision: 1,
          permissions: [{ kind: 'local-shell', scopeRoots: [authorizedRoot], commands: [{ command, workingDirectory: authorizedRoot }] }]
        } }, taskWorkDirs: [authorizedRoot], workDir: authorizedRoot,
        runShellPrecheck: precheck, appDb: openDb()
      }))

      expect(r.decision).toMatchObject({ type: 'deny', ruleId: 'automation-shell-outside-root-deny' })
    } finally {
      await fs.rm(authorizedRoot, { recursive: true, force: true })
      await fs.rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('decision cache 隔离：desktop lane 预写的信任条目，automation 同签名不命中', async () => {
    const db = openDb()
    const cache = new SqliteDecisionCache(getDbConnection(db))
    const workDir = await createWorkDir()
    try {
      const fact = await probeWritePathFact({ rawPath: 'a.txt', workDir, userDataDir: path.join(os.tmpdir(), 'spaceassistant-test-user-data'), homeDir: os.homedir(), customSensitivePrefixes: [] })
      const key = { kind: 'path' as const, path: fact.normalizedPath, level: 'file' as const }
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
        base({ lane: 'desktop', workDir, toolName: 'write_file', toolInput: { path: 'a.txt', content: 'x' }, appDb: db })
      )
      expect(desktopHit.decision.type).toBe('auto-allow')
      expect(desktopHit.decision.ruleId).toBe('cache-hit')

      const automationMiss = await evaluateToolCallGate(
        base({ lane: 'automation', workDir, toolName: 'write_file', toolInput: { path: 'a.txt', content: 'x' }, appDb: db })
      )
      expect(automationMiss.decision.type).toBe('deny')
      expect(automationMiss.decision.ruleId).toBe('automation-write-deny')
      expect(canonicalKeyJson(key)).toBeTruthy()
    } finally { await fs.rm(workDir, { recursive: true, force: true }) }
  })

  it('MCP 工具没有任务级收据时在 automation lane 下锁定拒绝', async () => {
    const r = await evaluateToolCallGate(
      base({
        lane: 'automation',
        toolName: 'some_mcp_tool',
        toolInput: { x: 1 },
        mcpEntry: {
          serverId: 'srv1',
          serverName: 'srv1',
          originalName: 'some_mcp_tool',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true }
        } as never,
        appDb: openDb()
      })
    )
    // Server 只读注解不构成任务级用户授权。
    expect(r.decision).toMatchObject({ type: 'deny', ruleId: 'automation-mcp-permission-missing-deny' })
  })
})

describe('channelFor automation 通道（偏差 21：channels.ts 可达 automation）', () => {
  it('automation lane 显式 deny 回答者（RejectingChannel 语义保留）→ confirm.outcome 审计带 cause=no-answerer', async () => {
    const audit = auditSink()
    const channel = channelFor({
      lane: 'automation',
      requestId: 'req-a',
      sessionId: 's-auto-1',
      toolName: 'write_file',
      toolUseId: 'tu-1',
      answererPolicy: { kind: 'deny' },
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
    expect((outcome as { reason?: string }).reason).toBeUndefined()
    expect((outcome as { cause?: string }).cause).toBe('no-answerer')
    const outcomeEv = audit.events.find((e) => e.event === 'confirm.outcome')
    expect(outcomeEv?.lane).toBe('automation')
    expect(outcomeEv?.reason).toBe('no-answerer')
    expect(outcomeEv?.cause).toBe('no-answerer')
    // 无回答者：本次没有回答动作，actor 如实为 system（B1 归因口径）
    expect(outcomeEv?.actor).toBe('system')
  })
})

describe('评审 P1-2：lane=* 存量豁免缓存条目不得作用于 automation', () => {
  it('lane=* 的 shell-command allow 条目（存量豁免迁移写入形态）：desktop/feishu 命中，automation 不命中', () => {
    const db = openDb()
    const cache = new SqliteDecisionCache(getDbConnection(db))
    const key = { kind: 'shell-command' as const, verb: 'npm install', level: 'exact' as const }
    cache.record({
      id: 'seed-legacy',
      key,
      decision: 'allow',
      lane: '*',
      scope: 'persistent',
      createdAt: Date.now(),
      lastHitAt: Date.now(),
      hitCount: 0,
      source: 'migration'
    })

    expect(cache.lookup(key, 'desktop')?.decision).toBe('allow')
    expect(cache.lookup(key, 'feishu')?.decision).toBe('allow')
    // 无人值守链路不得继承桌面用户的历史信任：'*' 条目对 automation 不可见
    expect(cache.lookup(key, 'automation')).toBeNull()
  })

  it('lane=* 的 domain allow 条目：automation 的 browser 调用不命中（落确认）', async () => {
    const db = openDb()
    const cache = new SqliteDecisionCache(getDbConnection(db))
    const key = { kind: 'domain' as const, domain: 'trusted.example.com', level: 'domain-any-action' as const }
    cache.record({
      id: 'seed-legacy-domain',
      key,
      decision: 'allow',
      lane: '*',
      scope: 'persistent',
      createdAt: Date.now(),
      lastHitAt: Date.now(),
      hitCount: 0,
      source: 'migration'
    })

    const r = await evaluateToolCallGate(
      base({
        lane: 'automation',
        toolName: 'browser',
        toolInput: { action: 'navigate', url: 'https://trusted.example.com/page' },
        appDb: db
      })
    )
    expect(r.decision.type).toBe('require-confirm')
    expect(r.decision.ruleId).toBe('automation-default-confirm')
  })
})
