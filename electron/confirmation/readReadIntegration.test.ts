import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))
const rgAvailability = vi.hoisted(() => ({ unavailable: false }))
vi.mock('../tools/ripgrepBinary', async (importActual) => {
  const actual = await importActual<typeof import('../tools/ripgrepBinary')>()
  return { ...actual, resolveRipgrepBinary: () => ({ path: 'fixture-rg', source: 'development', platform: process.platform, arch: process.arch }), inspectRipgrepBinary: async () => rgAvailability.unavailable ? ({ available: false, reason: 'not_found' as const }) : ({ available: true }) }
})

import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { FileStateCache } from '../fileStateCache'
import { finalizeReadConfirmation } from './readConfirmationFlow'
import { ReadConfirmationRegistry } from './readConfirmationRegistry'
import { evaluateToolCallGate } from './toolCallGate'
import { grepExecutor, listDirectoryExecutor, readFileExecutor } from '../tools/builtinExecutors'
import { validateReadExecutionBoundary } from './readExecutionBoundary'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'
import type { ToolExecutionContext } from '../tools/types'

function gateDeps(root: string, input: Record<string, unknown>, requestId: string, toolUseId: string, registry: ReadConfirmationRegistry, toolName = 'read_file', policy?: { effectiveRules?: typeof DEFAULT_POLICY_RULES; lanePackage?: 'strict' | 'standard' | 'loose' | 'custom' }, audit: { record: (event: SecurityAuditEvent) => void } = { record: () => undefined }) {
  return {
    toolName, toolInput: input, requestId, toolUseId, sessionId: 'read-e2e-session',
    workDir: root, userDataDir: path.join(root, '.userdata'), toolsConfig: { ...DEFAULT_TOOLS_CONFIG, deniedTools: [] },
    effectiveRules: policy?.effectiveRules ?? DEFAULT_POLICY_RULES,
    lanePackage: policy?.lanePackage ?? 'standard',
    decisionCache: { lookup: () => null, record: () => undefined, clear: () => 0, clearAllSession: () => 0, expireDormant: () => 0 },
    shellPrecheck: { touchTrustedCommand: () => undefined }, audit,
    readConfirmationRegistry: registry
  }
}

function executorContext(root: string, requestId: string, toolUseId: string, permit?: import('./readExecutionPermit').ReadExecutionPermit, grepFixture?: string, audit?: { record: (event: SecurityAuditEvent) => void }): ToolExecutionContext {
  return {
    workDir: root, userDataDir: path.join(root, '.userdata'), requestId, toolUseId,
    sessionId: 'read-e2e-session', lane: 'desktop', sendProgress: vi.fn(), signal: new AbortController().signal,
    fileStateCache: new FileStateCache(), toolsConfig: { ...DEFAULT_TOOLS_CONFIG, fileCheckpointingEnabled: false },
    ...(audit ? { audit } : {}),
    ...(permit ? { readExecutionPermit: permit } : {}),
    ...(grepFixture ? { grepSpawnProcess: (_binary: string, args: string[], options: Parameters<typeof spawn>[2]) => spawn(process.execPath, [grepFixture, ...args], options) } : {})
  }
}

async function approveSensitiveGrep(root: string, file: string, requestId: string, toolUseId: string) {
  const registry = new ReadConfirmationRegistry()
  const input = { pattern: 'CONFIRMED_GREP_VALUE', path: file, output_mode: 'content' }
  const gate = await evaluateToolCallGate(gateDeps(root, input, requestId, toolUseId, registry, 'grep'))
  expect(gate.decision).toMatchObject({ type: 'require-confirm', answerer: 'user', ruleId: 'path-sensitive-read-confirm' })
  const permit = finalizeReadConfirmation({
    toolName: 'grep', toolInput: input, requestId, toolUseId, outcome: 'approved', answerer: 'user',
    readPathFact: gate.readPathFact, approvedTargets: gate.readTargetMapping
  }, registry)
  expect(permit).toBeDefined()
  return { input, permit: permit! }
}

