import { it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createAgentSdkSafetyPolicy, createAgentSdkStructuralPermitHandoff, markAgentSdkSafetyDecisionConfirmed } from './agentSdkSafetyPolicy'
import { ReadConfirmationRegistry } from './readConfirmationRegistry'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { resolveImPolicyRulesForVersion } from '../../src/shared/policy/policyPackages'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { readFileExecutor } from '../tools/builtinExecutors'
import { FileStateCache } from '../fileStateCache'
import type { ToolCallGateArgs } from './toolCallGate'

it.each(['wechat', 'feishu'] as const)('%s issues a fresh read permit after the user approves the changed target', async (lane) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'im-read-reapproval-')))
  const workDir = path.join(root, 'work')
  const target = path.join(root, 'report.txt')
  await fs.mkdir(workDir)
  await fs.writeFile(target, 'original')
  const input = { path: target }
  const registry = new ReadConfirmationRegistry()
  const snapshot = { domain: 'im' as const, policyBehaviorVersion: 'im-standard-v3', revision: 1, snapshot: { selectedPackage: 'standard' } }
  const args = {
    workDir, userDataDir: path.join(root, '.userdata'), sessionId: 's', requestId: 'read-r', toolUseId: 'read-t', lane, lanePackage: 'standard', toolName: 'read_file', toolInput: input,
    toolsConfig: DEFAULT_TOOLS_CONFIG, audit: { record() {} }, imPolicySnapshot: snapshot, readConfirmationRegistry: registry,
    effectiveRules: resolveImPolicyRulesForVersion({ policyBehaviorVersion: snapshot.policyBehaviorVersion, pkg: 'standard', rules: DEFAULT_POLICY_RULES }),
    decisionCache: { lookup: () => null, record() {}, clear: () => 0, clearAllSession: () => 0, expireDormant: () => 0 }, shellPrecheck: { touchTrustedCommand() {} }
  } as ToolCallGateArgs
  const runtime: Record<string, any> = { ...args, sendProgress() {}, signal: new AbortController().signal, fileStateCache: new FileStateCache() }
  const handoff = createAgentSdkStructuralPermitHandoff({ readConfirmationRegistry: registry, updateExecutionContext: (_call, update) => update(runtime) })
  const policy = createAgentSdkSafetyPolicy({ resolveGateArgs: async () => args, ...handoff })
  const binding = { requestId: 'read-r', turnId: 'turn', invocationId: 'read-inv', toolCallId: 'read-t', capabilityId: 'read_file',
    inputSnapshotHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'), planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'a', phase: 'initial-compat' as const,
    capability: { state: 'known-authorized' as const, id: 'read_file' } }
  try {
    expect(await policy.evaluate(binding)).toMatchObject({ kind: 'ask', answerer: 'agent' })
    markAgentSdkSafetyDecisionConfirmed(policy, binding, 'agent')
    const oldPermit = runtime.readExecutionPermit
    expect(oldPermit).toBeDefined()
    await fs.writeFile(target, 'changed target approved by the human')
    const reapproval = await policy.evaluate({ ...binding, phase: 'recheck' })
    expect(reapproval).toMatchObject({ kind: 'ask', answerer: 'user' })
    expect(registry.stats().activeEntries).toBe(1)
    markAgentSdkSafetyDecisionConfirmed(policy, binding, 'user')
    expect(runtime.readExecutionPermit).not.toBe(oldPermit)
    expect(runtime.readExecutionPermit.targets[0].identity).not.toEqual(oldPermit.targets[0].identity)
    expect(await policy.evaluate({ ...binding, phase: 'recheck' })).toMatchObject({ kind: 'allow' })
    expect(await readFileExecutor.execute(input, runtime as never)).toMatchObject({ success: true })
    expect(runtime.readExecutionPermit.targets[0].identity.size).toBe(Buffer.byteLength('changed target approved by the human'))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
