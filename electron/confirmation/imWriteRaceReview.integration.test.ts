import { it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAgentSdkSafetyPolicy, createAgentSdkStructuralPermitHandoff, markAgentSdkSafetyDecisionConfirmed } from './agentSdkSafetyPolicy'
import { evaluateToolCallGate, type ToolCallGateResult } from './toolCallGate'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { resolveImPolicyRulesForVersion } from '../../src/shared/policy/policyPackages'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { editFileExecutor, writeFileExecutor } from '../tools/builtinExecutors'
import { FileStateCache } from '../fileStateCache'
import type { ToolCallGateArgs } from './toolCallGate'

it.each(['wechat', 'feishu'] as const)('%s refuses to overwrite a concurrently replaced approved edit target', async (lane) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'im-edit-race-')))
  const workDir = path.join(root, 'work')
  const target = path.join(root, 'settings.txt')
  const replacement = path.join(root, 'concurrent-save.txt')
  const approvedOriginal = 'FEATURE=false\nADMIN=false\n'
  const concurrentlySaved = 'FEATURE=false\nADMIN=true\nNEW=must survive\n'
  await fs.mkdir(workDir)
  await fs.writeFile(target, approvedOriginal)
  await fs.writeFile(replacement, concurrentlySaved)
  const input = { path: target, old_string: 'FEATURE=false', new_string: 'FEATURE=true' }
  const snapshot = { domain: 'im' as const, policyBehaviorVersion: 'im-standard-v3', revision: 1, snapshot: { selectedPackage: 'standard' } }
  const args = {
    workDir, userDataDir: path.join(root, '.userdata'), sessionId: 's', requestId: 'race-r', toolUseId: 'race-t', lane, lanePackage: 'standard', toolName: 'edit_file', toolInput: input,
    toolsConfig: DEFAULT_TOOLS_CONFIG, audit: { record() {} }, imPolicySnapshot: snapshot,
    effectiveRules: resolveImPolicyRulesForVersion({ policyBehaviorVersion: snapshot.policyBehaviorVersion, pkg: 'standard', rules: DEFAULT_POLICY_RULES }),
    decisionCache: { lookup: () => null, record() {}, clear: () => 0, clearAllSession: () => 0, expireDormant: () => 0 }, shellPrecheck: { touchTrustedCommand() {} }
  } as ToolCallGateArgs
  const cache = new FileStateCache()
  const approvedStat = await fs.stat(target)
  cache.set(target, { path: target, content: approvedOriginal, mtime: approvedStat.mtimeMs, size: approvedStat.size, readAt: Date.now(), isPartial: false })
  const runtime: Record<string, any> = { ...args, sendProgress() {}, signal: new AbortController().signal, fileStateCache: cache }
  const handoff = createAgentSdkStructuralPermitHandoff({ updateExecutionContext: (_call, update) => update(runtime) })
  const policy = createAgentSdkSafetyPolicy({ resolveGateArgs: async () => args, ...handoff })
  const binding = { requestId: 'race-r', turnId: 'turn', invocationId: 'race-inv', toolCallId: 'race-t', capabilityId: 'edit_file',
    inputSnapshotHash: createHash('sha256').update(JSON.stringify(input, Object.keys(input).sort())).digest('hex'), planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'a', phase: 'initial-compat' as const,
    capability: { state: 'known-authorized' as const, id: 'edit_file' } }
  const originalReadFile = fs.readFile.bind(fs)
  const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (...readArgs: any[]) => {
    const content = await (originalReadFile as any)(...readArgs)
    if (readArgs[0] === target) await fs.rename(replacement, target)
    return content
  }) as never)
  try {
    expect(await policy.evaluate(binding)).toMatchObject({ kind: 'ask', answerer: 'agent' })
    markAgentSdkSafetyDecisionConfirmed(policy, binding, 'agent')
    expect(await policy.evaluate({ ...binding, phase: 'recheck' })).toMatchObject({ kind: 'allow' })
    const result = await editFileExecutor.execute(input, runtime as never)
    expect(result).toMatchObject({ success: false })
    expect(await originalReadFile(target, 'utf8')).toBe(concurrentlySaved)
  } finally {
    spy.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  }
})

it.each(['wechat', 'feishu'] as const)('%s write_file refuses to replace an inode changed after its approved read', async (lane) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'im-write-race-')))
  const workDir = path.join(root, 'work')
  const target = path.join(workDir, 'settings.txt')
  const replacement = path.join(root, 'concurrent-save.txt')
  const original = 'approved old content'
  const concurrentlySaved = 'concurrent saved content that must survive'
  await fs.mkdir(workDir)
  await fs.writeFile(target, original)
  await fs.writeFile(replacement, concurrentlySaved)
  const input = { path: target, content: 'approved replacement' }
  const snapshot = { domain: 'im' as const, policyBehaviorVersion: 'im-standard-v3', revision: 1, snapshot: { selectedPackage: 'standard' } }
  const args = {
    workDir, userDataDir: path.join(root, '.userdata'), sessionId: 's', requestId: 'write-race-r', toolUseId: 'write-race-t', lane, lanePackage: 'standard', toolName: 'write_file', toolInput: input,
    toolsConfig: DEFAULT_TOOLS_CONFIG, audit: { record() {} }, imPolicySnapshot: snapshot,
    effectiveRules: resolveImPolicyRulesForVersion({ policyBehaviorVersion: snapshot.policyBehaviorVersion, pkg: 'standard', rules: DEFAULT_POLICY_RULES }),
    decisionCache: { lookup: () => null, record() {}, clear: () => 0, clearAllSession: () => 0, expireDormant: () => 0 }, shellPrecheck: { touchTrustedCommand() {} }
  } as ToolCallGateArgs
  const gate = await evaluateToolCallGate(args)
  expect(gate.decision.type).toBe('require-confirm')
  const cache = new FileStateCache()
  const approvedStat = await fs.stat(target)
  cache.set(target, { path: target, content: original, mtime: approvedStat.mtimeMs, size: approvedStat.size, readAt: Date.now(), isPartial: false })
  const runtime = { ...args, sendProgress() {}, signal: new AbortController().signal, fileStateCache: cache } as Record<string, any>
  const handoff = createAgentSdkStructuralPermitHandoff({ updateExecutionContext: (_call, update) => update(runtime) })
  handoff.onConfirmed!({ invocationId: 'write-race-r', requestId: 'write-race-r', toolCallId: 'write-race-t' } as never,
    gate as ToolCallGateResult, args, 'agent')
  const originalReadFile = fs.readFile.bind(fs)
  let replaced = false
  const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (...readArgs: any[]) => {
    const content = await (originalReadFile as any)(...readArgs)
    if (!replaced && readArgs[0] === target) { await fs.rename(replacement, target); replaced = true }
    return content
  }) as never)
  try {
    const execution = await writeFileExecutor.execute(input, runtime as never)
    expect(execution).toMatchObject({ success: false })
    expect(replaced).toBe(true)
    expect(await originalReadFile(target, 'utf8')).toBe(concurrentlySaved)
  } finally {
    spy.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  }
})
