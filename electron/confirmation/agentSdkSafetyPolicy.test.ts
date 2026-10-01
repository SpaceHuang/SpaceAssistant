import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { PermitBinding } from '../../packages/agent-sdk/src/safetyPermit'
import type { ContentFacts, Decision } from '../../src/shared/confirmation/types'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { evaluateToolCallGate, type ToolCallGateArgs, type ToolCallGateResult } from './toolCallGate'
import { ReadConfirmationRegistry } from './readConfirmationRegistry'
import { finalizeReadConfirmation } from './readConfirmationFlow'
import { readInputDigest } from './readExecutionPermit'
import { createAgentSdkRecheckPort, createAgentSdkSafetyPolicy, createAgentSdkStructuralPermitHandoff, createSafetyPolicyFromRecheck, markAgentSdkSafetyDecisionConfirmed } from './agentSdkSafetyPolicy'

const binding: PermitBinding & { capability: { state: 'known-authorized'; id: string } } = {
  requestId: 'req', turnId: 'turn', invocationId: 'inv', toolCallId: 'call', capabilityId: 'read_file',
  inputSnapshotHash: createHash('sha256').update(JSON.stringify({ path: 'x' })).digest('hex'), planDigest: 'plan', factsDigest: 'facts', authorizationVersion: 'pending', phase: 'initial-compat',
  capability: { state: 'known-authorized', id: 'read_file' }
}
const facts: ContentFacts = { toolName: 'read_file', actionClass: 'read', baseRiskLevel: 'low', signals: [], summary: { text: 'read' } }
const baseArgs = { toolName: 'read_file', toolInput: { path: 'x' }, sessionId: 'req', workDir: '/tmp', userDataDir: '/tmp', toolsConfig: {}, effectiveRules: [], decisionCache: {}, shellPrecheck: { touchTrustedCommand() {} } } as unknown as ToolCallGateArgs
const result = (decision: Decision): ToolCallGateResult => ({ decision, facts, approvedFactIds: [] })

