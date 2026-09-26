import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
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
import { DEFAULT_SHELL_CONFIG, DEFAULT_TOOLS_CONFIG, DEFAULT_WIKI_CONFIG, type ToolsConfig } from '../../src/shared/domainTypes'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'
import { ReadConfirmationRegistry } from './readConfirmationRegistry'
import { finalizeReadConfirmation } from './readConfirmationFlow'
import * as readPathFacts from './extractors/readPathFacts'
import * as shellAnalyzer from '../shell/analyzeShellCommand'
import { scriptParserService } from '../shell/scriptParserService'
import { readFeishuAttachmentExecutor } from '../tools/readFeishuAttachmentExecutor'
import type { ToolExecutionContext } from '../tools/types'
import { classifyWorkDirProfileTarget } from '../workDirBinding'

const shells: AppDatabase[] = []
let nextGateTestId = 0
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

function attachmentRegistration(localPath: string, id = 'attachment-1', messageId = 'm1') {
  return { id, messageId, localPath, fileName: path.basename(localPath), mimeType: 'text/plain' }
}


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
    requestId: `gate-test-req-${++nextGateTestId}`,
    toolUseId: `gate-test-tool-${nextGateTestId}`,
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
  it('policy.decision 审计携带 requestId/toolUseId 以关联执行期 veto', async () => {
    const audit = auditSink()
    const gate = await evaluateToolCallGate(base({
      requestId: 'audit-request',
      toolUseId: 'audit-tool-use',
      audit
    }))

    expect(gate.decision.type).toBe('auto-allow')
    expect(audit.events.find((event) => event.event === 'policy.decision')).toMatchObject({
      requestId: 'audit-request',
      toolUseId: 'audit-tool-use',
      toolName: 'read_file'
    })
  })

  it('策略决策审计对 Shell 路径只记录路径分区，不记录原路径', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/shell-audit-root-'))
    const outside = await fs.realpath(await fs.mkdtemp('/tmp/shell-audit-outside-'))
    const secretPath = path.join(outside, 'private-token.txt')
    const audit = auditSink()
    await fs.writeFile(secretPath, 'audit fixture')
    try {
      const gate = await evaluateToolCallGate(base({
        workDir: root,
        userDataDir: path.join(root, '.userdata'),
        toolName: 'run_shell',
        toolInput: { command: `cat ${secretPath}` },
        audit,
        runShellPrecheck: async () => ({ ok: true, analysis: { verdict: 'allow' } as never, legacyAutoAllowEligible: true, legacyPolicy: { permissionDecision: 'allow', trustedCacheKeys: [] }, hints: {} as never })
      }))

      expect(gate.facts.signals).toContainEqual({ kind: 'command-effect', effect: 'read-only' })
      expect(audit.events.find((event) => event.event === 'policy.decision')?.pathZones).toContain('outside-workdir')
      expect(JSON.stringify(audit.events)).not.toContain(secretPath)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('桌面与远程写 gate 均拒绝 outside symlink 和 hardlink 目标', async () => {
    const workDir = await fs.realpath(await fs.mkdtemp('/tmp/write-link-matrix-work-'))
    const outside = await fs.realpath(await fs.mkdtemp('/tmp/write-link-matrix-outside-'))
    const external = path.join(outside, 'external.txt')
    const outsideSymlink = path.join(workDir, 'outside-link.txt')
    const hardlink = path.join(workDir, 'hardlink.txt')
    await fs.writeFile(external, 'protected')
    try {
      await fs.symlink(external, outsideSymlink)
      await fs.link(external, hardlink)
      for (const lane of ['desktop', 'feishu', 'wechat'] as const) {
        for (const target of [outsideSymlink, hardlink]) {
          const gate = await evaluateToolCallGate(base({
            lane,
            ...(lane === 'desktop' ? {} : { remoteContext: remoteContext({ source: lane }) }),
            workDir,
            userDataDir: path.join(workDir, '.userdata'),
            toolName: 'write_file',
            toolInput: { path: target, content: 'must not overwrite' }
          }))

          expect(gate.writePathFact?.targetKind).toBe(target === outsideSymlink ? 'symlink' : 'hardlink')
          expect(gate.decision.type).toBe('deny')
          expect(gate.decision.ruleId).toBe(lane !== 'desktop' && target === outsideSymlink ? 'remote-outside-write-deny' : 'write-target-unsupported-deny')
          expect(gate.writeExecutionPermit).toBeUndefined()
        }
      }
      expect(await fs.readFile(external, 'utf8')).toBe('protected')
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it.each(['read_file', 'grep'] as const)('%s 使用 desktop strict/custom 的生效读取规则，而非固定 zone 决策', async (toolName) => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/read-policy-root-'))
    const outside = await fs.realpath(await fs.mkdtemp('/tmp/read-policy-outside-'))
    const targets = [
      { zone: 'workdir-normal' as const, path: path.join(root, 'note.txt'), ruleId: 'read-target-workdir-allow' },
      { zone: 'outside-workdir' as const, path: path.join(outside, 'note.txt'), ruleId: 'path-outside-readonly-allow' }
    ]
    await Promise.all(targets.map((target) => fs.writeFile(target.path, 'needle')))
    const db = openDb()
    try {
      const store = new PolicyRuleStore(getDbConnection(db))
      for (const target of targets) {
        const makeInput = () => toolName === 'grep' ? { pattern: 'needle', path: target.path } : { path: target.path }
        const common = { appDb: db, workDir: root, userDataDir: path.join(root, '.userdata'), toolName, toolInput: makeInput() }
        writePolicyPackages(db, { desktop: 'standard', wechat: 'standard', feishu: 'standard', automation: 'standard' })
        const standard = await evaluateToolCallGate(base(common))
        expect(standard.readPathFact?.zone).toBe(target.zone)
        expect(standard.decision).toMatchObject({ type: 'auto-allow', ruleId: target.ruleId })
        expect(standard.readExecutionPermit).toBeDefined()

        writePolicyPackages(db, { desktop: 'strict', wechat: 'standard', feishu: 'standard', automation: 'standard' })
        const strictRegistry = new ReadConfirmationRegistry()
        const strictRequestId = `strict-${toolName}-${target.zone}`
        const strictToolUseId = `strict-tool-${toolName}-${target.zone}`
        const strict = await evaluateToolCallGate(base({ ...common, requestId: strictRequestId, toolUseId: strictToolUseId, readConfirmationRegistry: strictRegistry }))
        expect(strict.decision).toMatchObject({ type: 'require-confirm', ruleId: `scope-strict-${target.ruleId}`, answerer: 'user' })
        expect(strict.readExecutionPermit).toBeUndefined()
        expect(finalizeReadConfirmation({
          toolName, toolInput: makeInput(), requestId: strictRequestId, toolUseId: strictToolUseId,
          outcome: 'approved', answerer: 'user', readPathFact: strict.readPathFact,
          approvedTargets: strict.readTargetMapping
        }, strictRegistry)?.targets[0]).toMatchObject({ normalizedPath: target.path, decisionRuleId: `scope-strict-${target.ruleId}` })

        writePolicyPackages(db, { desktop: 'custom', wechat: 'standard', feishu: 'standard', automation: 'standard' })
        const registry = new ReadConfirmationRegistry()
        const requestId = `custom-ask-${toolName}-${target.zone}`
        const toolUseId = `custom-ask-tool-${toolName}-${target.zone}`
        store.setOverride({ ruleId: target.ruleId, action: 'ask', params: {} })
        const customAsk = await evaluateToolCallGate(base({ ...common, requestId, toolUseId, readConfirmationRegistry: registry }))
        expect(customAsk.decision).toMatchObject({ type: 'require-confirm', ruleId: target.ruleId, answerer: 'user' })
        expect(customAsk.readExecutionPermit).toBeUndefined()
        const confirmedPermit = finalizeReadConfirmation({
          toolName, toolInput: makeInput(), requestId, toolUseId, outcome: 'approved', answerer: 'user',
          readPathFact: customAsk.readPathFact, approvedTargets: customAsk.readTargetMapping
        }, registry)
        expect(confirmedPermit?.targets[0]).toMatchObject({ normalizedPath: target.path, decisionRuleId: target.ruleId })

        store.setOverride({ ruleId: target.ruleId, action: 'deny', params: {} })
        const customDeny = await evaluateToolCallGate(base(common))
        expect(customDeny.decision).toMatchObject({ type: 'deny', ruleId: target.ruleId })
        expect(customDeny.readExecutionPermit).toBeUndefined()
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('list_directory 使用同一生效规则并把 direct-entries 许可绑定到目录事实', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/list-directory-policy-root-'))
    const targetDir = path.join(root, 'target')
    await fs.mkdir(targetDir)
    const db = openDb()
    const registry = new ReadConfirmationRegistry()
    const requestId = 'list-policy-req'
    const toolUseId = 'list-policy-tool'
    const input = { path: 'target' }
    try {
      const standard = await evaluateToolCallGate(base({
        appDb: db, workDir: root, userDataDir: path.join(root, '.userdata'),
        toolName: 'list_directory', toolInput: input
      }))
      expect(standard.readPathFact).toMatchObject({ normalizedPath: targetDir, zone: 'workdir-normal', targetKind: 'directory', scope: 'direct-entries-snapshot' })
      expect(standard.decision).toMatchObject({ type: 'auto-allow', ruleId: 'read-target-workdir-allow' })
      expect(standard.readExecutionPermit).toMatchObject({ toolName: 'list_directory', targets: [{ normalizedPath: targetDir, scope: 'direct-entries' }] })

      writePolicyPackages(db, { desktop: 'strict', wechat: 'standard', feishu: 'standard', automation: 'standard' })
      const readdir = vi.spyOn(fs, 'readdir')
      const strict = await evaluateToolCallGate(base({
        appDb: db, workDir: root, userDataDir: path.join(root, '.userdata'),
        toolName: 'list_directory', toolInput: input, requestId, toolUseId, readConfirmationRegistry: registry
      }))
      expect(strict.decision).toMatchObject({ type: 'require-confirm', ruleId: 'scope-strict-read-target-workdir-allow', answerer: 'user' })
      expect(strict.readExecutionPermit).toBeUndefined()
      expect(readdir).not.toHaveBeenCalled()
      readdir.mockRestore()
      const strictPermit = finalizeReadConfirmation({
        toolName: 'list_directory', toolInput: input, requestId, toolUseId, outcome: 'approved', answerer: 'user',
        readPathFact: strict.readPathFact, approvedTargets: strict.readTargetMapping
      }, registry)
      expect(strictPermit?.targets[0]).toMatchObject({ scope: 'direct-entries', targetKind: 'directory' })

      writePolicyPackages(db, { desktop: 'custom', wechat: 'standard', feishu: 'standard', automation: 'standard' })
      const store = new PolicyRuleStore(getDbConnection(db))
      const customRegistry = new ReadConfirmationRegistry()
      const customRequestId = 'list-policy-custom-ask-req'
      const customToolUseId = 'list-policy-custom-ask-tool'
      store.setOverride({ ruleId: 'read-target-workdir-allow', action: 'ask', params: {} })
      const customAsk = await evaluateToolCallGate(base({
        appDb: db, workDir: root, userDataDir: path.join(root, '.userdata'),
        toolName: 'list_directory', toolInput: input, requestId: customRequestId, toolUseId: customToolUseId,
        readConfirmationRegistry: customRegistry
      }))
      expect(customAsk.decision).toMatchObject({ type: 'require-confirm', ruleId: 'read-target-workdir-allow', answerer: 'user' })
      expect(customAsk.readExecutionPermit).toBeUndefined()
      expect(finalizeReadConfirmation({
        toolName: 'list_directory', toolInput: input, requestId: customRequestId, toolUseId: customToolUseId,
        outcome: 'approved', answerer: 'user', readPathFact: customAsk.readPathFact,
        approvedTargets: customAsk.readTargetMapping
      }, customRegistry)?.targets[0]).toMatchObject({ scope: 'direct-entries', targetKind: 'directory' })
      store.setOverride({ ruleId: 'read-target-workdir-allow', action: 'deny', params: {} })
      const customDeny = await evaluateToolCallGate(base({
        appDb: db, workDir: root, userDataDir: path.join(root, '.userdata'),
        toolName: 'list_directory', toolInput: input
      }))
      expect(customDeny.decision).toMatchObject({ type: 'deny', ruleId: 'read-target-workdir-allow' })
      expect(customDeny.readExecutionPermit).toBeUndefined()

      const wrongKind = await evaluateToolCallGate(base({ appDb: db, workDir: root, userDataDir: path.join(root, '.userdata'), toolName: 'list_directory', toolInput: { path: 'missing' } }))
      expect(wrongKind.decision.type).toBe('deny')
      expect(wrongKind.readExecutionPermit).toBeUndefined()
      const fileTarget = path.join(root, 'not-a-directory.txt')
      await fs.writeFile(fileTarget, 'file')
      const fileKind = await evaluateToolCallGate(base({ appDb: db, workDir: root, userDataDir: path.join(root, '.userdata'), toolName: 'list_directory', toolInput: { path: fileTarget } }))
      expect(fileKind.decision).toMatchObject({ type: 'deny', ruleId: 'directory-read-target-unsupported' })
      expect(fileKind.readExecutionPermit).toBeUndefined()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('list_directory symlink 事实解析最终目录并在许可中限定浅层枚举', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/list-directory-symlink-root-'))
    const outside = await fs.realpath(await fs.mkdtemp('/tmp/list-directory-symlink-outside-'))
    const targetDir = path.join(outside, 'actual')
    const link = path.join(root, 'link')
    await fs.mkdir(targetDir)
    await fs.symlink(targetDir, link, 'dir')
    try {
      const gate = await evaluateToolCallGate(base({
        workDir: root, userDataDir: path.join(root, '.userdata'), toolName: 'list_directory', toolInput: { path: link }
      }))
      expect(gate.readPathFact).toMatchObject({ normalizedPath: targetDir, zone: 'outside-workdir', targetKind: 'symlink', resolvedKind: 'directory', scope: 'direct-entries-snapshot' })
      expect(gate.decision).toMatchObject({ type: 'auto-allow', ruleId: 'path-outside-readonly-allow' })
      expect(gate.readExecutionPermit?.targets[0]).toMatchObject({ normalizedPath: targetDir, targetKind: 'directory', scope: 'direct-entries' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it.each(['read_file', 'grep', 'list_directory'] as const)('%s 的敏感目标仍由 locked 真人确认规则优先裁决', async (toolName) => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/read-policy-sensitive-root-'))
    const userDataDir = path.join(root, '.userdata')
    await fs.mkdir(userDataDir)
    const targetFile = path.join(userDataDir, 'secret.txt')
    await fs.writeFile(targetFile, 'secret')
    const db = openDb()
    writePolicyPackages(db, { desktop: 'custom', wechat: 'standard', feishu: 'standard', automation: 'standard' })
    new PolicyRuleStore(getDbConnection(db)).setOverride({ ruleId: 'read-target-workdir-allow', action: 'deny', params: {} })
    const registry = new ReadConfirmationRegistry()
    const requestId = `sensitive-${toolName}-req`
    const toolUseId = `sensitive-${toolName}-tool`
    try {
      const toolInput = toolName === 'list_directory'
        ? { path: userDataDir }
        : toolName === 'grep'
          ? { path: targetFile, pattern: 'secret' }
          : { path: targetFile }
      const gate = await evaluateToolCallGate(base({
        appDb: db, workDir: root, userDataDir, toolName, toolInput, requestId, toolUseId, readConfirmationRegistry: registry
      }))
      expect(gate.readPathFact?.zone).toBe('sensitive-file')
      expect(gate.decision).toMatchObject({ type: 'require-confirm', ruleId: 'path-sensitive-read-confirm', answerer: 'user' })
      expect(gate.readExecutionPermit).toBeUndefined()
      if (toolName === 'list_directory') {
        expect(finalizeReadConfirmation({
          toolName, toolInput, requestId, toolUseId, outcome: 'approved', answerer: 'user',
          readPathFact: gate.readPathFact, approvedTargets: gate.readTargetMapping
        }, registry)?.targets[0]).toMatchObject({ scope: 'direct-entries', targetKind: 'directory', zone: 'sensitive-file' })
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it.each(['read_file', 'grep', 'list_directory'] as const)('%s 的系统目录目标不可被 custom 普通路径规则放宽', async (toolName) => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/read-policy-system-root-'))
    const windowsRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
    const systemDir = process.platform === 'win32' ? path.join(windowsRoot, 'System32') : '/etc'
    const systemFile = process.platform === 'win32' ? path.join(windowsRoot, 'System32', 'drivers', 'etc', 'hosts') : '/etc/hosts'
    try {
      await fs.access(systemDir)
      await fs.access(systemFile)
    } catch {
      await fs.rm(root, { recursive: true, force: true })
      return
    }
    const db = openDb()
    writePolicyPackages(db, { desktop: 'custom', wechat: 'standard', feishu: 'standard', automation: 'standard' })
    new PolicyRuleStore(getDbConnection(db)).setOverride({ ruleId: 'path-outside-readonly-allow', action: 'deny', params: {} })
    const registry = new ReadConfirmationRegistry()
    const requestId = `system-${toolName}-req`
    const toolUseId = `system-${toolName}-tool`
    try {
      const toolInput = toolName === 'list_directory'
        ? { path: systemDir }
        : toolName === 'grep'
          ? { path: systemFile, pattern: 'root' }
          : { path: systemFile }
      const gate = await evaluateToolCallGate(base({
        appDb: db, workDir: root, userDataDir: path.join(root, '.userdata'), toolName, toolInput, requestId, toolUseId, readConfirmationRegistry: registry
      }))
      expect(gate.readPathFact?.zone).toBe('system-dir')
      expect(gate.decision).toMatchObject({ type: 'require-confirm', ruleId: 'path-system-dir-ask', answerer: 'user' })
      expect(gate.readExecutionPermit).toBeUndefined()
      if (toolName === 'list_directory') {
        expect(finalizeReadConfirmation({ toolName, toolInput, requestId, toolUseId, outcome: 'approved', answerer: 'user', readPathFact: gate.readPathFact, approvedTargets: gate.readTargetMapping }, registry)?.targets[0]).toMatchObject({ scope: 'direct-entries', targetKind: 'directory' })
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it.each(['/System/Library/CoreServices/SystemVersion.plist', '/Library/Preferences/com.apple.test.plist'])(
    '桌面对 macOS 系统路径 %s 要求真人确认', async (systemPath) => {
      const gate = await evaluateToolCallGate(base({ toolName: 'read_file', toolInput: { path: systemPath } }))
      expect(gate.readPathFact?.zone).toBe('system-dir')
      expect(gate.decision).toMatchObject({ type: 'require-confirm', ruleId: 'path-system-dir-ask', answerer: 'user' })
      expect(gate.readExecutionPermit).toBeUndefined()
    }
  )

  it.each(['desktop', 'automation'] as const)('macOS /var/log 经 realpath 后在 %s lane 保持系统目录边界', async (lane) => {
    if (process.platform !== 'darwin') return
    const root = await fs.realpath(await fs.mkdtemp('/tmp/read-policy-var-root-'))
    try {
      const gate = await evaluateToolCallGate(base({
        lane, workDir: root, userDataDir: path.join(root, '.userdata'),
        toolName: 'list_directory', toolInput: { path: '/var/log' }
      }))
      expect(gate.readPathFact?.normalizedPath).toBe(await fs.realpath('/var/log'))
      expect(gate.readPathFact?.zone).toBe('system-dir')
      if (lane === 'desktop') expect(gate.decision).toMatchObject({ type: 'require-confirm', ruleId: 'path-system-dir-ask', answerer: 'user' })
      else expect(gate.decision).toMatchObject({ type: 'deny', ruleId: 'automation-system-dir-deny' })
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('list_directory 工作目录外目标服从 standard/strict/custom 规则且确认许可保持单层范围', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/list-directory-outside-root-'))
    const outside = await fs.realpath(await fs.mkdtemp('/tmp/list-directory-outside-target-'))
    const db = openDb()
    const input = { path: outside }
    const requestId = 'list-outside-req'
    const toolUseId = 'list-outside-tool'
    const registry = new ReadConfirmationRegistry()
    try {
      const standard = await evaluateToolCallGate(base({ appDb: db, workDir: root, userDataDir: path.join(root, '.userdata'), toolName: 'list_directory', toolInput: input }))
      expect(standard.readPathFact?.zone).toBe('outside-workdir')
      expect(standard.decision).toMatchObject({ type: 'auto-allow', ruleId: 'path-outside-readonly-allow' })
      expect(standard.readExecutionPermit?.targets[0]).toMatchObject({ scope: 'direct-entries', zone: 'outside-workdir' })

      writePolicyPackages(db, { desktop: 'strict', wechat: 'standard', feishu: 'standard', automation: 'standard' })
      const strict = await evaluateToolCallGate(base({ appDb: db, workDir: root, userDataDir: path.join(root, '.userdata'), toolName: 'list_directory', toolInput: input, requestId, toolUseId, readConfirmationRegistry: registry }))
      expect(strict.decision).toMatchObject({ type: 'require-confirm', ruleId: 'scope-strict-path-outside-readonly-allow', answerer: 'user' })
      expect(strict.readExecutionPermit).toBeUndefined()

      writePolicyPackages(db, { desktop: 'custom', wechat: 'standard', feishu: 'standard', automation: 'standard' })
      const store = new PolicyRuleStore(getDbConnection(db))
      store.setOverride({ ruleId: 'path-outside-readonly-allow', action: 'ask', params: {} })
      const customAsk = await evaluateToolCallGate(base({ appDb: db, workDir: root, userDataDir: path.join(root, '.userdata'), toolName: 'list_directory', toolInput: input, requestId: 'list-outside-custom-ask', toolUseId: 'list-outside-custom-ask-tool', readConfirmationRegistry: registry }))
      expect(customAsk.decision).toMatchObject({ type: 'require-confirm', ruleId: 'path-outside-readonly-allow', answerer: 'user' })
      const permit = finalizeReadConfirmation({ toolName: 'list_directory', toolInput: input, requestId: 'list-outside-custom-ask', toolUseId: 'list-outside-custom-ask-tool', outcome: 'approved', answerer: 'user', readPathFact: customAsk.readPathFact, approvedTargets: customAsk.readTargetMapping }, registry)
      expect(permit?.targets[0]).toMatchObject({ zone: 'outside-workdir', scope: 'direct-entries' })
      store.setOverride({ ruleId: 'path-outside-readonly-allow', action: 'deny', params: {} })
      const customDeny = await evaluateToolCallGate(base({ appDb: db, workDir: root, userDataDir: path.join(root, '.userdata'), toolName: 'list_directory', toolInput: input }))
      expect(customDeny.decision).toMatchObject({ type: 'deny', ruleId: 'path-outside-readonly-allow' })
      expect(customDeny.readExecutionPermit).toBeUndefined()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it.each(['wechat', 'feishu', 'automation'] as const)('三种读取工具的工作目录外目标在 %s lane 被 locked 规则拒绝', async (lane) => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/list-directory-remote-root-'))
    const outside = await fs.realpath(await fs.mkdtemp('/tmp/list-directory-remote-outside-'))
    const file = path.join(outside, 'note.txt')
    await fs.writeFile(file, 'needle')
    try {
      for (const toolName of ['read_file', 'grep', 'list_directory'] as const) {
        const toolInput = toolName === 'list_directory'
          ? { path: outside }
          : toolName === 'grep'
            ? { path: file, pattern: 'needle' }
            : { path: file }
        const gate = await evaluateToolCallGate(base({
          lane, workDir: root, userDataDir: path.join(root, '.userdata'), toolName, toolInput
        }))
        expect(gate.readPathFact?.zone).toBe('outside-workdir')
        expect(gate.decision).toMatchObject({ type: 'deny', ruleId: 'remote-outside-read-deny' })
        expect(gate.readExecutionPermit).toBeUndefined()
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it.each(['wechat', 'feishu', 'automation'] as const)('%s lane 的目录型和省略路径 grep 在 gate 明确拒绝且不签 permit', async (lane) => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/grep-directory-boundary-'))
    try {
      await fs.writeFile(path.join(root, 'note.txt'), 'needle')
      for (const toolInput of [{ pattern: 'needle', path: '.' }, { pattern: 'needle' }]) {
        const gate = await evaluateToolCallGate(base({ lane, workDir: root, userDataDir: path.join(root, '.userdata'), toolName: 'grep', toolInput }))
        expect(gate.readPathFact?.targetKind).toBe('directory')
        expect(gate.decision).toMatchObject({ type: 'deny', ruleId: 'read-v1-target-unsupported' })
        expect(gate.readExecutionPermit).toBeUndefined()
      }
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it.each(['wechat', 'feishu', 'automation'] as const)('大小写不同的 POSIX 目录外目标在 %s lane 对三种读取工具触发 locked 拒绝', async (lane) => {
    const parent = await fs.realpath(await fs.mkdtemp('/tmp/case-sensitive-read-'))
    const workDir = path.join(parent, 'Work')
    const outside = path.join(parent, 'work')
    try {
      await fs.mkdir(workDir)
      try { await fs.mkdir(outside) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
        throw error
      }
      const file = path.join(outside, 'secret.txt')
      await fs.writeFile(file, 'needle')
      for (const toolName of ['read_file', 'grep', 'list_directory'] as const) {
        const toolInput = toolName === 'list_directory'
          ? { path: outside }
          : toolName === 'grep'
            ? { path: file, pattern: 'needle' }
            : { path: file }
        const gate = await evaluateToolCallGate(base({
          lane, workDir, userDataDir: path.join(parent, 'user-data'), toolName, toolInput
        }))
        expect(gate.readPathFact?.zone).toBe('outside-workdir')
        expect(gate.decision).toMatchObject({ type: 'deny', ruleId: 'remote-outside-read-deny' })
        expect(gate.readExecutionPermit).toBeUndefined()
      }
    } finally {
      await fs.rm(parent, { recursive: true, force: true })
    }
  })

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

  it('写入快通道拒绝原因进入 file.auto-approve 安全审计', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/write-audit-'))
    const audit = auditSink()
    try {
      await evaluateToolCallGate(base({
        audit,
        workDir: root,
        userDataDir: path.join(root, '.userdata'),
        toolName: 'write_file',
        toolInput: { path: 'ordinary.txt', content: 'hello' },
        fileAutoApproval: async () => ({ approve: false, reason: 'oversize fixture', reasonCode: 'oversize' })
      }))
      expect(audit.events.find((event) => event.event === 'file.auto-approve')).toMatchObject({
        autoApproveOutcome: 'fallback',
        autoApproveReasonCode: 'oversize',
        reason: 'oversize fixture'
      })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('V1 auto-allow 显式返回 approvedFactIds 并绑定策略规则', async () => {
    const gate = await evaluateToolCallGate(base({ requestId: 'approval-map-req', toolUseId: 'approval-map-tool', toolInput: { path: 'a.txt' } }))
    const factId = `fact-${gate.readPathFact?.normalizedPath}`
    expect(gate.approvedFactIds).toEqual([{ factId, decisionRuleId: 'read-target-workdir-allow' }])
    expect(gate.readExecutionPermit?.targets[0]).toMatchObject({ factId, decisionRuleId: 'read-target-workdir-allow' })
  })

  it('V2 写入 gate 先生成写目标事实，越界目标即使快通道返回批准也不能自动放行', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/write-gate-root-'))
    const outside = await fs.realpath(await fs.mkdtemp('/tmp/write-gate-outside-'))
    const fileAutoApproval = vi.fn(async () => ({ approve: true as const }))
    try {
      const target = path.join(outside, 'new.txt')
      const gate = await evaluateToolCallGate(base({
        workDir: root,
        userDataDir: path.join(root, '.userdata'),
        toolName: 'write_file',
        toolInput: { path: target, content: 'new' },
        fileAutoApproval
      }))

      expect(gate.writePathFact).toMatchObject({ normalizedPath: target, zone: 'outside-workdir', targetKind: 'missing', parentReal: outside })
      expect(gate.facts.signals).toContainEqual({ kind: 'path-target', path: target, zone: 'outside-workdir' })
      expect(fileAutoApproval).toHaveBeenCalledWith(expect.objectContaining({ writePathFact: gate.writePathFact }))
      expect(gate.fileAutoApproved).toBe(false)
      expect(gate.decision.type).not.toBe('auto-allow')
      expect(gate.autoApproveFallback?.reasonCode).toBe('outside_workdir')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('V2 工作目录外写入在策略前不读取旧决策缓存', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/write-cache-root-'))
    const outside = await fs.realpath(await fs.mkdtemp('/tmp/write-cache-outside-'))
    const lookup = vi.fn(() => ({ decision: 'allow', ruleId: 'stale-allow' } as never))
    try {
      const gate = await evaluateToolCallGate(base({
        workDir: root,
        userDataDir: path.join(root, '.userdata'),
        toolName: 'write_file',
        toolInput: { path: path.join(outside, 'new.txt'), content: 'new' },
        decisionCache: { lookup, record: () => undefined, clear: () => 0, clearAllSession: () => 0, expireDormant: () => 0 },
        fileAutoApproval: async () => ({ approve: false as const, reason: 'outside', reasonCode: 'outside_workdir' })
      }))
      expect(lookup).not.toHaveBeenCalled()
      expect(gate.decision.type).toBe('require-confirm')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('V2 缺少写入路径按输入错误终局拒绝，不伪装成敏感路径确认', async () => {
    const fileAutoApproval = vi.fn(async () => ({ approve: false as const, reason: 'missing', reasonCode: 'invalid_path' as const }))
    const gate = await evaluateToolCallGate(base({
      toolName: 'write_file', toolInput: { content: 'x' }, fileAutoApproval
    }))
    expect(gate.decision).toMatchObject({ type: 'deny', ruleId: 'write-path-input-invalid' })
    expect(gate.autoApproveFallback).toMatchObject({ reasonCode: 'invalid_path' })
    expect(fileAutoApproval).toHaveBeenCalledTimes(1)
  })

  it('V2 symlink 写目标产出事实后由 gate 拒绝，不进入确认', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/write-link-gate-root-'))
    try {
      const target = path.join(root, 'target.txt')
      const link = path.join(root, 'link.txt')
      await fs.writeFile(target, 'protected')
      await fs.symlink(target, link)
      const lookup = vi.fn(() => null)
      const gate = await evaluateToolCallGate(base({ workDir: root, userDataDir: path.join(root, '.userdata'), toolName: 'write_file', toolInput: { path: link, content: 'replace' }, decisionCache: { lookup, record: () => undefined, clear: () => 0, clearAllSession: () => 0, expireDormant: () => 0 } }))
      expect(gate.writePathFact?.targetKind).toBe('symlink')
      expect(gate.decision).toMatchObject({ type: 'deny', ruleId: 'write-target-unsupported-deny' })
      expect(lookup).not.toHaveBeenCalled()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('V3 run_shell 将单次分析中的路径事实交给 locked 策略确认', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/shell-facts-root-'))
    try {
      const gate = await evaluateToolCallGate(base({ workDir: root, userDataDir: path.join(root, '.userdata'), toolName: 'run_shell', toolInput: { command: 'cat /etc/hosts' } }))
      expect(gate.facts.signals).toContainEqual(expect.objectContaining({ kind: 'path-target', zone: 'system-dir' }))
      expect(gate.facts.signals).toContainEqual({ kind: 'command-effect', effect: 'read-only' })
      expect(gate.decision).toMatchObject({ type: 'require-confirm', ruleId: 'shell-system-dir-confirm', answerer: 'user' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('run_shell gate 只分析一次，并把同一个分析对象交给预检', async () => {
    const analyzeSpy = vi.spyOn(shellAnalyzer, 'analyzeShellCommand')
    const precheck = vi.fn(async ({ analysis }: { analysis?: Awaited<ReturnType<typeof shellAnalyzer.analyzeShellCommand>> }) => ({
      ok: true as const,
      analysis: analysis!,
      legacyAutoAllowEligible: false,
      legacyPolicy: { permissionDecision: 'ask', trustedCacheKeys: [] },
      hints: { requiresRiskAck: false, outsideWorkDirRisk: false, warnings: [] }
    }))
    const gate = await evaluateToolCallGate(base({
      toolName: 'run_shell', toolInput: { command: 'cat /etc/hosts' }, runShellPrecheck: precheck as never
    }))
    expect(analyzeSpy).toHaveBeenCalledTimes(1)
    expect(precheck).toHaveBeenCalledTimes(1)
    expect(precheck.mock.calls[0]?.[0].analysis).toBe(gate.shellPrecheck?.analysis)
    expect(gate.decision).toMatchObject({ type: 'require-confirm', ruleId: 'shell-system-dir-confirm', answerer: 'user' })
  })

  it('Python 脚本 gate 只构建一次 IR 并向内容与路径提取器复用', async () => {
    await scriptParserService.ensureInitialized()
    const parseSpy = vi.spyOn(scriptParserService, 'parse')
    const gate = await evaluateToolCallGate(base({ toolName: 'run_script', toolInput: { code: 'print("hello")' } }))
    expect(parseSpy).toHaveBeenCalledTimes(1)
    expect(gate.facts.signals).toContainEqual({ kind: 'script-path-extraction', completeness: 'complete', dynamicAccess: false })
    expect(gate.decision).toMatchObject({ type: 'auto-allow', ruleId: 'script-clean-allow-desktop' })
  })

  it('V3 AST 重定向目标进入 shell 路径事实并触发敏感路径确认', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/shell-redirect-root-'))
    try {
      const target = path.join(root, '.env')
      const gate = await evaluateToolCallGate(base({ workDir: root, userDataDir: path.join(root, '.userdata'), toolName: 'run_shell', toolInput: { command: `echo secret > ${target}` } }))
      expect(gate.facts.signals).toContainEqual({ kind: 'path-target', path: target, zone: 'sensitive-file' })
      expect(gate.decision).toMatchObject({ type: 'require-confirm', ruleId: 'shell-sensitive-path-confirm', answerer: 'user' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('V3 仅对全部目标均为 outside 的只读 shell 放行，写效果仍需审批', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/shell-outside-work-'))
    const outside = await fs.realpath(await fs.mkdtemp('/tmp/shell-outside-target-'))
    const file = path.join(outside, 'note.txt')
    await fs.writeFile(file, 'hello')
    try {
      const read = await evaluateToolCallGate(base({ workDir: root, userDataDir: path.join(root, '.userdata'), toolName: 'run_shell', toolInput: { command: `cat ${file}` } }))
      expect(read.decision).toMatchObject({ type: 'auto-allow', ruleId: 'shell-outside-readonly-allow' })
      expect(read.facts.signals).toContainEqual({ kind: 'command-effect', effect: 'read-only' })

      const write = await evaluateToolCallGate(base({ workDir: root, userDataDir: path.join(root, '.userdata'), toolName: 'run_shell', toolInput: { command: `touch ${file}` } }))
      expect(write.decision.type).toBe('require-confirm')
      expect(write.decision.ruleId).not.toBe('shell-outside-readonly-allow')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it.each([
    ['strict 套餐', 'strict', 'require-confirm', false],
    ['custom ask 覆盖', 'custom', 'require-confirm', false],
    ['审批会话递归守卫', 'custom', 'deny', true]
  ] as const)('V3 目录外只读 Shell 不得覆盖%s策略', async (_label, lanePackage, expected, recursionGuard) => {
    const db = openDb()
    writePolicyPackages(db, { desktop: lanePackage, wechat: 'standard', feishu: 'standard', automation: 'standard' })
    if (lanePackage === 'custom') {
      new PolicyRuleStore(getDbConnection(db)).setOverride({ ruleId: 'shell-precheck-auto-allow', action: 'ask', params: {} })
    }
    const root = await fs.realpath(await fs.mkdtemp('/tmp/shell-outside-policy-root-'))
    const outside = await fs.realpath(await fs.mkdtemp('/tmp/shell-outside-policy-target-'))
    const file = path.join(outside, 'note.txt')
    await fs.writeFile(file, 'hello')
    try {
      const gate = await evaluateToolCallGate(base({
        appDb: db,
        workDir: root,
        userDataDir: path.join(root, '.userdata'),
        toolName: 'run_shell',
        toolInput: { command: `cat ${file}` },
        internalConfirmExemption: recursionGuard ? 'approval-agent' : undefined,
        runShellPrecheck: async () => ({
          ok: true,
          analysis: { verdict: 'allow' } as never,
          legacyAutoAllowEligible: true,
          legacyPolicy: { permissionDecision: 'allow', trustedCacheKeys: [] },
          hints: {} as never
        })
      }))
      expect(gate.decision.type).toBe(expected)
      if (expected === 'require-confirm') expect(gate.decision.ruleId).not.toBe('shell-outside-readonly-allow')
      if (expected === 'deny') expect(gate.decision.ruleId).toBe('recursion-guard')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('V3 run_script 动态文件访问在有人 lane 确认、automation lane 拒绝', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/script-facts-root-'))
    const toolInput = { code: 'custom_accessor(target)' }
    try {
      const desktop = await evaluateToolCallGate(base({ workDir: root, userDataDir: path.join(root, '.userdata'), toolName: 'run_script', toolInput }))
      expect(desktop.facts.signals).toContainEqual(expect.objectContaining({ kind: 'script-path-extraction', completeness: 'unknown' }))
      expect(desktop.decision).toMatchObject({ type: 'require-confirm', ruleId: 'script-path-unknown-confirm', answerer: 'user' })

      const unattended = await evaluateToolCallGate(base({ lane: 'automation', workDir: root, userDataDir: path.join(root, '.userdata'), toolName: 'run_script', toolInput }))
      expect(unattended.decision).toMatchObject({ type: 'deny', ruleId: 'automation-script-path-unknown-deny' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('V3 run_script 静态敏感路径与内容分析共享一次解析，并进入敏感路径真人确认规则', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/script-static-path-root-'))
    const toolInput = { code: 'open("/etc/hosts", "r")' }
    try {
      const gate = await evaluateToolCallGate(base({ workDir: root, userDataDir: path.join(root, '.userdata'), toolName: 'run_script', toolInput }))
      expect(gate.facts.signals).toContainEqual(expect.objectContaining({ kind: 'script-path-extraction', completeness: 'complete', dynamicAccess: false }))
      expect(gate.facts.signals).toContainEqual(expect.objectContaining({ kind: 'path-target', zone: 'system-dir' }))
      expect(gate.decision).toMatchObject({ type: 'require-confirm', ruleId: 'script-system-dir-confirm', answerer: 'user' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    { language: 'javascript', code: "import fs from 'node:fs'; fs.readFileSync('/etc/hosts')" },
    { language: 'typescript', code: "import { readFile } from 'node:fs/promises'; await readFile('/etc/hosts')" },
    { language: 'powershell', code: "Get-Content -LiteralPath '/etc/hosts'" }
  ])('V3 run_script $language 的路径事实进入系统目录真人确认', async ({ language, code }) => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/script-language-gate-'))
    try {
      const gate = await evaluateToolCallGate(base({
        workDir: root, userDataDir: path.join(root, '.userdata'), toolName: 'run_script', toolInput: { language, code }
      }))
      expect(gate.facts.signals).toContainEqual(expect.objectContaining({ kind: 'path-target', zone: 'system-dir' }))
      expect(gate.decision).toMatchObject({ type: 'require-confirm', ruleId: 'script-system-dir-confirm', answerer: 'user' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('V3 未经内容分析认证的非 Python 脚本需真人确认，automation 终局拒绝', async () => {
    const toolInput = { language: 'javascript', code: "console.log('hello')" }
    const desktop = await evaluateToolCallGate(base({ toolName: 'run_script', toolInput }))
    expect(desktop.facts.signals).toContainEqual({ kind: 'script-language-analysis', language: 'javascript', status: 'unverified' })
    expect(desktop.decision).toMatchObject({ type: 'require-confirm', ruleId: 'script-unverified-language-confirm', answerer: 'user' })

    const unattended = await evaluateToolCallGate(base({ lane: 'automation', toolName: 'run_script', toolInput }))
    expect(unattended.decision).toMatchObject({ type: 'deny', ruleId: 'automation-unverified-script-language-deny' })

    const unsupported = await evaluateToolCallGate(base({ toolName: 'run_script', toolInput: { language: 'ruby', code: 'puts 1' } }))
    expect(unsupported.facts.signals).toContainEqual({ kind: 'script-language-analysis', language: 'unknown', status: 'unverified' })
    expect(unsupported.facts.signals).toContainEqual({ kind: 'script-path-extraction', completeness: 'unknown', dynamicAccess: true })
    expect(unsupported.decision).toMatchObject({ type: 'require-confirm', answerer: 'user' })
  })

  it('T4-1 自定义敏感前缀由 gate facts 和策略环境读取同一 shellConfig', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/custom-sensitive-gate-'))
    const customDir = path.join(root, 'private')
    await fs.mkdir(customDir)
    const target = path.join(customDir, 'token.txt')
    await fs.writeFile(target, 'secret')
    try {
      const gate = await evaluateToolCallGate(base({
        workDir: root,
        userDataDir: path.join(root, '.userdata'),
        toolName: 'read_file',
        toolInput: { path: target },
        shellConfig: { ...DEFAULT_SHELL_CONFIG, customSensitivePrefixes: [customDir] }
      }))
      expect(gate.readPathFact).toMatchObject({ zone: 'sensitive-file', normalizedPath: target })
      expect(gate.decision).toMatchObject({ type: 'require-confirm', ruleId: 'path-sensitive-read-confirm', answerer: 'user' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('V4 wiki raw 写目标在策略层 locked deny', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/wiki-policy-root-'))
    try {
      const gate = await evaluateToolCallGate(base({
        workDir: root,
        userDataDir: path.join(root, '.userdata'),
        wikiConfig: { ...DEFAULT_WIKI_CONFIG, enabled: true },
        toolName: 'write_file',
        toolInput: { path: 'llm-wiki/raw/source.md', content: 'overwrite' }
      }))
      expect(gate.facts.signals).toContainEqual({ kind: 'wiki-raw-target' })
      expect(gate.decision).toMatchObject({ type: 'deny', ruleId: 'wiki-raw-write-deny' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('V4 飞书附件 symlink 越出 feishu-media 时由策略事实 locked deny', async () => {
    const userDataDir = await fs.realpath(await fs.mkdtemp('/tmp/feishu-media-gate-'))
    const outside = await fs.realpath(await fs.mkdtemp('/tmp/feishu-media-outside-'))
    const mediaRoot = path.join(userDataDir, 'feishu-media')
    await fs.mkdir(mediaRoot)
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret')
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(mediaRoot, 'escape.txt'))
    try {
      const gate = await evaluateToolCallGate(base({
        lane: 'feishu', remoteContext: remoteContext({ feishuAttachments: [attachmentRegistration(path.join(mediaRoot, 'escape.txt'))] }), userDataDir,
        toolName: 'read_feishu_attachment', toolInput: { attachmentId: 'attachment-1' }
      }))
      expect(gate.facts.signals).toContainEqual({ kind: 'feishu-media-target', boundary: 'unknown' })
      expect(gate.decision).toMatchObject({ type: 'deny', ruleId: 'feishu-media-boundary-unknown-deny' })
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('V4 飞书媒体目录内普通附件由 gate 捕获文件身份并下发执行许可', async () => {
    const userDataDir = await fs.realpath(await fs.mkdtemp('/tmp/feishu-media-permit-'))
    const mediaRoot = path.join(userDataDir, 'feishu-media')
    await fs.mkdir(mediaRoot)
    await fs.writeFile(path.join(mediaRoot, 'ok.txt'), 'attachment')
    try {
      const input = { attachmentId: 'attachment-1' }
      const gate = await evaluateToolCallGate(base({
        lane: 'feishu', remoteContext: remoteContext({ feishuAttachments: [attachmentRegistration(path.join(mediaRoot, 'ok.txt'))] }), userDataDir,
        toolName: 'read_feishu_attachment', toolInput: input
      }))
      expect(gate.decision.type).toBe('auto-allow')
      expect(gate.readExecutionPermit).toMatchObject({
        toolName: 'read_feishu_attachment',
        input,
        targets: [{ targetKind: 'file', normalizedPath: path.join(mediaRoot, 'ok.txt'), identity: { dev: expect.any(Number), ino: expect.any(Number) } }]
      })
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('V4 策略要求用户确认时，飞书附件 gate 登记目标并在批准后生成 permit', async () => {
    const userDataDir = await fs.realpath(await fs.mkdtemp('/tmp/feishu-media-confirm-'))
    const mediaRoot = path.join(userDataDir, 'feishu-media')
    await fs.mkdir(mediaRoot)
    await fs.writeFile(path.join(mediaRoot, 'ok.txt'), 'attachment')
    const registry = new ReadConfirmationRegistry()
    const toolInput = { attachmentId: 'attachment-1' }
    const requestId = 'feishu-confirm-req'
    const toolUseId = 'feishu-confirm-tool'
    const effectiveRules = [...DEFAULT_POLICY_RULES, {
      id: 'test-feishu-attachment-confirm',
      when: 'invocation' as const,
      match: { lane: ['feishu' as const], toolName: 'read_feishu_attachment', signals: ['feishu-media-target:inside'] },
      action: 'ask' as const,
      reason: 'test user confirmation'
    }]
    try {
      const gate = await evaluateToolCallGate(base({
        lane: 'feishu', remoteContext: remoteContext({ feishuAttachments: [attachmentRegistration(path.join(mediaRoot, 'ok.txt'))] }), userDataDir,
        toolName: 'read_feishu_attachment', toolInput,
        requestId, toolUseId, effectiveRules, lanePackage: 'standard', readConfirmationRegistry: registry
      }))
      expect(gate.decision).toMatchObject({ type: 'require-confirm', answerer: 'user', ruleId: 'test-feishu-attachment-confirm' })
      expect(gate.readExecutionPermit).toBeUndefined()
      expect(gate.readTargetMapping).toHaveLength(1)
      const permit = finalizeReadConfirmation({
        toolName: 'read_feishu_attachment', toolInput,
        requestId, toolUseId, outcome: 'approved', answerer: 'user',
        feishuMediaFact: gate.feishuMediaFact, approvedTargets: gate.readTargetMapping
      }, registry)
      expect(permit).toMatchObject({ toolName: 'read_feishu_attachment', targets: [{ targetKind: 'file', identity: { dev: expect.any(Number), ino: expect.any(Number) } }] })
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('V4 媒体目录中的文件未登记到当前消息时不能生成 permit', async () => {
    const userDataDir = await fs.realpath(await fs.mkdtemp('/tmp/feishu-media-unregistered-'))
    const mediaRoot = path.join(userDataDir, 'feishu-media')
    await fs.mkdir(mediaRoot)
    await fs.writeFile(path.join(mediaRoot, 'private.txt'), 'not attached to this message')
    try {
      const gate = await evaluateToolCallGate(base({
        lane: 'feishu', remoteContext: remoteContext(), userDataDir,
        toolName: 'read_feishu_attachment', toolInput: { attachmentId: 'private.txt', relativePath: 'private.txt' }
      }))
      expect(gate.facts.signals).toContainEqual({ kind: 'feishu-media-target', boundary: 'outside' })
      expect(gate.decision).toMatchObject({ type: 'deny', ruleId: 'feishu-media-boundary-deny' })
      expect(gate.readExecutionPermit).toBeUndefined()
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('V4 gate 后媒体父目录切换到外部附件时，执行器校验 permit identity 并拒绝读取', async () => {
    const userDataDir = await fs.realpath(await fs.mkdtemp('/tmp/feishu-media-permit-race-'))
    const outside = await fs.realpath(await fs.mkdtemp('/tmp/feishu-media-permit-race-outside-'))
    const mediaRoot = path.join(userDataDir, 'feishu-media')
    const mediaParent = path.join(mediaRoot, 'cache')
    const movedParent = path.join(mediaRoot, 'cache-original')
    await fs.mkdir(mediaParent, { recursive: true })
    await fs.writeFile(path.join(mediaParent, 'message.txt'), 'approved inside')
    await fs.writeFile(path.join(outside, 'message.txt'), 'secret outside')
    try {
      const input = { attachmentId: 'attachment-1' }
      const gate = await evaluateToolCallGate(base({
        lane: 'feishu', remoteContext: remoteContext({ feishuAttachments: [attachmentRegistration(path.join(mediaParent, 'message.txt'))] }), userDataDir,
        toolName: 'read_feishu_attachment', toolInput: input
      }))
      expect(gate.readExecutionPermit).toBeDefined()
      await fs.rename(mediaParent, movedParent)
      await fs.symlink(outside, mediaParent, process.platform === 'win32' ? 'junction' : 'dir')
      const result = await readFeishuAttachmentExecutor.execute(input, {
        userDataDir,
        requestId: gate.readExecutionPermit!.requestId,
        toolUseId: gate.readExecutionPermit!.toolUseId,
        readExecutionPermit: gate.readExecutionPermit,
        remoteContext: remoteContext({ feishuAttachments: [attachmentRegistration(path.join(mediaParent, 'message.txt'))] })
      } as ToolExecutionContext)
      expect(result).toMatchObject({ success: false, diagnostic: { caseId: 'read-target-path-mismatch' } })
      expect(JSON.stringify(result)).not.toContain('secret outside')
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it.each([
    { name: '附件编号未登记', attachmentId: 'unregistered', boundary: 'outside', ruleId: 'feishu-media-boundary-deny' },
    { name: '已登记附件文件缺失', attachmentId: 'attachment-1', boundary: 'unknown', ruleId: 'feishu-media-boundary-unknown-deny' }
  ] as const)('V4 飞书附件 $name 在策略层终局拒绝', async ({ attachmentId, boundary, ruleId }) => {
    const userDataDir = await fs.realpath(await fs.mkdtemp('/tmp/feishu-media-case-'))
    const mediaRoot = path.join(userDataDir, 'feishu-media')
    await fs.mkdir(mediaRoot)
    const attachments = boundary === 'unknown' ? [attachmentRegistration(path.join(mediaRoot, 'missing.txt'))] : []
    try {
      const gate = await evaluateToolCallGate(base({
        lane: 'feishu', remoteContext: remoteContext({ feishuAttachments: attachments }), userDataDir,
        toolName: 'read_feishu_attachment', toolInput: { attachmentId }
      }))
      expect(gate.facts.signals).toContainEqual({ kind: 'feishu-media-target', boundary })
      expect(gate.decision).toMatchObject({ type: 'deny', ruleId })
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('V4 remote system read 进入真人确认，automation 写入和 shell 终局拒绝', async () => {
    const root = await fs.realpath(await fs.mkdtemp('/tmp/lane-matrix-root-'))
    const outside = await fs.realpath(await fs.mkdtemp('/tmp/lane-matrix-outside-'))
    try {
      const remoteRead = await evaluateToolCallGate(base({ lane: 'feishu', workDir: root, userDataDir: path.join(root, '.userdata'), toolName: 'read_file', toolInput: { path: '/etc/hosts' } }))
      expect(remoteRead.decision).toMatchObject({ type: 'require-confirm', answerer: 'user' })

      const automationWrite = await evaluateToolCallGate(base({ lane: 'automation', workDir: root, userDataDir: path.join(root, '.userdata'), toolName: 'write_file', toolInput: { path: path.join(outside, 'new.txt'), content: 'x' } }))
      expect(automationWrite.decision).toMatchObject({ type: 'deny', ruleId: 'automation-write-deny' })

      const automationShell = await evaluateToolCallGate(base({ lane: 'automation', workDir: root, userDataDir: path.join(root, '.userdata'), toolName: 'run_shell', toolInput: { command: 'pwd' } }))
      expect(automationShell.decision).toMatchObject({ type: 'deny', ruleId: 'automation-shell-deny' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('V4 automation 对敏感/系统读取及飞书媒体越界在显式只读 allow 前终局拒绝', async () => {
    const workDir = await fs.realpath(await fs.mkdtemp('/tmp/automation-boundary-work-'))
    const userDataDir = await fs.realpath(await fs.mkdtemp('/tmp/automation-boundary-user-'))
    const mediaRoot = path.join(userDataDir, 'feishu-media')
    await fs.mkdir(mediaRoot)
    await fs.writeFile(path.join(mediaRoot, 'ok.txt'), 'safe')
    await fs.writeFile(path.join(workDir, '.env'), 'secret')
    try {
      const staleAllowLookup = vi.fn(() => ({ decision: 'allow', ruleId: 'stale-persistent-allow' } as never))
      const sensitive = await evaluateToolCallGate(base({
        lane: 'automation', workDir, userDataDir, toolName: 'read_file', toolInput: { path: '.env' },
        decisionCache: { lookup: staleAllowLookup, record: () => undefined, clear: () => 0, clearAllSession: () => 0, expireDormant: () => 0 }
      }))
      expect(sensitive.decision).toMatchObject({ type: 'deny', ruleId: 'automation-sensitive-path-deny' })
      expect(staleAllowLookup).not.toHaveBeenCalled()

      const system = await evaluateToolCallGate(base({ lane: 'automation', workDir, userDataDir, toolName: 'read_file', toolInput: { path: '/etc/hosts' } }))
      expect(system.decision).toMatchObject({ type: 'deny', ruleId: 'automation-system-dir-deny' })

      const unregisteredMedia = await evaluateToolCallGate(base({ lane: 'automation', workDir, userDataDir, toolName: 'read_feishu_attachment', toolInput: { attachmentId: 'attachment-1' } }))
      expect(unregisteredMedia.facts.signals).toContainEqual({ kind: 'feishu-media-target', boundary: 'outside' })
      expect(unregisteredMedia.decision).toMatchObject({ type: 'deny', ruleId: 'feishu-media-boundary-deny' })

      const unknownMedia = await evaluateToolCallGate(base({ lane: 'automation', workDir, userDataDir, toolName: 'read_feishu_attachment', toolInput: { attachmentId: 'attachment-1' }, remoteContext: remoteContext({ feishuAttachments: [attachmentRegistration(path.join(mediaRoot, 'missing.txt'))] }) }))
      expect(unknownMedia.facts.signals).toContainEqual({ kind: 'feishu-media-target', boundary: 'unknown' })
      expect(unknownMedia.decision).toMatchObject({ type: 'deny', ruleId: 'feishu-media-boundary-unknown-deny' })
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
      await fs.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('V4 远程切换敏感工作目录时按宿主事实在策略层 locked deny', async () => {
    const gate = await evaluateToolCallGate(base({
      lane: 'feishu', remoteContext: remoteContext(), toolName: 'switch_work_dir',
      toolInput: { profile_id: 'sensitive-profile' },
      factsProvider: () => [{ kind: 'workdir-profile-target', status: 'sensitive' }]
    }))
    expect(gate.facts.signals).toContainEqual({ kind: 'workdir-profile-target', status: 'sensitive' })
    expect(gate.decision).toMatchObject({ type: 'deny', ruleId: 'remote-sensitive-workdir-switch-deny' })
  })

  it('V4 缺少远程工作目录敏感性事实时 fail closed', async () => {
    const gate = await evaluateToolCallGate(base({
      lane: 'feishu', remoteContext: remoteContext(), toolName: 'switch_work_dir',
      toolInput: { profile_id: 'unknown-profile' }
    }))
    expect(gate.facts.signals).toContainEqual({ kind: 'workdir-profile-target', status: 'unknown' })
    expect(gate.decision).toMatchObject({ type: 'deny', ruleId: 'remote-unknown-workdir-switch-deny' })
  })

  it('V4 生产事实提供器遇到不存在的 profile 时产出 unknown 并由策略拒绝', async () => {
    const profiles = [{ id: 'normal-profile', name: 'Normal', path: '/normal' }]
    const gate = await evaluateToolCallGate(base({
      lane: 'feishu', remoteContext: remoteContext(), toolName: 'switch_work_dir',
      toolInput: { profile_id: 'missing-profile' },
      factsProvider: ({ toolInput }) => {
        const status = classifyWorkDirProfileTarget({ profile_id: String(toolInput.profile_id ?? '') }, profiles)
        return [{ kind: 'workdir-profile-target', status: status ?? 'unknown' }]
      }
    }))
    expect(gate.facts.signals).toContainEqual({ kind: 'workdir-profile-target', status: 'unknown' })
    expect(gate.decision).toMatchObject({ type: 'deny', ruleId: 'remote-unknown-workdir-switch-deny' })
  })

  it('桌面 read_file 在生产 gate 中产出路径事实信号', async () => {
    const r = await evaluateToolCallGate(base({ requestId: 'req-1', toolUseId: 'tool-1', toolInput: { path: 'a.txt' } }))
    expect(r.facts.signals).toContainEqual({
      kind: 'path-target',
      path: '/private/tmp/wd/a.txt',
      zone: 'workdir-normal'
    })
  })

  it('显式空路径也经过 facts 探测并 fail closed', async () => {
    const gate = await evaluateToolCallGate(base({ toolName: 'read_file', toolInput: { path: '' } }))
    expect(gate.decision.type).toBe('deny')
    expect(gate.decision.ruleId).toBe('read-v1-facts-missing')
  })

  it('V1 gate 每次调用仅探测一次读取路径事实', async () => {
    const probe = vi.spyOn(readPathFacts, 'probeReadPathFact')
    try {
      const gate = await evaluateToolCallGate(base({ requestId: 'single-probe-req', toolUseId: 'single-probe-tool', toolInput: { path: 'a.txt' } }))
      expect(gate.readPathFact).toBeDefined()
      expect(probe).toHaveBeenCalledTimes(1)
    } finally {
      probe.mockRestore()
    }
  })

  it('路径探测遇到 EACCES 时以环境错误终局拒绝且不生成 permit 或确认登记', async () => {
    const file = '/tmp/wd/blocked.txt'
    const originalLstat = fs.lstat.bind(fs)
    const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (target, ...args) => {
      if (String(target) === file) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      return originalLstat(target, ...args)
    })
    const registry = new ReadConfirmationRegistry()
    const registerSpy = vi.spyOn(registry, 'register')
    try {
      const gate = await evaluateToolCallGate(base({
        requestId: 'probe-error-req', toolUseId: 'probe-error-tool',
        toolInput: { path: file }, readConfirmationRegistry: registry
      }))
      expect(gate.decision).toMatchObject({ type: 'deny', ruleId: 'read-path-probe-environment-error' })
      expect(gate.readPathFact).toBeUndefined()
      expect(gate.readExecutionPermit).toBeUndefined()
      expect(gate.facts.signals).not.toContainEqual(expect.objectContaining({ kind: 'path-target' }))
      expect(registerSpy).not.toHaveBeenCalled()
    } finally {
      registerSpy.mockRestore()
      lstatSpy.mockRestore()
    }
  })

  it('桌面 read_file 敏感路径进入真人确认规则', async () => {
    const audit = auditSink()
    const r = await evaluateToolCallGate(base({ audit, toolInput: { path: '.env' } }))
    expect(r.decision).toMatchObject({ type: 'require-confirm', ruleId: 'path-sensitive-read-confirm', answerer: 'user' })
    expect(audit.events.find((e) => e.event === 'policy.decision')).toMatchObject({ pathZones: ['sensitive-file'] })
    expect(JSON.stringify(audit.events)).not.toContain('.env')
  })

  it('userDataDir 与自定义敏感前缀都在 gate 中进入真人确认', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'read-gate-sensitive-zones-')))
    try {
      const userDataDir = path.join(root, '.userdata')
      const customDir = path.join(root, 'private-config')
      await fs.mkdir(userDataDir, { recursive: true })
      await fs.mkdir(customDir, { recursive: true })
      const userDataFile = path.join(userDataDir, 'session.json')
      const customFile = path.join(customDir, 'token.json')
      await fs.writeFile(userDataFile, '{}')
      await fs.writeFile(customFile, '{}')

      const userDataGate = await evaluateToolCallGate(base({ workDir: root, userDataDir, toolInput: { path: userDataFile } }))
      const customGate = await evaluateToolCallGate(base({ workDir: root, userDataDir, toolInput: { path: customFile }, shellConfig: { customSensitivePrefixes: [customDir] } as never }))
      expect(userDataGate).toMatchObject({ decision: { type: 'require-confirm', answerer: 'user' }, readPathFact: { zone: 'sensitive-file' } })
      expect(customGate).toMatchObject({ decision: { type: 'require-confirm', answerer: 'user' }, readPathFact: { zone: 'sensitive-file' } })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('工作目录 symlink 指向外部时 gate 以真实目标 zone 生成 permit', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'read-gate-link-root-')))
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'read-gate-link-out-')))
    try {
      const target = path.join(outside, 'note.txt')
      const link = path.join(root, 'link.txt')
      await fs.writeFile(target, 'outside')
      await fs.symlink(target, link)
      const gate = await evaluateToolCallGate(base({ workDir: root, userDataDir: path.join(root, '.userdata'), toolInput: { path: link } }))
      expect(gate.readPathFact).toMatchObject({ targetKind: 'symlink', normalizedPath: target, zone: 'outside-workdir' })
      expect(gate.decision).toMatchObject({ type: 'auto-allow', ruleId: 'path-outside-readonly-allow' })
      expect(gate.readExecutionPermit?.targets[0]).toMatchObject({ factId: `fact-${target}`, normalizedPath: target, zone: 'outside-workdir' })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('敏感读取先登记 pending，只有批准后才生成一次性 permit', async () => {
    const registry = new ReadConfirmationRegistry()
    const toolInput = { path: '.env' }
    const gate = await evaluateToolCallGate(base({ requestId: 'confirm-flow-req', toolUseId: 'confirm-flow-tool', readConfirmationRegistry: registry, toolInput }))
    expect(gate.decision).toMatchObject({ type: 'require-confirm', answerer: 'user' })
    expect(gate.readExecutionPermit).toBeUndefined()
    expect(gate.approvedFactIds).toEqual([])
    const permit = finalizeReadConfirmation({ toolName: 'read_file', toolInput, requestId: 'confirm-flow-req', toolUseId: 'confirm-flow-tool', outcome: 'approved', answerer: 'user', readPathFact: gate.readPathFact, approvedTargets: gate.readTargetMapping }, registry)
    expect(permit?.targets).toHaveLength(1)
    expect(finalizeReadConfirmation({ toolName: 'read_file', toolInput, requestId: 'confirm-flow-req', toolUseId: 'confirm-flow-tool', outcome: 'approved', answerer: 'user', readPathFact: gate.readPathFact, approvedTargets: gate.readTargetMapping }, registry)).toBeUndefined()
  })

  it('真人确认等待超过 2 分钟后仍可在 5 分钟期限内批准读取', async () => {
    vi.useFakeTimers()
    try {
      const registry = new ReadConfirmationRegistry()
      const toolInput = { path: '.env' }
      const gate = await evaluateToolCallGate(base({ requestId: 'long-confirm-req', toolUseId: 'long-confirm-tool', readConfirmationRegistry: registry, toolInput }))
      await vi.advanceTimersByTimeAsync(150_000)
      const permit = finalizeReadConfirmation({ toolName: 'read_file', toolInput, requestId: 'long-confirm-req', toolUseId: 'long-confirm-tool', outcome: 'approved', answerer: 'user', readPathFact: gate.readPathFact, approvedTargets: gate.readTargetMapping }, registry)
      expect(permit?.targets[0]?.decisionRuleId).toBe('path-sensitive-read-confirm')
    } finally { vi.useRealTimers() }
  })

  it('Windows 非 C 系统目录进入真人确认，其他盘符外部路径仍自动放行', async () => {
    vi.stubEnv('SystemRoot', 'D:\\CustomWindows')
    try {
      const system = await evaluateToolCallGate(base({ toolInput: { path: 'D:\\CustomWindows\\System32\\config\\SAM' } }))
      expect(system.readPathFact?.zone).toBe('system-dir')
      expect(system.decision).toMatchObject({ type: 'require-confirm', ruleId: 'path-system-dir-ask', answerer: 'user' })

      const outside = await evaluateToolCallGate(base({ toolInput: { path: 'E:\\Documents\\notes.txt' } }))
      expect(outside.readPathFact?.zone).toBe('outside-workdir')
      expect(outside.decision).toMatchObject({ type: 'auto-allow', ruleId: 'path-outside-readonly-allow' })
    } finally { vi.unstubAllEnvs() }
  })

  it('同一请求中的两个敏感读取各自完成 gate → 批准 → permit', async () => {
    const registry = new ReadConfirmationRegistry()
    const firstInput = { path: '.env' }
    const secondInput = { path: '.env' }
    const first = await evaluateToolCallGate(base({ requestId: 'multi-read-req', toolUseId: 'read-1', readConfirmationRegistry: registry, toolInput: firstInput }))
    const second = await evaluateToolCallGate(base({ requestId: 'multi-read-req', toolUseId: 'read-2', readConfirmationRegistry: registry, toolInput: secondInput }))
    expect(first.readExecutionPermit).toBeUndefined()
    expect(second.readExecutionPermit).toBeUndefined()
    const firstPermit = finalizeReadConfirmation({ toolName: 'read_file', toolInput: firstInput, requestId: 'multi-read-req', toolUseId: 'read-1', outcome: 'approved', answerer: 'user', readPathFact: first.readPathFact, approvedTargets: first.readTargetMapping }, registry)
    const secondPermit = finalizeReadConfirmation({ toolName: 'read_file', toolInput: secondInput, requestId: 'multi-read-req', toolUseId: 'read-2', outcome: 'approved', answerer: 'user', readPathFact: second.readPathFact, approvedTargets: second.readTargetMapping }, registry)
    expect(firstPermit?.requestId).toBe('multi-read-req')
    expect(secondPermit?.requestId).toBe('multi-read-req')
    expect(firstPermit?.toolUseId).toBe('read-1')
    expect(secondPermit?.toolUseId).toBe('read-2')
  })

  it('desktop read V1 不读取旧策略缓存', async () => {
    const lookup = vi.fn(() => null)
    await evaluateToolCallGate(base({ decisionCache: { lookup, record: () => undefined, clear: () => 0, clearAllSession: () => 0, expireDormant: () => 0 } }))
    expect(lookup).not.toHaveBeenCalled()
  })

  it('desktop read V1 拒绝目录 grep、通配路径和缺失路径', async () => {
    const directory = await evaluateToolCallGate(base({ toolName: 'grep', toolInput: { path: '.', pattern: 'x' } }))
    const wildcard = await evaluateToolCallGate(base({ toolName: 'grep', toolInput: { path: '**/*.ts', pattern: 'x' } }))
    const multiplePaths = await evaluateToolCallGate(base({ toolName: 'grep', toolInput: { path: 'src/a.ts', paths: ['src/a.ts', 'src/b.ts'], pattern: 'x' } }))
    const missing = await evaluateToolCallGate(base({ toolInput: {} }))
    expect(directory.decision).toMatchObject({ type: 'deny', ruleId: 'read-v1-target-unsupported' })
    expect(wildcard.decision).toMatchObject({ type: 'deny', ruleId: 'read-v1-target-unsupported' })
    expect(wildcard.readPathFact?.targetKind).toBe('unknown')
    expect(multiplePaths.decision).toMatchObject({ type: 'deny', ruleId: 'read-v1-target-unsupported' })
    expect(multiplePaths.readPathFact?.targetKind).toBe('unknown')
    expect(missing.decision).toMatchObject({ type: 'deny', ruleId: 'read-v1-facts-missing' })
    expect(directory.readExecutionPermit).toBeUndefined()
    expect(wildcard.readExecutionPermit).toBeUndefined()
    expect(multiplePaths.readExecutionPermit).toBeUndefined()
    expect(missing.readExecutionPermit).toBeUndefined()
  })

  it.each([
    { filePath: '.env' },
    { file_path: '.env' },
    { path: '', file_path: '.env' }
  ])('路径别名 %o 仍进入敏感确认', async (toolInput) => {
    const r = await evaluateToolCallGate(base({ toolInput }))
    expect(r.decision).toMatchObject({ type: 'require-confirm', ruleId: 'path-sensitive-read-confirm', answerer: 'user' })
  })

  it('远程 read_file 敏感路径也进入真人确认规则', async () => {
    const r = await evaluateToolCallGate(base({ remoteContext: remoteContext(), toolInput: { file_path: '.env' } }))
    expect(r.decision).toMatchObject({ type: 'require-confirm', ruleId: 'path-sensitive-read-confirm', answerer: 'user' })
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
    const rawSecretPath = '/Users/private/customer-data.txt'
    const r = await evaluateToolCallGate(
      base({
        requestId: 'shell-precheck-request',
        toolUseId: 'shell-precheck-tool',
        toolName: 'run_shell',
        toolInput: { command: `cat ${rawSecretPath}` },
        audit,
        runShellPrecheck: async () => ({
          ok: false,
          error: '命令未通过安全检查',
          auditReason: `security_deny: ${rawSecretPath}`,
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
      requestId: 'shell-precheck-request',
      toolUseId: 'shell-precheck-tool',
      reason: 'shell-precheck-deny:strong'
    })
    expect(JSON.stringify(evt)).not.toContain(rawSecretPath)
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

  it.each(['feishu', 'wechat'] as const)('%s 越界 write_file/edit_file 在 gate 策略层终局拒绝', async (lane) => {
    const workDir = await fs.realpath(await fs.mkdtemp('/tmp/remote-write-work-'))
    const outside = await fs.realpath(await fs.mkdtemp('/tmp/remote-write-outside-'))
    const lookup = vi.fn(() => ({ decision: 'allow', ruleId: 'stale-remote-write-allow' } as never))
    try {
      for (const toolName of ['write_file', 'edit_file'] as const) {
        const gate = await evaluateToolCallGate(base({
          lane,
          remoteContext: remoteContext({ source: lane }),
          workDir,
          userDataDir: path.join(workDir, '.userdata'),
          toolName,
          toolInput: toolName === 'write_file'
            ? { path: path.join(outside, 'new.txt'), content: 'x' }
            : { path: path.join(outside, 'existing.txt'), old_string: 'a', new_string: 'b' },
          decisionCache: { lookup, record: () => undefined, clear: () => 0, clearAllSession: () => 0, expireDormant: () => 0 }
        }))
        expect(gate.writePathFact?.zone).toBe('outside-workdir')
        expect(gate.facts.signals).toContainEqual({ kind: 'write-target-scope', scope: 'outside-workdir' })
        expect(gate.decision).toMatchObject({ type: 'deny', ruleId: 'remote-outside-write-deny' })
        expect(gate.writeExecutionPermit).toBeUndefined()
      }
      expect(lookup).not.toHaveBeenCalled()
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('微信发送附件的外部 symlink 目标在 gate 被拒绝并写入脱敏路径事实', async () => {
    const workDir = await fs.realpath(await fs.mkdtemp('/tmp/wechat-media-work-'))
    const outside = await fs.realpath(await fs.mkdtemp('/tmp/wechat-media-outside-'))
    const privateFile = path.join(outside, 'private-report.txt')
    const linkedFile = path.join(workDir, 'report.txt')
    const audit = auditSink()
    const staleLookup = vi.fn(() => ({ decision: 'allow', ruleId: 'stale-wechat-media-allow' } as never))
    await fs.writeFile(privateFile, 'private content')
    await fs.symlink(privateFile, linkedFile)
    try {
      const gate = await evaluateToolCallGate(base({
        lane: 'wechat', remoteContext: remoteContext({ source: 'wechat' }), workDir,
        userDataDir: path.join(workDir, '.userdata'), toolName: 'wechat_send',
        toolInput: { userId: 'recipient', text: 'report', filePath: 'report.txt' }, audit,
        decisionCache: { lookup: staleLookup, record: () => undefined, clear: () => 0, clearAllSession: () => 0, expireDormant: () => 0 }
      }))

      expect(gate.facts.signals).toContainEqual(expect.objectContaining({ kind: 'wechat-media-target', boundary: 'outside-workdir', zone: 'outside-workdir', targetKind: 'symlink' }))
      expect(gate.decision).toMatchObject({ type: 'deny', ruleId: 'remote-wechat-media-outside-deny' })
      expect(audit.events.find((event) => event.event === 'policy.decision')).toMatchObject({ pathZones: ['outside-workdir'] })
      expect(JSON.stringify(audit.events)).not.toContain(privateFile)
      expect(staleLookup).not.toHaveBeenCalled()
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('微信发送工作目录内普通附件继续服从既有出站规则', async () => {
    const workDir = await fs.realpath(await fs.mkdtemp('/tmp/wechat-media-inside-'))
    const mediaFile = path.join(workDir, 'report.txt')
    await fs.writeFile(mediaFile, 'shareable')
    try {
      const gate = await evaluateToolCallGate(base({
        lane: 'wechat', remoteContext: remoteContext({ source: 'wechat' }), workDir,
        userDataDir: path.join(workDir, '.userdata'), toolName: 'wechat_send',
        toolInput: { userId: 'recipient', text: 'report', filePath: 'report.txt' }
      }))

      expect(gate.facts.signals).toContainEqual(expect.objectContaining({ kind: 'wechat-media-target', boundary: 'inside-workdir', zone: 'workdir-normal', targetKind: 'file' }))
      expect(gate.decision.type).toBe('auto-allow')
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('微信附件路径事实探测失败时拒绝且不查询旧缓存', async () => {
    const workDir = await fs.realpath(await fs.mkdtemp('/tmp/wechat-media-probe-error-'))
    const blockedPath = path.join(workDir, 'blocked.txt')
    const originalLstat = fs.lstat.bind(fs)
    const lstatSpy = vi.spyOn(fs, 'lstat').mockImplementation(async (target, ...args) => {
      if (String(target) === blockedPath) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      return originalLstat(target, ...args)
    })
    const staleLookup = vi.fn(() => ({ decision: 'allow', ruleId: 'stale-wechat-media-allow' } as never))
    try {
      const gate = await evaluateToolCallGate(base({
        lane: 'wechat', remoteContext: remoteContext({ source: 'wechat' }), workDir,
        userDataDir: path.join(workDir, '.userdata'), toolName: 'wechat_send',
        toolInput: { userId: 'recipient', text: 'report', filePath: 'blocked.txt' },
        decisionCache: { lookup: staleLookup, record: () => undefined, clear: () => 0, clearAllSession: () => 0, expireDormant: () => 0 }
      }))

      expect(gate.facts.signals).toContainEqual(expect.objectContaining({ kind: 'wechat-media-target', boundary: 'unknown', targetKind: 'unknown' }))
      expect(gate.decision).toMatchObject({ type: 'deny', ruleId: 'remote-wechat-media-unknown-deny' })
      expect(staleLookup).not.toHaveBeenCalled()
    } finally {
      lstatSpy.mockRestore()
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it.each([
    { path: '/etc/spaceassistant-policy-test-new-file', zone: 'system-dir', scope: 'outside-workdir', decision: { type: 'deny', ruleId: 'remote-outside-write-deny' } },
    { path: '.env', zone: 'sensitive-file', scope: 'inside-workdir', decision: { type: 'require-confirm', ruleId: 'im-write-ask' } }
  ] as const)('远程写入 $zone 目标按真实工作目录范围裁决', async ({ path: target, zone, scope, decision }) => {
    const workDir = await fs.realpath(await fs.mkdtemp('/tmp/remote-write-special-work-'))
    try {
      const gate = await evaluateToolCallGate(base({
        lane: 'feishu', remoteContext: remoteContext(), workDir, userDataDir: path.join(workDir, '.userdata'),
        toolName: 'write_file', toolInput: { path: target, content: 'x' }
      }))
      expect(gate.writePathFact?.zone).toBe(zone)
      expect(gate.facts.signals).toContainEqual({ kind: 'write-target-scope', scope })
      expect(gate.decision).toMatchObject(decision)
      if (decision.type === 'deny') expect(gate.writeExecutionPermit).toBeUndefined()
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
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