async function approveRead(root: string, file: string, requestId: string, toolUseId: string) {
  const registry = new ReadConfirmationRegistry()
  const input = { path: file }
  const gate = await evaluateToolCallGate(gateDeps(root, input, requestId, toolUseId, registry))
  expect(gate.decision).toMatchObject({ type: 'require-confirm', answerer: 'user' })
  const permit = finalizeReadConfirmation({
    toolName: 'read_file', toolInput: input, requestId, toolUseId, outcome: 'approved', answerer: 'user',
    readPathFact: gate.readPathFact, approvedTargets: gate.readTargetMapping
  }, registry)
  expect(permit).toBeDefined()
  return { input, permit: permit! }
}

describe('V1 confirmed read executor integration', () => {
  it('Hosted read gate + production grep executor uses walk fallback when ripgrep is unavailable', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hosted-grep-fallback-')))
    try {
      await fs.writeFile(path.join(root, 'note.txt'), 'fallback marker\n')
      const input = { path: 'note.txt', pattern: 'fallback marker', output_mode: 'content' }
      const registry = new ReadConfirmationRegistry()
      const gate = await evaluateToolCallGate(gateDeps(root, input, 'fallback-e2e-req', 'fallback-e2e-tool', registry, 'grep'))
      expect(gate.decision).toMatchObject({ type: 'auto-allow', ruleId: 'read-target-workdir-allow' })
      rgAvailability.unavailable = true
      const result = await grepExecutor.execute(input, executorContext(root, 'fallback-e2e-req', 'fallback-e2e-tool', gate.readExecutionPermit))
      expect(result).toMatchObject({ success: true, data: { searchScope: { engine: 'walk' } } })
      expect(result.data?.output).toContain('note.txt:1:fallback marker')
    } finally {
      rgAvailability.unavailable = false
      await fs.rm(root, { recursive: true, force: true })
    }
  })
  it('许可身份变化形成可关联且不泄露路径的 policy.execution-veto', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'read-veto-audit-e2e-')))
    try {
      const file = path.join(root, '.env')
      await fs.writeFile(file, 'BEFORE=1')
      const requestId = 'read-veto-audit-request'
      const toolUseId = 'read-veto-audit-tool'
      const registry = new ReadConfirmationRegistry()
      const events: SecurityAuditEvent[] = []
      const audit = { record: (event: SecurityAuditEvent) => events.push(event) }
      const input = { path: file }
      const gate = await evaluateToolCallGate(gateDeps(root, input, requestId, toolUseId, registry, 'read_file', undefined, audit))
      const permit = finalizeReadConfirmation({
        toolName: 'read_file', toolInput: input, requestId, toolUseId, outcome: 'approved', answerer: 'user',
        readPathFact: gate.readPathFact, approvedTargets: gate.readTargetMapping
      }, registry)
      expect(permit).toBeDefined()
      await fs.rename(file, `${file}.old`)
      await fs.writeFile(file, 'AFTER=2')

      const result = await readFileExecutor.execute(input, executorContext(root, requestId, toolUseId, permit!, undefined, audit))
      expect(result).toMatchObject({ success: false, diagnostic: { category: 'mechanism', caseId: 'read-target-identity-changed' } })

      const decision = events.find((event) => event.event === 'policy.decision')
      const veto = events.find((event) => event.event === 'policy.execution-veto')
      expect(decision).toMatchObject({ requestId, toolUseId, decision: 'require-confirm', ruleId: permit!.decisionRuleId })
      expect(veto).toMatchObject({ requestId, toolUseId, decisionRuleId: permit!.decisionRuleId, factId: decision?.factId, failureClass: 'mechanism', pathZone: 'sensitive-file' })
      expect(JSON.stringify([decision, veto])).not.toContain(file)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('gate permit 绑定后才由生产 list_directory executor 枚举直接子项', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'list-dir-e2e-')))
    try {
      const directory = path.join(root, 'target')
      await fs.mkdir(directory)
      await fs.writeFile(path.join(directory, 'visible.txt'), 'content')
      const input = { path: 'target' }
      const requestId = 'list-dir-e2e-req'
      const toolUseId = 'list-dir-e2e-tool'
      const registry = new ReadConfirmationRegistry()
      const gate = await evaluateToolCallGate(gateDeps(root, input, requestId, toolUseId, registry, 'list_directory'))
      expect(gate.decision).toMatchObject({ type: 'auto-allow', ruleId: 'read-target-workdir-allow' })
      expect(validateReadExecutionBoundary({ toolName: 'list_directory', input, requestId, toolUseId, permit: gate.readExecutionPermit, expectedFacts: gate.readExecutionPermit?.targets })).toEqual({ ok: true })
      const result = await listDirectoryExecutor.execute(input, executorContext(root, requestId, toolUseId, gate.readExecutionPermit))
      // 执行器 path.relative 产出平台原生分隔符（win32 反斜杠），断言用 path.join 保持跨平台。
      expect(result).toMatchObject({ success: true, data: { entries: [expect.objectContaining({ name: 'visible.txt', path: path.join('target', 'visible.txt') })] } })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('拒绝父目录移出 workspace 后通过同 inode symlink 继续访问已许可文件', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'read-parent-move-e2e-')))
    const workspace = path.join(root, 'workspace')
    const outside = path.join(root, 'outside')
    try {
      await fs.mkdir(workspace)
      const directory = path.join(workspace, 'docs')
      const moved = path.join(outside, 'docs')
      await fs.mkdir(directory)
      await fs.mkdir(outside)
      const file = path.join(directory, 'approved.txt')
      await fs.writeFile(file, 'approved file content')
      const input = { path: 'docs/approved.txt' }
      const requestId = 'read-parent-move-req'
      const toolUseId = 'read-parent-move-tool'
      const registry = new ReadConfirmationRegistry()
      const gate = await evaluateToolCallGate(gateDeps(workspace, input, requestId, toolUseId, registry))
      expect(gate.decision).toMatchObject({ type: 'auto-allow', ruleId: 'read-target-workdir-allow' })

      await fs.rename(directory, moved)
      await fs.symlink(moved, directory, 'dir')
      const result = await readFileExecutor.execute(input, executorContext(workspace, requestId, toolUseId, gate.readExecutionPermit))

      expect(result).toMatchObject({ success: false, diagnostic: { category: 'mechanism' } })
      expect(JSON.stringify(result)).not.toContain('approved file content')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('拒绝父目录移出 workspace 后通过同 inode symlink 搜索已许可文件', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'grep-parent-move-e2e-')))
    const workspace = path.join(root, 'workspace')
    const outside = path.join(root, 'outside')
    try {
      await fs.mkdir(workspace)
      const directory = path.join(workspace, 'docs')
      const moved = path.join(outside, 'docs')
      await fs.mkdir(directory)
      await fs.mkdir(outside)
      await fs.writeFile(path.join(directory, 'approved.txt'), 'APPROVED_SEARCH_SECRET')
      const input = { path: 'docs/approved.txt', pattern: 'APPROVED_SEARCH_SECRET', output_mode: 'content' }
      const requestId = 'grep-parent-move-req'
      const toolUseId = 'grep-parent-move-tool'
      const registry = new ReadConfirmationRegistry()
      const gate = await evaluateToolCallGate(gateDeps(workspace, input, requestId, toolUseId, registry, 'grep'))
      expect(gate.decision).toMatchObject({ type: 'auto-allow', ruleId: 'read-target-workdir-allow' })

      await fs.rename(directory, moved)
      await fs.symlink(moved, directory, 'dir')
      const result = await grepExecutor.execute(input, executorContext(workspace, requestId, toolUseId, gate.readExecutionPermit))

      expect(result).toMatchObject({ success: false, diagnostic: { category: 'mechanism' } })
      expect(JSON.stringify(result)).not.toContain('APPROVED_SEARCH_SECRET')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('拒绝获准目录移出 workspace 后通过同 inode symlink 枚举', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'list-parent-move-e2e-')))
    const workspace = path.join(root, 'workspace')
    const outside = path.join(root, 'outside')
    try {
      await fs.mkdir(workspace)
      const directory = path.join(workspace, 'docs')
      const moved = path.join(outside, 'docs')
      await fs.mkdir(directory)
      await fs.mkdir(outside)
      await fs.writeFile(path.join(directory, 'approved.txt'), 'approved')
      const input = { path: 'docs' }
      const requestId = 'list-parent-move-req'
      const toolUseId = 'list-parent-move-tool'
      const registry = new ReadConfirmationRegistry()
      const gate = await evaluateToolCallGate(gateDeps(workspace, input, requestId, toolUseId, registry, 'list_directory'))
      expect(gate.decision).toMatchObject({ type: 'auto-allow', ruleId: 'read-target-workdir-allow' })

      await fs.rename(directory, moved)
      await fs.symlink(moved, directory, 'dir')
      const result = await listDirectoryExecutor.execute(input, executorContext(workspace, requestId, toolUseId, gate.readExecutionPermit))

      expect(result).toMatchObject({ success: false, diagnostic: { category: 'mechanism' } })
      expect(JSON.stringify(result)).not.toContain('approved.txt')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('目录在 permit 校验与 opendir 之间被替换时，不枚举替换目录', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'list-dir-race-e2e-')))
    try {
      const directory = path.join(root, 'target')
      const moved = path.join(root, 'target-approved')
      await fs.mkdir(directory)
      await fs.writeFile(path.join(directory, 'approved.txt'), 'approved')
      const input = { path: 'target' }
      const requestId = 'list-dir-race-req'
      const toolUseId = 'list-dir-race-tool'
      const registry = new ReadConfirmationRegistry()
      const gate = await evaluateToolCallGate(gateDeps(root, input, requestId, toolUseId, registry, 'list_directory'))
      await fs.rename(directory, moved)
      await fs.mkdir(directory)
      await fs.writeFile(path.join(directory, 'unapproved.txt'), 'secret')
      const result = await listDirectoryExecutor.execute(input, executorContext(root, requestId, toolUseId, gate.readExecutionPermit))
      expect(result).toMatchObject({ success: false, diagnostic: { category: 'mechanism', caseId: 'read-directory-identity-changed' } })
      expect(JSON.stringify(result)).not.toContain('secret')
    } finally {
      vi.restoreAllMocks()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('strict/custom ask 获批后才由生产 list_directory executor 枚举', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'list-dir-confirmed-e2e-')))
    try {
      const directory = path.join(root, 'target')
      await fs.mkdir(directory)
      await fs.writeFile(path.join(directory, 'visible-after-confirm.txt'), 'content')
      const input = { path: 'target' }
      const requestId = 'list-dir-confirmed-req'
      const toolUseId = 'list-dir-confirmed-tool'
      const registry = new ReadConfirmationRegistry()
      const effectiveRules = DEFAULT_POLICY_RULES.map((rule) => rule.id === 'read-target-workdir-allow' ? { ...rule, action: 'ask' as const } : rule)
      const gate = await evaluateToolCallGate(gateDeps(root, input, requestId, toolUseId, registry, 'list_directory', { effectiveRules, lanePackage: 'custom' }))
      expect(gate.decision).toMatchObject({ type: 'require-confirm', answerer: 'user', ruleId: 'read-target-workdir-allow' })
      expect(gate.readExecutionPermit).toBeUndefined()
      const beforeApproval = await listDirectoryExecutor.execute(input, executorContext(root, requestId, toolUseId))
      expect(beforeApproval).toMatchObject({ success: false, diagnostic: { caseId: 'read-permit-missing' } })
      const permit = finalizeReadConfirmation({
        toolName: 'list_directory', toolInput: input, requestId, toolUseId, outcome: 'approved', answerer: 'user',
        readPathFact: gate.readPathFact, approvedTargets: gate.readTargetMapping
      }, registry)
      expect(permit?.targets[0]).toMatchObject({ scope: 'direct-entries', targetKind: 'directory' })
      const afterApproval = await listDirectoryExecutor.execute(input, executorContext(root, requestId, toolUseId, permit))
      expect(afterApproval).toMatchObject({ success: true, data: { entries: [expect.objectContaining({ name: 'visible-after-confirm.txt' })] } })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('真人批准后由生产 grep executor 只在获准敏感文件中搜索', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'grep-e2e-sensitive-')))
    try {
      const file = path.join(root, '.env')
      await fs.writeFile(file, 'CONFIRMED_GREP_VALUE=present\n')
      const { input, permit } = await approveSensitiveGrep(root, file, 'sensitive-grep-req', 'sensitive-grep-tool')
      expect(permit.targets[0]).toMatchObject({ normalizedPath: file, zone: 'sensitive-file', decisionRuleId: 'path-sensitive-read-confirm' })
      const fixture = path.join(root, 'rg-fixture.cjs')
      await fs.writeFile(fixture, "const fs=require('fs'); const a=process.argv.slice(2); const p=a[a.length-1]; const text=fs.readFileSync(p==='-'?0:p,'utf8'); const lines=text.split(/\\r?\\n/); const i=lines.findIndex(x=>x.includes('CONFIRMED_GREP_VALUE')); if(i>=0) process.stdout.write((p==='-'?'<stdin>':p)+':'+(i+1)+':'+lines[i]+'\\n')")
      const result = await grepExecutor.execute(input, executorContext(root, 'sensitive-grep-req', 'sensitive-grep-tool', permit, fixture))
      expect(result).toMatchObject({ success: true, data: { output: expect.stringContaining('CONFIRMED_GREP_VALUE=present') } })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('真人批准后由生产 read_file executor 读取敏感文件', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'read-e2e-sensitive-')))
    try {
      const file = path.join(root, '.env')
      await fs.writeFile(file, 'SAFE_TEST_VALUE=confirmed')
      const { input, permit } = await approveRead(root, file, 'sensitive-read-req', 'sensitive-read-tool')
      expect(permit.targets[0]?.zone).toBe('sensitive-file')
      const result = await readFileExecutor.execute(input, executorContext(root, 'sensitive-read-req', 'sensitive-read-tool', permit))
      expect(result).toMatchObject({ success: true, data: { content: 'SAFE_TEST_VALUE=confirmed' } })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('Agent 不能批准敏感读取以换取生产 executor permit', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'read-e2e-agent-')))
    try {
      const file = path.join(root, '.env')
      await fs.writeFile(file, 'SAFE_TEST_VALUE=must-not-read')
      const registry = new ReadConfirmationRegistry()
      const input = { path: file }
      const requestId = 'agent-read-req'
      const toolUseId = 'agent-read-tool'
      const gate = await evaluateToolCallGate(gateDeps(root, input, requestId, toolUseId, registry))
      const permit = finalizeReadConfirmation({ toolName: 'read_file', toolInput: input, requestId, toolUseId, outcome: 'approved', answerer: 'agent', readPathFact: gate.readPathFact, approvedTargets: gate.readTargetMapping }, registry)
      expect(permit).toBeUndefined()
      const result = await readFileExecutor.execute(input, executorContext(root, requestId, toolUseId))
      expect(result).toMatchObject({ success: false, diagnostic: { caseId: 'read-permit-missing' } })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("symlink→directory 的 grep：确认注册→兑现 subtree permit→executor 放行（P0-1 闭环·junction 形态）", async () => {
    if (process.platform !== 'win32') return
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'read-e2e-grep-linkdir-')))
    try {
      const realDir = path.join(root, 'secrets', 'sub')
      await fs.mkdir(realDir, { recursive: true })
      await fs.writeFile(path.join(realDir, 'inner.txt'), 'LINKED_DIR_NEEDLE\n')
      const linkDir = path.join(root, 'slink')
      await fs.symlink(realDir, linkDir, 'junction')
      const registry = new ReadConfirmationRegistry()
      const input = { pattern: 'LINKED_DIR_NEEDLE', path: linkDir, output_mode: 'content' }
      const requestId = 'grep-linkdir-req'
      const toolUseId = 'grep-linkdir-tool'
      const gate = await evaluateToolCallGate(gateDeps(root, input, requestId, toolUseId, registry, 'grep'))
      expect(gate.decision).toMatchObject({ type: 'require-confirm', answerer: 'user', ruleId: 'path-sensitive-read-confirm' })
      expect(gate.readPathFact?.targetKind).toBe('symlink')
      expect(gate.readPathFact?.resolvedKind).toBe('directory')
      const permit = finalizeReadConfirmation({ toolName: 'grep', toolInput: input, requestId, toolUseId, outcome: 'approved', answerer: 'user', readPathFact: gate.readPathFact, approvedTargets: gate.readTargetMapping }, registry)
      expect(permit).toBeDefined()
      expect(permit!.targets[0]).toMatchObject({ targetKind: 'directory', scope: 'subtree' })
      const result = await grepExecutor.execute(input, executorContext(root, requestId, toolUseId, permit))
      expect(result.success).toBe(true)
      expect(result.data?.output).toContain('inner.txt')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it("read_file 确认流显式拒绝目录事实（P2-3 纵深：finalize 层守卫）", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'read-e2e-rf-dir-')))
    try {
      const registry = new ReadConfirmationRegistry()
      const input = { path: root }
      const gate = await evaluateToolCallGate(gateDeps(root, input, 'rf-dir-req', 'rf-dir-tool', registry))
      expect(gate.readPathFact?.targetKind).toBe('directory')
      const permit = finalizeReadConfirmation({ toolName: 'read_file', toolInput: input, requestId: 'rf-dir-req', toolUseId: 'rf-dir-tool', outcome: 'approved', answerer: 'user', readPathFact: gate.readPathFact, approvedTargets: gate.readTargetMapping }, registry)
      expect(permit).toBeUndefined()
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
  it('系统目录路径在真人批准后可由生产 read_file executor 读取', async () => {
    const systemFile = process.platform === 'darwin' ? '/System/Library/CoreServices/SystemVersion.plist' : '/etc/hosts'
    try { await fs.access(systemFile) } catch { return }
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'read-e2e-system-')))
    try {
      const { input, permit } = await approveRead(root, systemFile, 'system-read-req', 'system-read-tool')
      expect(permit.targets[0]?.zone).toBe('system-dir')
      const result = await readFileExecutor.execute(input, executorContext(root, 'system-read-req', 'system-read-tool', permit))
      expect(result.success).toBe(true)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('敏感目录 grep：确认注册→兑现 subtree permit→executor 放行并明示 sensitivePathHit（P0-1 闭环）', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'read-e2e-grep-dir-')))
    try {
      // secrets/ 内的目录：isSensitivePath 经 sep+secrets+sep 命中 → path-sensitive-read-confirm（confirm-every-time，locked）
      const targetDir = path.join(root, 'secrets', 'sub')
      await fs.mkdir(targetDir, { recursive: true })
      await fs.writeFile(path.join(targetDir, 'inner.txt'), 'CONFIRMED_DIR_NEEDLE\n')
      const registry = new ReadConfirmationRegistry()
      const input = { pattern: 'CONFIRMED_DIR_NEEDLE', path: targetDir, output_mode: 'content' }
      const requestId = 'grep-dir-confirm-req'
      const toolUseId = 'grep-dir-confirm-tool'
      const gate = await evaluateToolCallGate(gateDeps(root, input, requestId, toolUseId, registry, 'grep'))
      expect(gate.decision).toMatchObject({ type: 'require-confirm', answerer: 'user', ruleId: 'path-sensitive-read-confirm' })
      expect(gate.readPathFact?.targetKind).toBe('directory')
      const permit = finalizeReadConfirmation({ toolName: 'grep', toolInput: input, requestId, toolUseId, outcome: 'approved', answerer: 'user', readPathFact: gate.readPathFact, approvedTargets: gate.readTargetMapping }, registry)
      expect(permit).toBeDefined()
      expect(permit!.targets[0]).toMatchObject({ targetKind: 'directory', scope: 'subtree' })
      const result = await grepExecutor.execute(input, executorContext(root, requestId, toolUseId, permit))
      expect(result.success).toBe(true)
      expect(result.data?.output).toContain('inner.txt')
      expect(result.data).toMatchObject({ sensitivePathHit: true })
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
