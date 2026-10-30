import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentChannel } from './agentChannel'
import { renderCluePackForTest } from './approvalAgent'
import { evaluateToolCallGate, type ToolCallGateArgs } from './toolCallGate'
import { createAgentSdkStructuralPermitHandoff } from './agentSdkSafetyPolicy'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { resolveImPolicyRulesForVersion } from '../../src/shared/policy/policyPackages'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { editFileExecutor, writeFileExecutor } from '../tools/builtinExecutors'
import { FileStateCache } from '../fileStateCache'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))) })

describe('IM outside-write approval integration', () => {
  it.each(['wechat', 'feishu'] as const)('%s: approved outside-workdir write reaches the real executor', async (lane) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'im-outside-write-')))
    roots.push(root)
    const workDir = path.join(root, 'work')
    await fs.mkdir(workDir)
    const snapshot = { domain: 'im' as const, policyBehaviorVersion: 'im-standard-v3', revision: 1, snapshot: { selectedPackage: 'standard' } }
    const input = { path: path.join(root, 'report.txt'), content: 'reviewed report body' }
    const args = {
      workDir, userDataDir: path.join(root, '.userdata'), sessionId: 's', requestId: `r-${lane}`, toolUseId: `t-${lane}`,
      lane, lanePackage: 'standard', toolName: 'write_file', toolInput: input,
      toolsConfig: DEFAULT_TOOLS_CONFIG, audit: { record() {} }, imPolicySnapshot: snapshot,
      effectiveRules: resolveImPolicyRulesForVersion({ policyBehaviorVersion: snapshot.policyBehaviorVersion, pkg: 'standard', rules: DEFAULT_POLICY_RULES }),
      decisionCache: { lookup: () => null, record() {}, clear: () => 0, clearAllSession: () => 0, expireDormant: () => 0 },
      shellPrecheck: { touchTrustedCommand() {} }
    } as ToolCallGateArgs
    const gate = await evaluateToolCallGate(args)
    expect(gate.decision).toMatchObject({ type: 'require-confirm', answerer: 'agent', ruleId: 'im-outside-write-new-review' })
    const runtime = { ...args, sendProgress() {}, signal: new AbortController().signal, fileStateCache: new FileStateCache() } as Record<string, any>
    const handoff = createAgentSdkStructuralPermitHandoff({ updateExecutionContext: (_call, update) => update(runtime) })
    let prompt = ''
    const approval = new AgentChannel({ lane, requestId: `r-${lane}`, sessionId: 's', toolName: 'write_file', policy: { kind: 'agent' },
      invokeApproval: async (invocation) => {
        prompt = renderCluePackForTest(invocation.clue)
        return { ok: true, verdict: { kind: 'approve', reason: { summary: 'approved after review' } } }
      } })
    const outcome = await approval.request({ facts: gate.facts, riskLevel: gate.decision.type === 'require-confirm' ? gate.decision.riskLevel : 'medium', memoryTiers: [], timeoutMs: 5000 })
    expect(outcome.kind).toBe('approved')
    expect(prompt).toContain(input.content)
    expect(prompt).toContain(input.path)
    handoff.onConfirmed!({ invocationId: `r-${lane}`, requestId: `r-${lane}`, toolCallId: `t-${lane}` } as never, gate, args, 'agent')
    const result = await writeFileExecutor.execute(input, runtime as never)
    expect(result).toMatchObject({ success: true })
    await expect(fs.readFile(input.path, 'utf8')).resolves.toBe(input.content)
  })

  it.each(['wechat', 'feishu'] as const)('%s: approved outside-workdir edit reaches the real executor', async (lane) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'im-outside-edit-')))
    roots.push(root)
    const workDir = path.join(root, 'work')
    await fs.mkdir(workDir)
    const target = path.join(root, 'report.txt')
    const original = 'before reviewed replacement after'
    await fs.writeFile(target, original)
    const snapshot = { domain: 'im' as const, policyBehaviorVersion: 'im-standard-v3', revision: 1, snapshot: { selectedPackage: 'standard' } }
    const input = { path: target, old_string: 'reviewed', new_string: 'approved' }
    const args = {
      workDir, userDataDir: path.join(root, '.userdata'), sessionId: 's', requestId: `edit-r-${lane}`, toolUseId: `edit-t-${lane}`,
      lane, lanePackage: 'standard', toolName: 'edit_file', toolInput: input,
      toolsConfig: DEFAULT_TOOLS_CONFIG, audit: { record() {} }, imPolicySnapshot: snapshot,
      effectiveRules: resolveImPolicyRulesForVersion({ policyBehaviorVersion: snapshot.policyBehaviorVersion, pkg: 'standard', rules: DEFAULT_POLICY_RULES }),
      decisionCache: { lookup: () => null, record() {}, clear: () => 0, clearAllSession: () => 0, expireDormant: () => 0 },
      shellPrecheck: { touchTrustedCommand() {} }
    } as ToolCallGateArgs
    const gate = await evaluateToolCallGate(args)
    expect(gate.decision).toMatchObject({ type: 'require-confirm', answerer: 'agent', ruleId: 'im-outside-write-edit-review' })
    const cache = new FileStateCache()
    const stat = await fs.stat(target)
    cache.set(target, { path: target, content: original, mtime: stat.mtimeMs, readAt: Date.now(), isPartial: false, size: stat.size })
    const runtime = { ...args, sendProgress() {}, signal: new AbortController().signal, fileStateCache: cache } as Record<string, any>
    const handoff = createAgentSdkStructuralPermitHandoff({ updateExecutionContext: (_call, update) => update(runtime) })
    let prompt = ''
    const approval = new AgentChannel({ lane, requestId: `edit-r-${lane}`, sessionId: 's', toolName: 'edit_file', policy: { kind: 'agent' },
      invokeApproval: async (invocation) => {
        prompt = renderCluePackForTest(invocation.clue)
        return { ok: true, verdict: { kind: 'approve', reason: { summary: 'approved after review' } } }
      } })
    expect(await approval.request({ facts: gate.facts, riskLevel: gate.decision.type === 'require-confirm' ? gate.decision.riskLevel : 'medium', memoryTiers: [], timeoutMs: 5000 })).toMatchObject({ kind: 'approved' })
    expect(prompt).toContain('reviewed')
    expect(prompt).toContain('approved')
    handoff.onConfirmed!({ invocationId: `edit-r-${lane}`, requestId: `edit-r-${lane}`, toolCallId: `edit-t-${lane}` } as never, gate, args, 'agent')
    const result = await editFileExecutor.execute(input, runtime as never)
    expect(result).toMatchObject({ success: true })
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('before approved replacement after')
  })

  it.each(['wechat', 'feishu'] as const)('%s edit review binds replace_all and shows the exact affected lines', async (lane) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'im-outside-edit-scope-')))
    roots.push(root)
    const workDir = path.join(root, 'work')
    await fs.mkdir(workDir)
    const target = path.join(root, 'settings.txt')
    const original = 'FEATURE=false\nADMIN=false\n'
    await fs.writeFile(target, original)
    const snapshot = { domain: 'im' as const, policyBehaviorVersion: 'im-standard-v3', revision: 1, snapshot: { selectedPackage: 'standard' } }
    const cache = new FileStateCache()
    const stat = await fs.stat(target)
    cache.set(target, { path: target, content: original, mtime: stat.mtimeMs, readAt: Date.now(), isPartial: false, size: stat.size })
    const prompts: string[] = []
    for (const replaceAll of [false, true]) {
      const requestId = `scope-r-${lane}-${replaceAll}`
      const input = { path: target, old_string: 'false', new_string: 'true', replace_all: replaceAll }
      const args = {
        workDir, userDataDir: path.join(root, '.userdata'), sessionId: 's', requestId, toolUseId: `scope-t-${lane}-${replaceAll}`,
        lane, lanePackage: 'standard', toolName: 'edit_file', toolInput: input,
        toolsConfig: DEFAULT_TOOLS_CONFIG, audit: { record() {} }, imPolicySnapshot: snapshot,
        effectiveRules: resolveImPolicyRulesForVersion({ policyBehaviorVersion: snapshot.policyBehaviorVersion, pkg: 'standard', rules: DEFAULT_POLICY_RULES }),
        decisionCache: { lookup: () => null, record() {}, clear: () => 0, clearAllSession: () => 0, expireDormant: () => 0 },
        shellPrecheck: { touchTrustedCommand() {} }
      } as ToolCallGateArgs
      const gate = await evaluateToolCallGate(args)
      expect(gate.decision).toMatchObject({ type: 'require-confirm', answerer: 'agent', ruleId: 'im-outside-write-edit-review' })
      expect(gate.facts.reviewMaterials).toMatchObject({ kind: 'outside-file-write', operation: 'edit', replaceAll: replaceAll,
        targetContent: original, matchRanges: [{ startLine: 1, endLine: 1 }, { startLine: 2, endLine: 2 }],
        executionOutcome: replaceAll ? 'applies-all' : 'rejects-ambiguous-matches',
        proposedContent: replaceAll ? 'FEATURE=true\nADMIN=true\n' : original, complete: true })
      const approval = new AgentChannel({ lane, requestId, sessionId: 's', toolName: 'edit_file', policy: { kind: 'agent' },
        invokeApproval: async (invocation) => {
          const prompt = renderCluePackForTest(invocation.clue)
          prompts.push(prompt)
          expect(prompt).toContain(`"replaceAll":${replaceAll}`)
          expect(prompt).toContain(replaceAll ? 'ADMIN=true' : 'ADMIN=false')
          return { ok: true, verdict: { kind: 'approve', reason: { summary: 'approved after reviewing the projected scope' } } }
        } })
      expect(await approval.request({ facts: gate.facts, riskLevel: 'medium', memoryTiers: [], timeoutMs: 5000 })).toMatchObject({ kind: 'approved' })
      const runtime = { ...args, sendProgress() {}, signal: new AbortController().signal, fileStateCache: cache } as Record<string, any>
      const handoff = createAgentSdkStructuralPermitHandoff({ updateExecutionContext: (_call, update) => update(runtime) })
      handoff.onConfirmed!({ invocationId: requestId, requestId, toolCallId: `scope-t-${lane}-${replaceAll}` } as never, gate, args, 'agent')
      const execution = await editFileExecutor.execute(input, runtime as never)
      if (replaceAll) {
        expect(execution).toMatchObject({ success: true })
        await expect(fs.readFile(target, 'utf8')).resolves.toBe('FEATURE=true\nADMIN=true\n')
      } else {
        expect(execution).toMatchObject({ success: false })
        expect(execution.error).toContain('找到多个匹配')
        await expect(fs.readFile(target, 'utf8')).resolves.toBe(original)
      }
    }
    expect(prompts[0]).not.toBe(prompts[1])
  })

  it('denies edit review when the exact bounded preview would exceed the review material limit', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'im-outside-edit-expansion-')))
    roots.push(root)
    const workDir = path.join(root, 'work')
    await fs.mkdir(workDir)
    const target = path.join(root, 'settings.txt')
    await fs.writeFile(target, 'x'.repeat(4_000))
    const snapshot = { domain: 'im' as const, policyBehaviorVersion: 'im-standard-v3', revision: 1, snapshot: { selectedPackage: 'standard' } }
    const args = {
      workDir, userDataDir: path.join(root, '.userdata'), sessionId: 's', requestId: 'expansion-r', toolUseId: 'expansion-t',
      lane: 'wechat', lanePackage: 'standard', toolName: 'edit_file',
      toolInput: { path: target, old_string: 'x', new_string: 'y'.repeat(100), replace_all: true },
      toolsConfig: DEFAULT_TOOLS_CONFIG, audit: { record() {} }, imPolicySnapshot: snapshot,
      effectiveRules: resolveImPolicyRulesForVersion({ policyBehaviorVersion: snapshot.policyBehaviorVersion, pkg: 'standard', rules: DEFAULT_POLICY_RULES }),
      decisionCache: { lookup: () => null, record() {}, clear: () => 0, clearAllSession: () => 0, expireDormant: () => 0 },
      shellPrecheck: { touchTrustedCommand() {} }
    } as ToolCallGateArgs
    const gate = await evaluateToolCallGate(args)
    expect(gate.facts.reviewMaterials).toMatchObject({ kind: 'outside-file-write', complete: false, matchRangesTruncated: true })
    expect(gate.decision).toMatchObject({ type: 'deny', ruleId: 'im-outside-write-review-materials-incomplete-deny' })
  })
})