describe('createAgentSdkSafetyPolicy', () => {
  it('把用户明确选择的记忆键传到确认提交回调，未选择则不写入', async () => {
    const key = { kind: 'script-content' as const, digest: 'a'.repeat(64), sessionId: 'session-1' }
    const scriptFacts: ContentFacts = {
      toolName: 'run_script', actionClass: 'execute', baseRiskLevel: 'high',
      signals: [
        { kind: 'script-analysis', signal: 'clean', patterns: [] },
        { kind: 'script-path-extraction', completeness: 'unknown', dynamicAccess: false, unknownReason: 'unmodeled-call', contentDigest: key.digest }
      ], summary: { text: 'script' }
    }
    const selected = vi.fn()
    const scriptArgs = { ...baseArgs, toolName: 'run_script', toolInput: { code: 'custom_api()' }, sessionId: key.sessionId } as ToolCallGateArgs
    const policy = createAgentSdkSafetyPolicy({
      resolveGateArgs: async () => scriptArgs,
      evaluateGate: async () => ({
        decision: { type: 'require-confirm', ruleId: 'script-unmodeled-path-ask', answerer: 'user', riskLevel: 'high', facts: scriptFacts, memoryTiers: [{ key, label: '记住本会话此脚本' }], timeoutMs: null },
        facts: scriptFacts, approvedFactIds: []
      }),
      onConfirmed: (_binding, _result, _args, _answerer, memory) => { if (memory) selected(memory) }
    })
    const scriptBinding = { ...binding, capabilityId: 'run_script', inputSnapshotHash: createHash('sha256').update('{"code":"custom_api()"}').digest('hex'), capability: { state: 'known-authorized' as const, id: 'run_script' } }
    await expect(policy.evaluate(scriptBinding)).resolves.toMatchObject({ kind: 'ask' })
    markAgentSdkSafetyDecisionConfirmed(policy, scriptBinding, 'user', key)
    expect(selected).toHaveBeenCalledWith(key)
  })

  it('denies a confirmed edit_file when the fresh gate reports a replaced target identity', async () => {
    const originalTarget = { rawPath: 'approved.txt', normalizedPath: '/workspace/approved.txt', zone: 'workdir-normal' as const, targetKind: 'file' as const, parentReal: '/workspace', parentIdentity: { dev: 1, ino: 2, mode: 0o40755, size: 0, mtimeMs: 1, nlink: 2 }, identity: { dev: 1, ino: 3, mode: 0o100644, size: 16, mtimeMs: 1, nlink: 1 } }
    const replacedTarget = { ...originalTarget, identity: { ...originalTarget.identity, ino: 4 } }
    const writeFacts: ContentFacts = { toolName: 'edit_file', actionClass: 'write', baseRiskLevel: 'medium', signals: [], summary: { text: 'edit approved file' } }
    const initial: ToolCallGateResult = { decision: { type: 'require-confirm', ruleId: 'edit-confirm', answerer: 'user', riskLevel: 'medium', facts: writeFacts, memoryTiers: [], timeoutMs: 1000 }, facts: writeFacts, approvedFactIds: [], writePathFact: originalTarget }
    const replaced: ToolCallGateResult = { ...initial, writePathFact: replacedTarget }
    const input = { path: 'approved.txt', old_string: 'original content', new_string: 'changed content' }
    const args = { ...baseArgs, toolName: 'edit_file', toolInput: input, workDir: '/workspace' } as ToolCallGateArgs
    const testBinding = { ...binding, capabilityId: 'edit_file', inputSnapshotHash: createHash('sha256').update('{"new_string":"changed content","old_string":"original content","path":"approved.txt"}').digest('hex'), capability: { state: 'known-authorized' as const, id: 'edit_file' } }
    const evaluateGate = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(replaced)
    const policy = createAgentSdkSafetyPolicy({ resolveGateArgs: async () => args, evaluateGate })

    await expect(policy.evaluate({ ...testBinding, authorizationVersion: 'edit-v1' })).resolves.toMatchObject({ kind: 'ask', reasonCode: 'edit-confirm' })
    markAgentSdkSafetyDecisionConfirmed(policy, testBinding)
    await expect(policy.evaluate({ ...testBinding, authorizationVersion: 'edit-v1', phase: 'recheck' })).resolves.toMatchObject({ kind: 'deny', reasonCode: 'FACTS_CHANGED' })
    expect(evaluateGate).toHaveBeenCalledTimes(2)
  })

  it('rejects an approved ask when recheck becomes auto-allow under changed facts', async () => {
    const changedFacts: ContentFacts = { ...facts, signals: [{ kind: 'path-target', path: '/tmp/changed.txt', zone: 'workdir-normal' }] }
    const initial = result({ type: 'require-confirm', ruleId: 'confirmed-read-rule', answerer: 'user', riskLevel: 'medium', facts, memoryTiers: [], timeoutMs: 1000 })
    const driftedAutoAllow: ToolCallGateResult = {
      decision: { type: 'auto-allow', ruleId: 'new-cache-allow', reason: 'now cached' },
      facts: changedFacts,
      approvedFactIds: []
    }
    const evaluateGate = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(driftedAutoAllow)
    const policy = createAgentSdkSafetyPolicy({ resolveGateArgs: async () => baseArgs, evaluateGate })
    const confirmedBinding = { ...binding, authorizationVersion: 'policy-v1' }

    await expect(policy.evaluate(confirmedBinding)).resolves.toMatchObject({ kind: 'ask', reasonCode: 'confirmed-read-rule' })
    markAgentSdkSafetyDecisionConfirmed(policy, confirmedBinding)
    await expect(policy.evaluate({ ...confirmedBinding, phase: 'recheck' })).resolves.toMatchObject({ kind: 'deny', reasonCode: 'FACTS_CHANGED' })
  })

  it('accepts an approved ask that rechecks as auto-allow only when rule and facts remain identical', async () => {
    const initial = result({ type: 'require-confirm', ruleId: 'confirmed-read-rule', answerer: 'user', riskLevel: 'medium', facts, memoryTiers: [], timeoutMs: 1000 })
    const sameRuleAutoAllow: ToolCallGateResult = {
      decision: { type: 'auto-allow', ruleId: 'confirmed-read-rule', reason: 'same confirmed rule now resolves allow' },
      facts,
      approvedFactIds: []
    }
    const evaluateGate = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(sameRuleAutoAllow)
    const policy = createAgentSdkSafetyPolicy({ resolveGateArgs: async () => baseArgs, evaluateGate })
    const confirmedBinding = { ...binding, authorizationVersion: 'policy-v1' }

    await expect(policy.evaluate(confirmedBinding)).resolves.toMatchObject({ kind: 'ask', reasonCode: 'confirmed-read-rule' })
    markAgentSdkSafetyDecisionConfirmed(policy, confirmedBinding)
    await expect(policy.evaluate({ ...confirmedBinding, phase: 'recheck' })).resolves.toEqual({ kind: 'allow', authorizationVersion: 'policy-v1' })
  })

  it('discards the approved initial snapshot when fresh recheck material is unavailable', async () => {
    let recheckAttempts = 0
    const resolveGateArgs = vi.fn(async (current: PermitBinding) => {
      if (current.phase === 'recheck' && recheckAttempts++ === 0) throw new Error('temporary host facts failure')
      return baseArgs
    })
    const evaluateGate = vi.fn()
      .mockResolvedValueOnce(result({ type: 'require-confirm', ruleId: 'approved-rule', answerer: 'user', riskLevel: 'medium', facts, memoryTiers: [], timeoutMs: 1000 }))
      .mockResolvedValueOnce(result({ type: 'auto-allow', ruleId: 'approved-rule', reason: 'same as previously approved' }))
    const policy = createAgentSdkSafetyPolicy({ resolveGateArgs, evaluateGate })
    const confirmedBinding = { ...binding, authorizationVersion: 'policy-v1' }

    await expect(policy.evaluate(confirmedBinding)).resolves.toMatchObject({ kind: 'ask', reasonCode: 'approved-rule' })
    markAgentSdkSafetyDecisionConfirmed(policy, confirmedBinding)
    await expect(policy.evaluate({ ...confirmedBinding, phase: 'recheck' })).resolves.toMatchObject({ kind: 'deny', reasonCode: 'MISSING_MATERIAL' })
    await expect(policy.evaluate({ ...confirmedBinding, phase: 'recheck' })).resolves.toMatchObject({ kind: 'deny', reasonCode: 'MISSING_MATERIAL' })
    expect(evaluateGate).toHaveBeenCalledOnce()
  })

  it('allows only one concurrent recheck to consume an approved initial snapshot', async () => {
    let releaseRecheck!: () => void
    let markRecheckEntered!: () => void
    const recheckBarrier = new Promise<void>((resolve) => { releaseRecheck = resolve })
    const recheckEntered = new Promise<void>((resolve) => { markRecheckEntered = resolve })
    const evaluateGate = vi.fn(async (args: ToolCallGateArgs) => {
      if (args.phase === 'initial') return result({ type: 'require-confirm', ruleId: 'approved-rule', answerer: 'user', riskLevel: 'medium', facts, memoryTiers: [], timeoutMs: 1000 })
      markRecheckEntered()
      await recheckBarrier
      return result({ type: 'auto-allow', ruleId: 'approved-rule', reason: 'same approved rule' })
    })
    const policy = createAgentSdkSafetyPolicy({ resolveGateArgs: async () => baseArgs, evaluateGate })
    const confirmedBinding = { ...binding, authorizationVersion: 'policy-v1' }

    await expect(policy.evaluate(confirmedBinding)).resolves.toMatchObject({ kind: 'ask', reasonCode: 'approved-rule' })
    markAgentSdkSafetyDecisionConfirmed(policy, confirmedBinding)
    const firstRecheck = policy.evaluate({ ...confirmedBinding, phase: 'recheck' })
    await recheckEntered
    const secondRecheck = policy.evaluate({ ...confirmedBinding, phase: 'recheck' })
    releaseRecheck()

    await expect(firstRecheck).resolves.toEqual({ kind: 'allow', authorizationVersion: 'policy-v1' })
    await expect(secondRecheck).resolves.toMatchObject({ kind: 'deny', reasonCode: 'MISSING_MATERIAL' })
    expect(evaluateGate).toHaveBeenCalledTimes(2)
  })

  it('rejects a confirmed Feishu attachment when the cached file identity changes', async () => {
    const attachmentFacts: ContentFacts = {
      toolName: 'read_feishu_attachment', actionClass: 'read', baseRiskLevel: 'low',
      signals: [{ kind: 'feishu-media-target', boundary: 'inside' }], summary: { text: '飞书附件目标边界已检查' }
    }
    const initial = {
      ...result({ type: 'require-confirm', ruleId: 'approved-attachment-rule', answerer: 'user', riskLevel: 'medium', facts: attachmentFacts, memoryTiers: [], timeoutMs: 1000 }),
      feishuMediaFact: {
        boundary: 'inside' as const, attachmentId: 'attachment-1', normalizedPath: '/user-data/feishu-media/cache/m1/brief.txt', targetKind: 'file' as const,
        identity: { dev: 1, ino: 10, mode: 33188, size: 8, mtimeMs: 100 }
      }
    }
    const replaced = {
      ...initial,
      feishuMediaFact: {
        ...initial.feishuMediaFact,
        identity: { dev: 1, ino: 11, mode: 33188, size: 8, mtimeMs: 100 }
      }
    }
    const evaluateGate = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(replaced)
    const policy = createAgentSdkSafetyPolicy({ resolveGateArgs: async () => baseArgs, evaluateGate })
    const confirmedBinding = { ...binding, authorizationVersion: 'policy-v1' }

    await expect(policy.evaluate(confirmedBinding)).resolves.toMatchObject({ kind: 'ask', reasonCode: 'approved-attachment-rule' })
    markAgentSdkSafetyDecisionConfirmed(policy, confirmedBinding)
    await expect(policy.evaluate({ ...confirmedBinding, phase: 'recheck' })).resolves.toMatchObject({ kind: 'deny', reasonCode: 'FACTS_CHANGED' })
  })

  it('rechecks a user-confirmed Feishu attachment against the real gate identity snapshot', async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sdk-feishu-confirmed-attachment-'))
    const mediaDir = path.join(userDataDir, 'feishu-media', 'cache', 'message-1')
    const attachmentPath = path.join(mediaDir, 'brief.txt')
    await fs.mkdir(mediaDir, { recursive: true })
    await fs.writeFile(attachmentPath, 'approved')
    const readConfirmationRegistry = new ReadConfirmationRegistry()
    const executionContext: Record<string, unknown> = {}
    const toolInput = { attachmentId: 'attachment-1' }
    const confirmedAttachmentRules = [...DEFAULT_POLICY_RULES, {
      id: 'test-confirm-feishu-attachment', when: 'invocation' as const,
      match: { lane: ['feishu' as const], toolName: 'read_feishu_attachment', signals: ['feishu-media-target:inside'] },
      action: 'ask' as const, reason: 'test attachment confirmation'
    }]
    const gateArgs = {
      toolName: 'read_feishu_attachment', toolInput, sessionId: 'feishu-session', requestId: 'feishu-request', toolUseId: 'feishu-tool',
      workDir: path.join(userDataDir, 'work'), userDataDir, lane: 'feishu' as const,
      remoteContext: { source: 'feishu' as const, messageId: 'message-1', confirmPolicy: 'im_confirm' as const, feishuAttachments: [{ id: 'attachment-1', messageId: 'message-1', localPath: attachmentPath, fileName: 'brief.txt', mimeType: 'text/plain' }] },
      toolsConfig: DEFAULT_TOOLS_CONFIG, effectiveRules: confirmedAttachmentRules, lanePackage: 'standard', decisionCache: { lookup: () => null },
      shellPrecheck: { touchTrustedCommand() {} }, audit: { record() {} }, readConfirmationRegistry
    } as unknown as ToolCallGateArgs
    const policy = createAgentSdkSafetyPolicy({
      resolveGateArgs: async (current) => ({ ...gateArgs, phase: current.phase === 'recheck' ? 'recheck' : 'initial' }),
      evaluateGate: (args) => evaluateToolCallGate(args),
      onConfirmed: (_binding, _result, args) => {
        const permit = finalizeReadConfirmation({
          toolName: args.toolName, toolInput: args.toolInput, requestId: 'feishu-request', toolUseId: 'feishu-tool',
          outcome: 'approved', answerer: 'user', feishuMediaFact: _result.feishuMediaFact, approvedTargets: _result.readTargetMapping
        }, readConfirmationRegistry)
        if (permit) executionContext.readExecutionPermit = permit
      }
    })
    const confirmedBinding = {
      ...binding, requestId: 'feishu-request', turnId: 'feishu-turn', invocationId: 'feishu-invocation', toolCallId: 'feishu-tool',
      capabilityId: 'read_feishu_attachment', inputSnapshotHash: createHash('sha256').update(JSON.stringify(toolInput)).digest('hex'),
      authorizationVersion: 'policy-v1', capability: { state: 'known-authorized' as const, id: 'read_feishu_attachment' }
    }

    try {
      const initialDecision = await policy.evaluate(confirmedBinding)
      expect(initialDecision).toMatchObject({ kind: 'ask', answerer: 'user' })
      markAgentSdkSafetyDecisionConfirmed(policy, confirmedBinding)
      expect(executionContext.readExecutionPermit).toMatchObject({ toolName: 'read_feishu_attachment', targets: [{ identity: { ino: expect.any(Number) } }] })
      await fs.rename(attachmentPath, `${attachmentPath}.approved`)
      await fs.writeFile(attachmentPath, 'replacement')
      await expect(policy.evaluate({ ...confirmedBinding, phase: 'recheck' })).resolves.toMatchObject({ kind: 'deny', reasonCode: 'FACTS_CHANGED' })
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true })
    }
  })

  it('rejects a confirmed call if the authorization version changes before recheck', async () => {
    const evaluateGate = vi.fn(async () => result({ type: 'require-confirm', ruleId: 'same-rule', answerer: 'user', riskLevel: 'medium', facts, memoryTiers: [], timeoutMs: 1000 }))
    const policy = createAgentSdkSafetyPolicy({ resolveGateArgs: async () => baseArgs, evaluateGate })
    const initialBinding = { ...binding, authorizationVersion: 'policy-before-confirm' }
    const initial = await policy.evaluate(initialBinding)
    expect(initial.kind).toBe('ask')
    markAgentSdkSafetyDecisionConfirmed(policy, { invocationId: binding.invocationId, toolCallId: binding.toolCallId })

    await expect(policy.evaluate({ ...initialBinding, authorizationVersion: 'policy-after-confirm', phase: 'recheck' }))
      .resolves.toEqual({ kind: 'deny', reasonCode: 'POLICY_DENY' })
    expect(evaluateGate).toHaveBeenCalledTimes(2)
  })

  it('resolves fresh gate material separately for initial and recheck bindings', async () => {
    const resolveGateArgs = vi.fn(async (_current: PermitBinding) => baseArgs)
    const evaluateGate = vi.fn(async (args: ToolCallGateArgs) => result({ type: 'auto-allow', ruleId: `rule-${String((args.toolInput as { path: string }).path)}`, reason: 'ok' }))
    const policy = createAgentSdkSafetyPolicy({ resolveGateArgs, evaluateGate })

    const initial = await policy.evaluate(binding)
    const recheck = await policy.evaluate({ ...binding, phase: 'recheck' })

    expect(resolveGateArgs.mock.calls.map(([current]) => current.phase)).toEqual(['initial-compat', 'recheck'])
    expect(evaluateGate.mock.calls.map(([args]) => args.phase)).toEqual(['initial', 'recheck'])
    expect(evaluateGate.mock.calls[1]?.[0]).toMatchObject({ evaluateFastTrackOnRecheck: true })
    expect(initial.kind).toBe('allow')
    expect(recheck.kind).toBe('allow')
    if (initial.kind === 'allow' && recheck.kind === 'allow') expect(initial.authorizationVersion).toBe(recheck.authorizationVersion)
  })
  it('passes cancellation into host fact resolution and stops before gate evaluation', async () => {
    const controller = new AbortController()
    let release!: () => void
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => { markEntered = resolve })
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const resolveGateArgs = vi.fn(async (_binding: PermitBinding, _call: unknown, signal?: AbortSignal) => {
      markEntered()
      await barrier
      expect(signal).toBe(controller.signal)
      return baseArgs
    })
    const evaluateGate = vi.fn(async () => result({ type: 'auto-allow', ruleId: 'safe', reason: 'ok' }))
    const policy = createAgentSdkSafetyPolicy({ resolveGateArgs, evaluateGate })
    const evaluation = policy.evaluate({ ...binding, signal: controller.signal })

    await entered
    controller.abort()
    release()

    await expect(evaluation).resolves.toEqual({ kind: 'deny', reasonCode: 'POLICY_DENY' })
    expect(evaluateGate).not.toHaveBeenCalled()
  })

  it('evaluates a fresh host recheck once and shares the same authorization projection with the SDK', async () => {
    const evaluate = vi.fn(async () => result({ type: 'require-confirm', ruleId: 'human', answerer: 'user', riskLevel: 'medium', facts, memoryTiers: [], timeoutMs: 1000 }))
    const recheckPort = createAgentSdkRecheckPort({
      initialRuleId: 'human', initialFacts: facts, previouslyConfirmed: true,
      resolveAuthorizationVersion: () => 'policy-v7', isRevoked: () => false, evaluate
    })
    await expect(recheckPort.recheck()).resolves.toMatchObject({
      allowed: true, authorizationVersion: 'policy-v7', targetVersion: 'human:require-confirm'
    })
    await expect(recheckPort.safetyPolicy.evaluate(binding)).resolves.toEqual({ kind: 'allow', authorizationVersion: 'policy-v7' })
    await expect(recheckPort.safetyPolicy.evaluate(binding)).resolves.toMatchObject({ kind: 'deny', reasonCode: 'POLICY_DENY' })
    expect(evaluate).toHaveBeenCalledOnce()
    const changedFacts = { ...facts, summary: { text: 'changed facts' } }
    const changed = createAgentSdkRecheckPort({
      initialRuleId: 'human', initialFacts: facts, previouslyConfirmed: true,
      resolveAuthorizationVersion: () => 'policy-v7', isRevoked: () => false,
      evaluate: async () => ({ ...result({ type: 'require-confirm', ruleId: 'human', answerer: 'user', riskLevel: 'medium', facts, memoryTiers: [], timeoutMs: 1000 }), facts: changedFacts })
    })
    await expect(changed.recheck()).resolves.toMatchObject({ allowed: false })
    const changedRule = createAgentSdkRecheckPort({
      initialRuleId: 'human', initialFacts: facts, previouslyConfirmed: true,
      resolveAuthorizationVersion: () => 'policy-v8', isRevoked: () => false,
      evaluate: async () => result({ type: 'require-confirm', ruleId: 'new-confirmation', answerer: 'user', riskLevel: 'high', facts, memoryTiers: [], timeoutMs: 1000 })
    })
    await expect(changedRule.recheck()).resolves.toMatchObject({ allowed: false, authorizationVersion: 'policy-v8' })
    const revoked = createAgentSdkRecheckPort({
      initialRuleId: 'human', initialFacts: facts, previouslyConfirmed: true,
      resolveAuthorizationVersion: () => 'policy-v7', isRevoked: () => true,
      evaluate: async () => result({ type: 'auto-allow', ruleId: 'auto', reason: 'would allow absent revocation' })
    })
    await expect(revoked.recheck()).resolves.toMatchObject({ allowed: false })
  })
  it('projects the single host recheck into the SDK authorization decision and fails closed when absent', async () => {
    const resolve = vi.fn(async () => ({ allowed: true, authorizationVersion: 'latest-rule' }))
    const policy = createSafetyPolicyFromRecheck(resolve)
    await expect(policy.evaluate(binding)).resolves.toEqual({ kind: 'allow', authorizationVersion: 'latest-rule' })
    expect(resolve).toHaveBeenCalledOnce()
    await expect(createSafetyPolicyFromRecheck(async () => undefined).evaluate(binding)).resolves.toEqual({ kind: 'deny', reasonCode: 'POLICY_DENY' })
    await expect(createSafetyPolicyFromRecheck(async () => { throw new Error('missing') }).evaluate(binding)).resolves.toEqual({ kind: 'deny', reasonCode: 'MISSING_MATERIAL' })
  })
  it('recheck 对比本次 initial facts，且 permit 版本绑定 prepared authorizationVersion', async () => {
    const gate = vi.fn(async () => result({ type: 'auto-allow', ruleId: 'same-rule', reason: 'ok' }))
    const policy = createAgentSdkSafetyPolicy({ resolveGateArgs: async () => baseArgs, evaluateGate: gate })
    const prepared = { ...binding, authorizationVersion: 'prepared-policy-v7' }
    await expect(policy.evaluate(prepared)).resolves.toEqual({ kind: 'allow', authorizationVersion: 'prepared-policy-v7' })
    await expect(policy.evaluate({ ...prepared, phase: 'recheck' })).resolves.toEqual({ kind: 'allow', authorizationVersion: 'prepared-policy-v7' })
    expect(gate).toHaveBeenCalledTimes(2)
    const factsNow = { ...facts, summary: { text: 'changed' } }
    const drift = createAgentSdkSafetyPolicy({ resolveGateArgs: async () => baseArgs, evaluateGate: vi.fn()
      .mockResolvedValueOnce(result({ type: 'require-confirm', ruleId: 'same-rule', answerer: 'user', riskLevel: 'medium', facts, memoryTiers: [], timeoutMs: 1000 }))
      .mockResolvedValueOnce({ ...result({ type: 'require-confirm', ruleId: 'same-rule', answerer: 'user', riskLevel: 'medium', facts, memoryTiers: [], timeoutMs: 1000 }), facts: factsNow }) })
    await drift.evaluate(prepared)
    markAgentSdkSafetyDecisionConfirmed(drift, prepared)
    await expect(drift.evaluate({ ...prepared, phase: 'recheck' })).resolves.toMatchObject({ kind: 'deny', reasonCode: 'FACTS_CHANGED' })
  })
  it('只允许已批准的 Hosted recheck 保留相同 require-confirm 供 SafetyPolicy 比较', async () => {
    const gate = vi.fn(async () => result({ type: 'require-confirm', ruleId: 'same-human-rule', answerer: 'user', riskLevel: 'medium', facts, memoryTiers: [], timeoutMs: 1000 }))
    const policy = createAgentSdkSafetyPolicy({ resolveGateArgs: async () => baseArgs, evaluateGate: gate })

    await expect(policy.evaluate(binding)).resolves.toMatchObject({ kind: 'ask', reasonCode: 'same-human-rule' })
    await expect(policy.evaluate({ ...binding, phase: 'recheck' })).resolves.toMatchObject({ kind: 'deny', reasonCode: 'POLICY_DENY' })
    expect(gate.mock.calls[1]?.[0].previouslyConfirmed).toBeUndefined()

    const approvedPolicy = createAgentSdkSafetyPolicy({ resolveGateArgs: async () => baseArgs, evaluateGate: gate })
    await approvedPolicy.evaluate(binding)
    markAgentSdkSafetyDecisionConfirmed(approvedPolicy, binding)
    await expect(approvedPolicy.evaluate({ ...binding, phase: 'recheck' })).resolves.toEqual({ kind: 'allow', authorizationVersion: binding.authorizationVersion })
    expect(gate.mock.calls[3]?.[0]).toMatchObject({ phase: 'recheck', previouslyConfirmed: true })
  })
  it('把真实 gate 的 auto-allow 映射为绑定规则和事实的授权版本', async () => {
    const gate = vi.fn(async () => result({ type: 'auto-allow', ruleId: 'read-safe', reason: 'ok' }))
    const policy = createAgentSdkSafetyPolicy({ resolveGateArgs: async () => baseArgs, evaluateGate: gate })
    const decision = await policy.evaluate(binding)
    expect(decision.kind).toBe('allow')
    expect(decision.authorizationVersion).toBe(binding.authorizationVersion)
    expect(gate).toHaveBeenCalledOnce()
    expect(gate.mock.calls[0]?.[0]).toMatchObject({ toolName: 'read_file', toolInput: { path: 'x' }, phase: 'initial' })
  })
  it('uses the registered internal tool identity when the provider request carries a sanitized alias', async () => {
    const gate = vi.fn(async () => result({ type: 'auto-allow', ruleId: 'read-safe', reason: 'ok' }))
    const policy = createAgentSdkSafetyPolicy({
      resolveGateArgs: async () => baseArgs,
      evaluateGate: gate,
      resolveToolName: (name) => name === 'lookup_internal' ? 'lookup.internal' : name
    })
    await policy.evaluate({ ...binding, capabilityId: 'lookup_internal', capability: { state: 'known-authorized', id: 'lookup_internal' } })
    expect(gate.mock.calls[0]?.[0]).toMatchObject({ toolName: 'lookup.internal' })
  })
  it('accepts a prepared provider alias when it resolves to the bound internal capability', async () => {
    const gate = vi.fn(async () => result({ type: 'auto-allow', ruleId: 'lookup-safe', reason: 'ok' }))
    const call = { invocationId: binding.invocationId, toolCallId: binding.toolCallId, toolName: 'lookup_internal', input: { path: 'x' } }
    const policy = createAgentSdkSafetyPolicy({
      resolveToolCall: () => call,
      resolveGateArgs: async (_binding, prepared) => {
        expect(prepared).toEqual(call)
        return baseArgs
      },
      evaluateGate: gate,
      resolveToolName: (name) => name === 'lookup_internal' ? 'lookup.internal' : name
    })

    await expect(policy.evaluate({ ...binding, capabilityId: 'lookup.internal', capability: { state: 'known-authorized', id: 'lookup.internal' } }))
      .resolves.toMatchObject({ kind: 'allow' })
    expect(gate).toHaveBeenCalledOnce()
    expect(gate.mock.calls[0]?.[0]).toMatchObject({ toolName: 'lookup.internal' })
    await expect(policy.evaluate({ ...binding, capabilityId: 'lookup_internal', capability: { state: 'known-authorized', id: 'lookup_internal' } }))
      .resolves.toMatchObject({ kind: 'allow' })
    expect(gate).toHaveBeenCalledTimes(2)
  })
  it('fails closed before gate evaluation when resolver input differs from the prepared canonical input hash', async () => {
    const evaluateGate = vi.fn(async () => result({ type: 'auto-allow', ruleId: 'unsafe', reason: 'must not run' }))
    const policy = createAgentSdkSafetyPolicy({
      resolveGateArgs: async () => ({ ...baseArgs, toolInput: { path: '/other/target' } } as unknown as ToolCallGateArgs), evaluateGate
    })
    await expect(policy.evaluate(binding)).resolves.toMatchObject({ kind: 'deny', reasonCode: 'STALE_AUTHORIZATION' })
    expect(evaluateGate).not.toHaveBeenCalled()
  })

  it('保留 require-confirm 的回答者，且不签发 allow', async () => {
    const approvalContext = { facts, readPathFact: { normalizedPath: '/tmp/x' }, readTargetMapping: [{ factId: 'fact-x', decisionRuleId: 'human' }] }
    const policy = createAgentSdkSafetyPolicy({
      resolveGateArgs: async () => baseArgs,
      evaluateGate: async () => ({ ...result({ type: 'require-confirm', ruleId: 'human', answerer: 'user', riskLevel: 'medium', facts, memoryTiers: [], timeoutMs: 1000 }), ...approvalContext })
    })
    await expect(policy.evaluate(binding)).resolves.toMatchObject({
      kind: 'ask', answerer: 'user', confirmationId: 'call', reasonCode: 'human', context: approvalContext
    })
  })

  it('retains invocation-scoped browser and remote gate context for the confirmation UI publisher', async () => {
    const currentPageUrl = 'https://example.test/account'
    const dangerAssessment = { dangerous: true, source: 'page-effect' as const, userReason: 'submit', consequence: 'account-change' as const }
    const policy = createAgentSdkSafetyPolicy({
      resolveGateArgs: async () => ({ ...baseArgs, currentPageUrl, dangerAssessment, remoteBudgetState: { remaining: 2 } } as never),
      evaluateGate: async () => result({ type: 'require-confirm', ruleId: 'browser-review', answerer: 'user', riskLevel: 'high', facts, memoryTiers: [], timeoutMs: 1000 })
    })

    await expect(policy.evaluate(binding)).resolves.toMatchObject({
      kind: 'ask', context: { toolName: 'read_file', currentPageUrl, dangerAssessment, remoteBudgetState: { remaining: 2 } }
    })
  })

  it('initial gate result and approved confirmation callbacks can hand structural permits to the prepared call context', async () => {
    const structuralPermit = { requestId: binding.requestId, toolUseId: binding.toolCallId, toolName: 'read_file', inputDigest: 'digest' }
    const gateResult = {
      ...result({ type: 'require-confirm', ruleId: 'human', answerer: 'user', riskLevel: 'medium', facts, memoryTiers: [], timeoutMs: 1000 }),
      readExecutionPermit: structuralPermit
    }
    const onInitialGateResult = vi.fn()
    const onConfirmed = vi.fn()
    const policy = createAgentSdkSafetyPolicy({
      resolveGateArgs: async () => baseArgs,
      evaluateGate: async () => gateResult,
      onInitialGateResult,
      onConfirmed
    })

    await expect(policy.evaluate(binding)).resolves.toMatchObject({ kind: 'ask' })
    expect(onInitialGateResult.mock.calls[0]?.slice(0, 2)).toEqual([binding, gateResult])
    markAgentSdkSafetyDecisionConfirmed(policy, binding)
    expect(onConfirmed.mock.calls[0]?.slice(0, 2)).toEqual([binding, gateResult])
  })

  it('hands an auto-allow write permit from the host gate to the exact prepared call context', () => {
    const contexts = new Map<string, Record<string, unknown>>()
    const handoff = createAgentSdkStructuralPermitHandoff({
      updateExecutionContext: (call, update) => {
        const key = JSON.stringify([call.invocationId, call.toolCallId])
        const context = contexts.get(key) ?? {}
        update(context)
        contexts.set(key, context)
      }
    })
    const args = { ...baseArgs, toolName: 'write_file', toolInput: { path: '/tmp/a.txt', content: 'new' }, requestId: binding.requestId, toolUseId: binding.toolCallId } as ToolCallGateArgs
    const gateResult = {
      ...result({ type: 'auto-allow', ruleId: 'write-rule', reason: 'workspace write' }),
      writePathFact: { rawPath: args.toolInput.path as string, normalizedPath: '/tmp/a.txt', zone: 'workdir-normal' as const, targetKind: 'missing' as const, parentReal: '/tmp', parentIdentity: { dev: 1, ino: 2, mode: 0o40755, size: 0, mtimeMs: 1, nlink: 2 } }
    }
    handoff.onInitialGateResult?.(binding, gateResult, args)
    expect(contexts.get(JSON.stringify([binding.invocationId, binding.toolCallId]))?.writeExecutionPermit).toMatchObject({
      requestId: binding.requestId, toolUseId: binding.toolCallId, toolName: 'write_file', decisionRuleId: 'write-rule', approval: 'confirmed'
    })
  })

  it('finalizes a user fallback approval even when the original decision asked the approval agent', async () => {
    const registry = new ReadConfirmationRegistry({ now: () => 10 })
    const input = { path: '/tmp/approved.txt' }
    const mapping = [{ factId: 'fact-/tmp/approved.txt', decisionRuleId: 'human' }]
    registry.register({ requestId: binding.requestId, toolUseId: binding.toolCallId, inputDigest: readInputDigest(input), factIds: [mapping[0]!.factId], ruleId: 'human', expiresAt: 100 })
    const contexts = new Map<string, Record<string, unknown>>()
    const handoff = createAgentSdkStructuralPermitHandoff({
      readConfirmationRegistry: registry,
      updateExecutionContext: (call, update) => {
        const key = JSON.stringify([call.invocationId, call.toolCallId])
        const context = contexts.get(key) ?? {}
        update(context)
        contexts.set(key, context)
      }
    })
    const gateResult = {
      ...result({ type: 'require-confirm', ruleId: 'human', answerer: 'agent', riskLevel: 'medium', facts, memoryTiers: [], timeoutMs: 1000 }),
      readPathFact: { normalizedPath: input.path, zone: 'sensitive-file' as const, targetKind: 'file' as const },
      readTargetMapping: mapping
    }
    const args = { ...baseArgs, toolName: 'read_file', toolInput: input, requestId: binding.requestId, toolUseId: binding.toolCallId } as ToolCallGateArgs
    const policy = createAgentSdkSafetyPolicy({
      resolveGateArgs: async () => args,
      evaluateGate: async () => gateResult,
      ...handoff
    })
    const confirmedBinding = {
      ...binding,
      inputSnapshotHash: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      authorizationVersion: 'policy-v1'
    }
    await expect(policy.evaluate(confirmedBinding)).resolves.toMatchObject({ kind: 'ask', answerer: 'agent' })
    markAgentSdkSafetyDecisionConfirmed(policy, confirmedBinding, 'user')
    const attached = contexts.get(JSON.stringify([binding.invocationId, binding.toolCallId]))?.readExecutionPermit
    expect(attached).toMatchObject({ requestId: binding.requestId, toolUseId: binding.toolCallId, toolName: 'read_file', targets: mapping.map((target) => expect.objectContaining(target)) })
    await expect(policy.evaluate({ ...confirmedBinding, phase: 'recheck' })).resolves.toEqual({ kind: 'allow', authorizationVersion: 'policy-v1' })
    expect(registry.stats().activeEntries).toBe(0)
  })

  it('将策略拒绝、缺料异常与 recheck 中再次确认 fail closed', async () => {
    const denied = createAgentSdkSafetyPolicy({ resolveGateArgs: async () => baseArgs, evaluateGate: async () => result({ type: 'deny', ruleId: 'floor', reason: 'no' }) })
    await expect(denied.evaluate(binding)).resolves.toMatchObject({ kind: 'deny', reasonCode: 'POLICY_DENY' })
    const recheck = createAgentSdkSafetyPolicy({
      resolveGateArgs: async () => baseArgs,
      evaluateGate: async (args) => {
        expect(args.phase).toBe('recheck')
        return result({ type: 'deny', ruleId: 'recheck-requires-confirm', reason: 'no second confirm' })
      }
    })
    await expect(recheck.evaluate({ ...binding, phase: 'recheck' })).resolves.toMatchObject({ kind: 'deny' })
    const missing = createAgentSdkSafetyPolicy({ resolveGateArgs: async () => { throw new Error('missing') } })
    await expect(missing.evaluate(binding)).resolves.toMatchObject({ kind: 'deny', reasonCode: 'MISSING_MATERIAL' })
  })
})
import { createHash } from 'node:crypto'
