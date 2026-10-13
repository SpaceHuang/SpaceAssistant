import { describe, expect, it } from 'vitest'
import { createInvocationFactsSnapshot } from './invocationFactsSnapshot'
import { recheckInvocationFactsSnapshot, redecideSupplementedInvocation, redecideAndFenceSupplementedInvocation } from './recheckInvocationFacts'
import type { ContentFacts } from './types'
import type { PolicyEngineDeps, PolicyRule } from './types'
import { DEFAULT_POLICY_RULES } from '../policy/defaultRules'

const envelope = { toolName: 'write_file', input: { path: 'report.txt', content: 'hello' } }
const facts: ContentFacts = { toolName: 'write_file', actionClass: 'write', baseRiskLevel: 'low', signals: [], summary: { text: 'create report' } }

describe('pre-dispatch invocation fact recheck', () => {
  it('binds a fresh policy decision to the exact verified snapshot fingerprint', async () => {
    const snapshot = await createInvocationFactsSnapshot({ invocationId: 'inv-fenced-decision', envelope, facts,
      extractorVersion: 'extractor-v1', completeness: 'complete', evidenceReferences: ['host:verified'],
      environmentVersion: 'env-1', policyVersion: 'policy-v1', previousFactsRevision: 4 })
    const result = await redecideAndFenceSupplementedInvocation({ snapshot,
      context: { lane: 'wechat', origin: { kind: 'direct-owner' }, sessionId: 's1' },
      rules: [{ id: 'ask', when: 'invocation', action: 'ask', locked: false, reason: 'human', match: { toolName: 'write_file' } }],
      deps: { cache: { lookup: () => null }, config: {}, migrationComplete: false } })
    expect(result).toMatchObject({ factsRevision: 5, factsHash: snapshot.factsHash, envelopeHash: snapshot.envelopeHash,
      environmentVersion: 'env-1', policyVersion: 'policy-v1', decision: { type: 'require-confirm', ruleId: 'ask' } })
    const tampered = { ...snapshot, facts: { ...snapshot.facts, toolName: 'other_tool' } }
    await expect(redecideAndFenceSupplementedInvocation({ snapshot: tampered, context: {
      lane: 'wechat', origin: { kind: 'direct-owner' }, sessionId: 's1' }, rules: [],
      deps: { cache: { lookup: () => null }, config: {}, migrationComplete: false } })).rejects.toThrow(/snapshot/i)
  })

  it.each([
    {
      name: 'remote out-of-workdir writes are forbidden and create no todo',
      toolName: 'write_file', actionClass: 'write' as const, lane: 'wechat' as const,
      signals: [{ kind: 'write-target-scope' as const, scope: 'outside-workdir' as const }],
      rules: DEFAULT_POLICY_RULES, expected: { type: 'deny', ruleId: 'remote-outside-write-deny' }, todo: false
    },
    {
      name: 'sensitive script paths require a human and are deferred for a todo',
      toolName: 'run_script', actionClass: 'execute' as const, lane: 'wechat' as const,
      signals: [{ kind: 'path-target' as const, path: '/tmp/.env', zone: 'sensitive-file' as const }],
      rules: DEFAULT_POLICY_RULES, expected: { type: 'require-confirm', ruleId: 'script-sensitive-path-confirm', answerer: 'user' }, todo: true
    },
    {
      name: 'high-impact Lark CLI follows its explicit human-confirm rule',
      toolName: 'run_lark_cli', actionClass: 'execute' as const, lane: 'feishu' as const,
      signals: [{ kind: 'lark-subcommand' as const, impact: 'high_impact' as const }],
      rules: DEFAULT_POLICY_RULES, expected: { type: 'require-confirm', ruleId: 'lark-high-impact-ask', answerer: 'user' }, todo: true
    },
    {
      name: 'high-impact Lark CLI can be forbidden by an explicit capability policy',
      toolName: 'run_lark_cli', actionClass: 'execute' as const, lane: 'feishu' as const,
      signals: [{ kind: 'lark-subcommand' as const, impact: 'high_impact' as const }],
      rules: [{ id: 'lark-capability-forbidden', when: 'invocation' as const, action: 'deny' as const, locked: true,
        reason: 'capability denied', match: { lane: ['feishu' as const], toolName: 'run_lark_cli', signals: ['lark-high_impact'] } }],
      expected: { type: 'deny', ruleId: 'lark-capability-forbidden' }, todo: false
    }
  ])('$name', async ({ toolName, actionClass, lane, signals, rules, expected, todo }) => {
    const classifiedFacts: ContentFacts = { ...facts, toolName, actionClass, signals }
    const snapshot = await createInvocationFactsSnapshot({ invocationId: `class-${toolName}-${lane}`, envelope,
      facts: classifiedFacts, extractorVersion: 'extractor-v1', completeness: 'complete', evidenceReferences: [],
      environmentVersion: 'env-1', previousFactsRevision: 0 })
    const result = redecideSupplementedInvocation({ snapshot, context: { lane, origin: { kind: 'direct-owner' }, sessionId: 's-class' },
      rules, deps: { cache: { lookup: () => null }, config: {}, migrationComplete: false } })
    expect(result).toMatchObject(expected)
    expect(result.type === 'require-confirm').toBe(todo)
  })

  it('reruns hard-deny, human-required, normal policy and outbound budget constraints without old cache approvals', async () => {
    const prior = await createInvocationFactsSnapshot({ invocationId: 'inv-redo', envelope, facts, extractorVersion: 'extractor-v1',
      completeness: 'complete', evidenceReferences: [], environmentVersion: 'env-1', previousFactsRevision: 0 })
    const context = { lane: 'wechat' as const, origin: { kind: 'direct-owner' as const }, sessionId: 's1' }
    const cachedAllow = { lookup: () => ({
      id: 'old-approval', key: { kind: 'shell-command', verb: 'old', level: 'exact' } as never,
      decision: 'allow' as const, lane: '*', scope: 'persistent' as const, createdAt: 1, lastHitAt: 1,
      hitCount: 1, source: 'user-confirm' as const
    }) }
    const deps: PolicyEngineDeps = { cache: cachedAllow, config: {}, migrationComplete: false,
      autoEvaluator: () => ({ approve: true, reason: 'stale approval must not be reused' }) }
    const invoke = async (toolName: string, actionClass: ContentFacts['actionClass'],
      signals: ContentFacts['signals'], rules: PolicyRule[], outboundWriteBudgetRemaining?: number) =>
      redecideSupplementedInvocation({ snapshot: await createInvocationFactsSnapshot({ invocationId: prior.invocationId, envelope,
        facts: { ...facts, toolName, actionClass, signals }, extractorVersion: prior.extractorVersion, completeness: 'complete',
        evidenceReferences: [], environmentVersion: prior.environmentVersion, previousFactsRevision: prior.factsRevision }),
        context: { ...context, outboundWriteBudgetRemaining }, rules, deps })

    await expect(invoke('blocked', 'write', [], [{ id: 'deny', when: 'invocation', action: 'deny', locked: true,
      reason: 'blocked', match: { toolName: 'blocked' } }])).resolves.toMatchObject({ type: 'deny', ruleId: 'deny' })
    await expect(invoke('sensitive', 'write', [], [{ id: 'human', when: 'invocation', action: 'ask', locked: true,
      humanRequired: true, reason: 'ask a person', match: { toolName: 'sensitive' } }])).resolves.toMatchObject({
        type: 'require-confirm', answerer: 'user', disposition: 'human-required', ruleId: 'human'
      })
    await expect(invoke('ordinary', 'write', [], [{ id: 'ordinary-ask', when: 'invocation', action: 'ask', locked: false,
      reason: 'ordinary ask', match: { toolName: 'ordinary' } }])).resolves.toMatchObject({
        type: 'require-confirm', answerer: 'user', ruleId: 'ordinary-ask'
      })
    await expect(invoke('wechat_send', 'outbound', [{ kind: 'wechat-media-target', boundary: 'external' }],
      DEFAULT_POLICY_RULES, 0)).resolves.toMatchObject({ type: 'deny', ruleId: 'remote-outbound-budget-pause-wechat' })
  })

  it('keeps the current snapshot only when every bound fact is unchanged', async () => {
    const prior = await createInvocationFactsSnapshot({ invocationId: 'inv-1', envelope, facts, extractorVersion: 'extractor-v1',
      completeness: 'complete', evidenceReferences: [], environmentVersion: 'env-1', previousFactsRevision: 0 })
    const result = await recheckInvocationFactsSnapshot({ prior, envelope, facts, extractorVersion: 'extractor-v1',
      completeness: 'complete', evidenceReferences: [], environmentVersion: 'env-1' })
    expect(result).toEqual({ status: 'current', snapshot: prior })
  })

  it('creates a newer snapshot and requests redecision when bound facts changed', async () => {
    const prior = await createInvocationFactsSnapshot({ invocationId: 'inv-1', envelope, facts, extractorVersion: 'extractor-v1',
      completeness: 'complete', evidenceReferences: [], environmentVersion: 'env-1', previousFactsRevision: 0 })
    const supplementedFacts: ContentFacts = { ...facts, summary: { text: 'create verified report' } }
    const result = await recheckInvocationFactsSnapshot({ prior, envelope: { ...envelope, input: { path: 'other.txt' } }, facts: supplementedFacts,
      extractorVersion: 'extractor-v1', completeness: 'complete', evidenceReferences: [], environmentVersion: 'env-1' })
    expect(result.status).toBe('redecide')
    if (result.status === 'redecide') {
      expect(result.snapshot.factsRevision).toBe(prior.factsRevision + 1)
      expect(result.snapshot.factsHash).not.toBe(prior.factsHash)
      expect(result.snapshot.envelopeHash).not.toBe(prior.envelopeHash)

      // Candidate and approval evidence are bound to the original facts hash;
      // neither can authorize the newly re-extracted invocation.
      const priorCandidate = { factsRevision: prior.factsRevision, factsHash: prior.factsHash, action: 'write' }
      const priorApproval = { factsRevision: prior.factsRevision, factsHash: prior.factsHash, approved: true }
      expect(priorCandidate).not.toMatchObject({ factsRevision: result.snapshot.factsRevision, factsHash: result.snapshot.factsHash })
      expect(priorApproval).not.toMatchObject({ factsRevision: result.snapshot.factsRevision, factsHash: result.snapshot.factsHash })
    }
  })

  it('requests a new decision when the environment or authorization generation changes', async () => {
    const prior = await createInvocationFactsSnapshot({ invocationId: 'inv-env', envelope, facts, extractorVersion: 'extractor-v1',
      completeness: 'complete', evidenceReferences: [], environmentVersion: 'permission-epoch-3', previousFactsRevision: 0 })
    const result = await recheckInvocationFactsSnapshot({ prior, envelope, facts, extractorVersion: 'extractor-v1',
      completeness: 'complete', evidenceReferences: [], environmentVersion: 'permission-epoch-4' })
    expect(result.status).toBe('redecide')
    if (result.status === 'redecide') {
      expect(result.snapshot.factsRevision).toBe(prior.factsRevision + 1)
      expect(result.snapshot.environmentVersion).toBe('permission-epoch-4')
    }
  })

  it('requests a new decision when policy version, envelope, or environment target changes', async () => {
    const prior = await createInvocationFactsSnapshot({ invocationId: 'inv-fence', envelope, facts, extractorVersion: 'extractor-v1',
      completeness: 'complete', evidenceReferences: [], environmentVersion: 'workspace-A:policy-v1', previousFactsRevision: 0 })
    const policyChanged = await recheckInvocationFactsSnapshot({ prior, envelope, facts, extractorVersion: 'extractor-v1',
      completeness: 'complete', evidenceReferences: [], environmentVersion: 'workspace-A', policyVersion: 'policy-v2' })
    const targetChanged = await recheckInvocationFactsSnapshot({ prior, envelope, facts, extractorVersion: 'extractor-v1',
      completeness: 'complete', evidenceReferences: [], environmentVersion: 'workspace-B:policy-v1' })
    const envelopeChanged = await recheckInvocationFactsSnapshot({ prior, envelope: { ...envelope, input: { path: 'other.txt' } },
      facts, extractorVersion: 'extractor-v1', completeness: 'complete', evidenceReferences: [], environmentVersion: 'workspace-A:policy-v1' })
    expect(policyChanged).toMatchObject({ status: 'redecide', snapshot: { environmentVersion: 'workspace-A', policyVersion: 'policy-v2' } })
    expect(targetChanged).toMatchObject({ status: 'redecide', snapshot: { environmentVersion: 'workspace-B:policy-v1' } })
    expect(envelopeChanged).toMatchObject({ status: 'redecide' })
  })

  it('fails closed on exhausted supplement budget and verifier failure', async () => {
    const prior = await createInvocationFactsSnapshot({ invocationId: 'inv-failure', envelope, facts, extractorVersion: 'extractor-v1',
      completeness: 'partial', evidenceReferences: [], environmentVersion: 'env-1', previousFactsRevision: 0 })
    const base = { prior, envelope, requestedReferences: ['host:evidence'], round: 1, deadlineAt: 100,
      now: () => 10, resolveEvidence: () => ({ signals: [] }) }
    await expect((await import('./factsSupplement')).verifyAndCreateFactsSupplement({ ...base, round: 4 }))
      .rejects.toThrow('FACTS_SUPPLEMENT_ROUND_LIMIT')
    await expect((await import('./factsSupplement')).verifyAndCreateFactsSupplement({ ...base,
      resolveEvidence: () => undefined })).rejects.toThrow('FACTS_SUPPLEMENT_EVIDENCE_UNVERIFIED')
  })

  it('returns human-required or hard-deny when current facts are incomplete or invalid', async () => {
    const prior = await createInvocationFactsSnapshot({ invocationId: 'inv-1', envelope, facts, extractorVersion: 'extractor-v1',
      completeness: 'complete', evidenceReferences: [], environmentVersion: 'env-1', previousFactsRevision: 0 })
    const missing = await recheckInvocationFactsSnapshot({ prior, envelope, facts, extractorVersion: 'extractor-v1',
      completeness: 'missing', evidenceReferences: [], environmentVersion: 'env-1' })
    const parseFailed = await recheckInvocationFactsSnapshot({ prior, envelope, facts, extractorVersion: 'extractor-v1',
      completeness: 'parse-failed', evidenceReferences: [], environmentVersion: 'env-1' })
    expect(missing).toMatchObject({ status: 'human-required' })
    expect(parseFailed).toMatchObject({ status: 'hard-deny' })
  })
})
