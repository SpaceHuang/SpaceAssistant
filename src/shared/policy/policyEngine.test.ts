import { describe, expect, it, vi } from 'vitest'
import type {
  ContentFacts,
  DecisionCacheView,
  ExecutionContext,
  PolicyEngineDeps
} from '../confirmation/types'
import { DEFAULT_POLICY_RULES } from './defaultRules'
import { buildMemoryTiers, decide, decideIngress, deriveInvocationPolicyConstraints, resolvePolicyOutcome, signalTokenSet } from './policyEngine'
import { effectiveActionFor, resolvePolicyRules } from './policyPackages'
import { imEffectiveActionFor } from './policyPackages'
import { resolveImPolicyRulesForVersion } from './policyPackages'
import type { PolicyAction } from '../confirmation/types'

function mkFacts(
  toolName: string,
  actionClass: ContentFacts['actionClass'],
  signals: ContentFacts['signals'],
  baseRiskLevel: ContentFacts['baseRiskLevel'] = 'medium'
): ContentFacts {
  return { toolName, actionClass, baseRiskLevel, signals, summary: { text: 'summary' } }
}

function mkContext(lane: ExecutionContext['lane']): ExecutionContext {
  return {
    lane,
    origin: { kind: 'direct-owner' },
    sessionId: 's1'
  }
}

function emptyCache(): DecisionCacheView {
  return { lookup: () => null }
}

function cacheWith(decision: 'allow' | 'deny'): DecisionCacheView {
  return {
    lookup: () => ({
      id: 'c1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      key: { kind: 'shell-command', verb: 'ping', level: 'exact' } as any,
      decision,
      lane: '*',
      scope: 'persistent',
      createdAt: 1,
      lastHitAt: 1,
      hitCount: 1,
      source: 'user-confirm'
    })
  }
}

function allowCacheForRequestedKey(lane: 'desktop' | 'automation'): DecisionCacheView {
  return { lookup: (key) => ({ id: 'policy-boundary-cache', key, decision: 'allow', lane, scope: 'persistent',
    createdAt: 1, lastHitAt: 1, hitCount: 1, source: 'user-confirm' }) }
}

function deps(overrides: Partial<PolicyEngineDeps> = {}): PolicyEngineDeps {
  return {
    cache: emptyCache(),
    config: {},
    migrationComplete: false,
    ...overrides
  }
}

describe('decide：脚本规则族（规范条目顺序）', () => {
  it('显式 allow 覆盖同一规则的 locked、humanRequired 与逐次确认默认语义', () => {
    const rules = [{ id: 'user-selected', when: 'invocation' as const, action: 'allow' as const,
      userOverride: true as const, locked: true, humanRequired: true, reason: 'r' }]
    const result = decide(mkFacts('write_file', 'write', [], 'high'), mkContext('desktop'), rules, deps())
    expect(result).toMatchObject({ type: 'auto-allow', ruleId: 'user-selected' })
  })

  it('同一条多规则集合同时有 allow override 和普通 ask 时仍由 ask 优先', () => {
    const rules = [
      { id: 'user-allow', when: 'invocation' as const, action: 'allow' as const, userOverride: true as const, reason: 'r1' },
      { id: 'independent-ask', when: 'invocation' as const, action: 'ask' as const, reason: 'r2' }
    ]
    expect(decide(mkFacts('write_file', 'write', [], 'high'), mkContext('desktop'), rules, deps()))
      .toMatchObject({ type: 'require-confirm', ruleId: 'independent-ask', answerer: 'user' })
  })

  it('多规则优先级：独立 deny 高于显式 ask override', () => {
    const rules = [
      { id: 'user-ask', when: 'invocation' as const, action: 'ask' as const, userOverride: true as const, reason: 'r1' },
      { id: 'independent-deny', when: 'invocation' as const, action: 'deny' as const, reason: 'r2' }
    ]
    expect(decide(mkFacts('write_file', 'write', [], 'high'), mkContext('desktop'), rules, deps()))
      .toMatchObject({ type: 'deny', ruleId: 'independent-deny' })
  })

  it('explicit allow override cannot bypass the deniedTools policy boundary', () => {
    const allowOverride = { id: 'custom-allow', when: 'invocation' as const, action: 'allow' as const, userOverride: true as const, reason: 'custom allow' }
    expect(decide(mkFacts('write_file', 'write', [], 'high'), mkContext('desktop'), [allowOverride],
      deps({ config: { deniedTools: ['write_file'] } }))).toMatchObject({ type: 'deny', ruleId: 'denied-tools' })
  })

  it('independent ask outranks custom automatic review in either rule order', () => {
    const facts = mkFacts('write_file', 'write', [], 'high')
    const context = mkContext('desktop')
    const automatic = { id: 'custom-auto', when: 'invocation' as const, action: 'auto-evaluator' as const, userOverride: true as const, reason: 'custom automatic review' }
    const ask = { id: 'independent-ask', when: 'invocation' as const, action: 'ask' as const, reason: 'independent ask' }
    for (const rules of [[automatic, ask], [ask, automatic]]) {
      expect(decide(facts, context, rules, deps())).toMatchObject({ type: 'require-confirm', ruleId: 'independent-ask', answerer: 'user' })
    }

    const allow = { id: 'custom-allow', when: 'invocation' as const, action: 'allow' as const, userOverride: true as const, reason: 'custom allow' }
    const automaticIndependent = { id: 'independent-auto', when: 'invocation' as const, action: 'auto-evaluator' as const, reason: 'independent automatic review' }
    for (const rules of [[allow, ask], [ask, allow]]) {
      expect(decide(facts, context, rules, deps())).toMatchObject({ type: 'require-confirm', ruleId: 'independent-ask', answerer: 'user' })
    }
    for (const rules of [[allow, automaticIndependent], [automaticIndependent, allow]]) {
      expect(decide(facts, context, rules, deps())).toMatchObject({ type: 'require-confirm', ruleId: 'independent-auto', answerer: 'agent' })
    }
  })

  it('所有匹配规则统一按 deny > ask > auto > allow 裁决且不依赖排列顺序', () => {
    const facts = mkFacts('write_file', 'write', [], 'high')
    const context = mkContext('desktop')
    const make = (id: string, action: PolicyAction) => ({ id, when: 'invocation' as const, action, userOverride: true as const, reason: id })
    const cases: Array<[PolicyAction[], string, string]> = [
      [['allow', 'deny'], 'deny', 'deny'],
      [['allow', 'ask'], 'require-confirm', 'ask'],
      [['auto-evaluator', 'ask'], 'require-confirm', 'ask'],
      [['allow', 'auto-evaluator'], 'require-confirm', 'auto-evaluator']
    ]
    for (const [actions, type, ruleId] of cases) {
      const rules = actions.map((action, index) => make(action === 'ask' ? 'ask' : action, action))
      const expected = type === 'deny' ? { type, ruleId } : type === 'require-confirm'
        ? { type, ruleId: ruleId === 'ask' ? 'ask' : 'auto-evaluator', answerer: ruleId === 'ask' ? 'user' : 'agent' }
        : { type, ruleId }
      expect(decide(facts, context, rules, deps()), actions.join(',')).toMatchObject(expected)
      expect(decide(facts, context, [...rules].reverse(), deps()), actions.join(',')).toMatchObject(expected)
    }
    const tiedAsks = [make('ask-b', 'ask'), make('ask-a', 'ask')]
    expect(decide(facts, context, tiedAsks, deps())).toMatchObject({ type: 'require-confirm', ruleId: 'ask-a' })
    expect(decide(facts, context, [...tiedAsks].reverse(), deps())).toMatchObject({ type: 'require-confirm', ruleId: 'ask-a' })
  })

  it('默认规则集合中的 ask 优先于 allow，即使没有显式覆盖', () => {
    const facts = mkFacts('probe', 'execute', [], 'medium')
    const rules = [
      { id: 'default-allow', when: 'invocation' as const, action: 'allow' as const, reason: 'allow' },
      { id: 'default-ask', when: 'invocation' as const, action: 'ask' as const, reason: 'ask' }
    ]
    expect(decide(facts, mkContext('desktop', { policyTier: 'custom' }), rules, deps()))
      .toMatchObject({ type: 'require-confirm', answerer: 'user', ruleId: 'default-ask' })
  })

  it('默认规则集合中的 ask 优先于 auto-evaluator 的快速批准', () => {
    const facts = mkFacts('probe', 'execute', [], 'medium')
    const rules = [
      { id: 'default-auto', when: 'invocation' as const, action: 'auto-evaluator' as const, reason: 'auto' },
      { id: 'default-ask', when: 'invocation' as const, action: 'ask' as const, reason: 'ask' }
    ]
    const evaluator = vi.fn(() => ({ approve: true as const, reason: 'fast-path' }))
    expect(decide(facts, mkContext('desktop', { policyTier: 'custom' }), rules, deps({ autoEvaluator: evaluator })))
      .toMatchObject({ type: 'require-confirm', answerer: 'user', ruleId: 'default-ask' })
    expect(evaluator).not.toHaveBeenCalled()
  })

  it('显式 auto-evaluator 在旧 allow 缓存前执行审核', () => {
    const facts = mkFacts('mcp.test.read', 'read', [{ kind: 'mcp-tool', serverId: 'mcp.test', toolName: 'read' }])
    const rule = { ...DEFAULT_POLICY_RULES.find(({ id }) => id === 'mcp-tool-ask')!, action: 'auto-evaluator' as const, userOverride: true as const }
    const evaluator = vi.fn(() => ({ approve: false as const, reason: 'needs agent review' }))
    const decision = decide(facts, mkContext('desktop'), [rule], deps({ cache: allowCacheForRequestedKey('desktop'), autoEvaluator: evaluator }))
    expect(decision).toMatchObject({ type: 'require-confirm', ruleId: 'mcp-tool-ask', answerer: 'agent' })
    expect(evaluator).toHaveBeenCalledOnce()
  })

  it('automation 的默认明确 deny 在旧 allow 缓存前生效', () => {
    const facts = mkFacts('mcp.test.read', 'read', [
      { kind: 'mcp-tool', serverId: 'mcp.test', toolName: 'read' },
      { kind: 'automation-mcp-permission', status: 'missing' }
    ] as ContentFacts['signals'])
    expect(decide(facts, mkContext('automation'), DEFAULT_POLICY_RULES, deps({ cache: allowCacheForRequestedKey('automation') })))
      .toMatchObject({ type: 'deny', ruleId: 'automation-mcp-permission-missing-deny' })
  })
  it('unmodeled-call 只提供同会话 exact-content 记忆；动态执行仍逐次真人确认', () => {
    const digest = 'a'.repeat(64)
    const unknownScript = mkFacts('run_script', 'execute', [
      { kind: 'script-analysis', signal: 'clean', patterns: [] },
      { kind: 'script-path-extraction', completeness: 'unknown', dynamicAccess: false, unknownReason: 'unmodeled-call', contentDigest: digest, workdirDigest: 'd'.repeat(64) }
    ], 'high')
    const decision = decide(unknownScript, mkContext('desktop'), DEFAULT_POLICY_RULES, deps())
    expect(decision).toMatchObject({ type: 'require-confirm', ruleId: 'script-unmodeled-path-ask', answerer: 'user' })
    expect(decision.type === 'require-confirm' && decision.memoryTiers).toEqual([
      expect.objectContaining({ key: { kind: 'script-content', digest, workdirDigest: 'd'.repeat(64), sessionId: 's1' } })
    ])

    const dynamicScript = mkFacts('run_script', 'execute', [
      { kind: 'script-analysis', signal: 'clean', patterns: [] },
      { kind: 'script-path-extraction', completeness: 'unknown', dynamicAccess: true, unknownReason: 'dynamic-execution', contentDigest: digest, workdirDigest: 'd'.repeat(64) }
    ], 'high')
    const dynamic = decide(dynamicScript, mkContext('desktop'), DEFAULT_POLICY_RULES, deps())
    expect(dynamic).toMatchObject({ type: 'require-confirm', ruleId: 'script-dynamic-execution-confirm', answerer: 'user', memoryTiers: [] })
  })

  it('脚本内容记忆只在当前会话按完全相同的 SHA-256 键查找', () => {
    const digest = 'b'.repeat(64)
    const facts = mkFacts('run_script', 'execute', [
      { kind: 'script-analysis', signal: 'clean', patterns: [] },
      { kind: 'script-path-extraction', completeness: 'unknown', dynamicAccess: false, unknownReason: 'unmodeled-call', contentDigest: digest, workdirDigest: 'e'.repeat(64) }
    ], 'high')
    const lookups: Array<{ kind: string; digest?: string; sessionId?: string }> = []
    const cache: DecisionCacheView = {
      lookup: (key) => {
        lookups.push(key as typeof lookups[number])
        return key.kind === 'script-content' && key.digest === digest && key.workdirDigest === 'e'.repeat(64) && key.sessionId === 's1'
          ? { id: 'script-memory', key, decision: 'allow', lane: 'desktop', scope: 'session', createdAt: 1, lastHitAt: 1, hitCount: 1, source: 'user-confirm' }
          : null
      }
    }
    expect(decide(facts, mkContext('desktop'), DEFAULT_POLICY_RULES, deps({ cache }))).toMatchObject({ type: 'auto-allow', ruleId: 'cache-hit' })
    expect(lookups).toContainEqual(expect.objectContaining({ kind: 'script-content', digest, workdirDigest: 'e'.repeat(64), sessionId: 's1' }))
    lookups.length = 0
    expect(decide(facts, { ...mkContext('desktop'), sessionId: 's2' }, DEFAULT_POLICY_RULES, deps({ cache }))).toMatchObject({ type: 'require-confirm' })
    expect(lookups).toContainEqual(expect.objectContaining({ kind: 'script-content', digest, workdirDigest: 'e'.repeat(64), sessionId: 's2' }))
  })

  it('可疑脚本、动态执行和缺少分类/摘要时都不提供记忆且不消费缓存', () => {
    const digest = 'c'.repeat(64)
    const cases: ContentFacts[] = [
      mkFacts('run_script', 'execute', [
        { kind: 'script-analysis', signal: 'suspicious', patterns: ['network'] },
        { kind: 'script-path-extraction', completeness: 'unknown', dynamicAccess: false, unknownReason: 'unmodeled-call', contentDigest: digest, workdirDigest: 'd'.repeat(64) }
      ], 'high'),
      mkFacts('run_script', 'execute', [
        { kind: 'script-analysis', signal: 'clean', patterns: [] },
        { kind: 'script-path-extraction', completeness: 'unknown', dynamicAccess: true, unknownReason: 'dynamic-execution', contentDigest: digest }
      ], 'high'),
      mkFacts('run_script', 'execute', [
        { kind: 'script-analysis', signal: 'clean', patterns: [] },
        { kind: 'script-path-extraction', completeness: 'unknown', dynamicAccess: false }
      ], 'high'),
      mkFacts('run_script', 'execute', [
        { kind: 'script-path-extraction', completeness: 'unknown', dynamicAccess: false, unknownReason: 'unmodeled-call', contentDigest: digest }
      ], 'high'),
      mkFacts('run_script', 'execute', [
        { kind: 'script-analysis', signal: 'clean', patterns: [] },
        { kind: 'script-path-extraction', completeness: 'unknown', dynamicAccess: false, unknownReason: 'unmodeled-call', contentDigest: 'not-a-sha256' }
      ], 'high')
    ]
    for (const facts of cases) {
      const lookup = vi.fn(() => ({ id: 'should-not-hit', key: { kind: 'script-content', digest, sessionId: 's1' }, decision: 'allow', lane: 'desktop', scope: 'session', createdAt: 1, lastHitAt: 1, hitCount: 1, source: 'user-confirm' } as never))
      const decision = decide(facts, mkContext('desktop'), DEFAULT_POLICY_RULES, deps({ cache: { lookup } }))
      expect(decision).toMatchObject({ type: 'require-confirm', memoryTiers: [] })
      expect(lookup).not.toHaveBeenCalled()
    }
  })
  it('敏感读取必须真人确认，且不受缓存影响', () => {
    const d = decide(mkFacts('read_file', 'read', [{ kind: 'path-target', path: '/x/.env', zone: 'sensitive-file' }]), mkContext('desktop'), DEFAULT_POLICY_RULES, deps({ cache: cacheWith('allow') }))
    expect(d).toMatchObject({ type: 'require-confirm', ruleId: 'path-sensitive-read-confirm', answerer: 'user' })
  })

  it('系统目录读取必须真人确认', () => {
    const d = decide(mkFacts('read_file', 'read', [{ kind: 'path-target', path: '/etc/hosts', zone: 'system-dir' }]), mkContext('desktop'), DEFAULT_POLICY_RULES, deps())
    expect(d).toMatchObject({ type: 'require-confirm', ruleId: 'path-system-dir-ask', answerer: 'user' })
  })

  it('工作目录外的普通读取自动放行', () => {
    const d = decide(mkFacts('read_file', 'read', [{ kind: 'path-target', path: '/tmp/a', zone: 'outside-workdir' }]), mkContext('desktop'), DEFAULT_POLICY_RULES, deps())
    expect(d).toMatchObject({ type: 'auto-allow', ruleId: 'path-outside-readonly-allow' })
  })

  it('桌面 run_script clean 免确认（script-clean-allow-desktop）', () => {
    const d = decide(
      mkFacts('run_script', 'execute', [{ kind: 'script-analysis', signal: 'clean', patterns: [] }], 'high'),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('auto-allow')
  })

  it('桌面 clean+script-network 走确认（不被 clean 放行抢先命中）', () => {
    const d = decide(
      mkFacts('run_script', 'execute', [
        { kind: 'script-analysis', signal: 'clean', patterns: [] },
        { kind: 'script-network', patterns: ['socket'] }
      ], 'high'),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('require-confirm')
    expect(d.type === 'require-confirm' && d.ruleId).toBe('script-network-ask-desktop')
  })

  it('远程 clean+script-network 直接拒绝（不升级为问）', () => {
    const d = decide(
      mkFacts('run_script', 'execute', [
        { kind: 'script-analysis', signal: 'clean', patterns: [] },
        { kind: 'script-network', patterns: ['socket'] }
      ], 'high'),
      mkContext('wechat'),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('deny')
    expect(d.type === 'deny' && d.ruleId).toBe('script-network-deny-remote')
  })

  it('远程 clean+script-uncertified 必确认（即使 remoteScriptRequiresConfirm=false）', () => {
    const d = decide(
      mkFacts('run_script', 'execute', [
        { kind: 'script-analysis', signal: 'clean', patterns: [] },
        { kind: 'script-uncertified' }
      ], 'high'),
      mkContext('wechat'),
      DEFAULT_POLICY_RULES,
      deps({ config: { remoteScriptRequiresConfirm: false }, migrationComplete: true })
    )
    expect(d.type).toBe('require-confirm')
    expect(d.type === 'require-confirm' && d.ruleId).toBe('script-uncertified-ask-remote')
  })

  it('远程 clean 已认证 + remoteScriptRequiresConfirm=false + 迁移完成 → 免确认', () => {
    const d = decide(
      mkFacts('run_script', 'execute', [{ kind: 'script-analysis', signal: 'clean', patterns: [] }], 'high'),
      mkContext('wechat'),
      DEFAULT_POLICY_RULES,
      deps({ config: { remoteScriptRequiresConfirm: false }, migrationComplete: true })
    )
    expect(d.type).toBe('auto-allow')
    expect(d.type === 'auto-allow' && d.ruleId).toBe('script-clean-certified-remote')
  })

  it('远程 clean 已认证 + remoteScriptRequiresConfirm=true（默认）→ 确认', () => {
    const d = decide(
      mkFacts('run_script', 'execute', [{ kind: 'script-analysis', signal: 'clean', patterns: [] }], 'high'),
      mkContext('feishu'),
      DEFAULT_POLICY_RULES,
      deps({ config: {}, migrationComplete: true })
    )
    expect(d.type).toBe('require-confirm')
  })
})

describe('decide：统一策略结果优先级契约', () => {
  const facts = mkFacts('protected-tool', 'write', [], 'high')
  const context = mkContext('wechat')
  const rule = (id: string, action: PolicyAction, extra: Partial<import('../confirmation/types').PolicyRule> = {}) => ({
    id, when: 'invocation' as const,
    match: { toolName: 'protected-tool' }, action, reason: id,
    ...extra
  })

  it('hard deny outranks human-required regardless of rule order', () => {
    const forbidden = rule('forbidden', 'deny', { denyClass: 'forbidden' })
    const human = rule('human-required', 'ask', { humanRequired: true })
    for (const rules of [[human, forbidden], [forbidden, human]]) {
      expect(decide(facts, context, rules, deps())).toMatchObject({ type: 'deny', ruleId: 'forbidden' })
    }
  })

  it('critical forbidden deny outranks human-required regardless of rule order', () => {
    const critical = rule('critical', 'deny', { denyClass: 'forbidden' })
    const human = rule('human-required', 'ask', { humanRequired: true })
    for (const rules of [[human, critical], [critical, human]]) {
      expect(decide(facts, context, rules, deps())).toMatchObject({ type: 'deny', ruleId: 'critical' })
    }
  })

  it('human-required ask outranks automatic review', () => {
    const human = rule('human-required', 'ask', { humanRequired: true })
    const automatic = rule('automatic-review', 'auto-evaluator')
    for (const rules of [[automatic, human], [human, automatic]]) {
      expect(decide(facts, context, rules, deps())).toMatchObject({
        type: 'require-confirm', ruleId: 'human-required', answerer: 'user'
      })
    }
  })

  it('locked metadata does not change the action outcome', () => {
    const lockedAsk = rule('ask', 'ask', { locked: true })
    const editableAsk = rule('ask', 'ask', { locked: false })
    const lockedDeny = rule('deny', 'deny', { locked: true })
    const editableDeny = rule('deny', 'deny', { locked: false })
    expect(decide(facts, context, [lockedAsk], deps())).toMatchObject({ type: 'require-confirm' })
    expect(decide(facts, context, [editableAsk], deps())).toMatchObject({ type: 'require-confirm' })
    expect(decide(facts, context, [lockedDeny], deps())).toMatchObject({ type: 'deny' })
    expect(decide(facts, context, [editableDeny], deps())).toMatchObject({ type: 'deny' })
  })

  it('returns a unified disposition, cause, and reason for deny, human, and automatic outcomes', () => {
    const hardDeny = decide(facts, context, [rule('forbidden', 'deny', { denyClass: 'forbidden' })], deps())
    const human = decide(facts, context, [rule('human', 'ask', { humanRequired: true })], deps())
    const automatic = decide(facts, context, [rule('automatic', 'auto-evaluator')], deps())
    expect(hardDeny).toMatchObject({ disposition: 'forbidden', cause: 'hard-deny', reason: 'forbidden', ruleId: 'forbidden' })
    expect(human).toMatchObject({ disposition: 'human-required', cause: 'human-required', reason: 'human', ruleId: 'human' })
    expect(automatic).toMatchObject({ disposition: 'auto-eligible', reason: 'automatic', ruleId: 'automatic' })
    expect(resolvePolicyOutcome(rule('forbidden', 'deny', { denyClass: 'forbidden' }))).toEqual({
      disposition: 'forbidden', cause: 'forbidden', reason: 'forbidden'
    })
    expect(resolvePolicyOutcome(rule('human', 'ask', { humanRequired: true }))).toEqual({
      disposition: 'human-required', cause: 'human-required', reason: 'human'
    })
    expect(resolvePolicyOutcome(rule('automatic', 'auto-evaluator'))).toEqual({
      disposition: 'auto-eligible', cause: 'automatic', reason: 'automatic'
    })
  })
})

describe('decide：IM effective action 覆盖契约', () => {
  const facts = mkFacts('write_file', 'write', [], 'low')
  const context = mkContext('wechat')
  const lowRiskCreate = {
    id: 'im-low-risk-create', when: 'invocation' as const,
    match: { toolName: 'write_file' }, action: 'ask' as const, reason: '低风险新建'
  }

  it('effective IM action honors strict and loose scopes', () => {
    expect(decide(facts, context, [lowRiskCreate], deps({ transform: (rule) => imEffectiveActionFor('im', 'strict', rule) }))).toMatchObject({ type: 'require-confirm' })
    expect(decide(facts, context, [lowRiskCreate], deps({ transform: (rule) => imEffectiveActionFor('im', 'loose', rule) }))).toMatchObject({ type: 'auto-allow' })
  })

  it('custom explicit ask is not transformed by package mapping', () => {
    expect(decide(facts, context, [lowRiskCreate], deps({ transform: (rule) => imEffectiveActionFor('im', 'custom', rule, 'ask') }))).toMatchObject({ type: 'require-confirm' })
  })

  it('maps the registered env.time capability into the shared IM standard review candidate', () => {
    const timeCall = mkFacts('toolkit.call', 'execute', [
      { kind: 'toolkit-capability', capabilityId: 'env.time', risk: 'read' }
    ], 'low')
    const standardTransform = (rule: Parameters<typeof imEffectiveActionFor>[2]) => imEffectiveActionFor('im', 'standard', rule)
    expect(decide(timeCall, context, DEFAULT_POLICY_RULES, deps({ transform: standardTransform })))
      .toMatchObject({ type: 'require-confirm', ruleId: 'im-time-query-review', answerer: 'agent' })
  })

  it('routes an ordinary new IM workspace file through the dedicated low risk rule', () => {
    const imRules = resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'standard', rules: DEFAULT_POLICY_RULES })
    const transform = (rule: Parameters<typeof imEffectiveActionFor>[2]) => imEffectiveActionFor('im', 'standard', rule)
    const result = decide(mkFacts('write_file', 'write', [
      { kind: 'path-target', path: '/work/new.md', zone: 'workdir-normal' },
      { kind: 'write-target-scope', scope: 'inside-workdir' },
      { kind: 'write-target-new' }
    ]), context, imRules, deps({ transform }))
    expect(result).toMatchObject({ type: 'require-confirm', ruleId: 'im-low-risk-create', answerer: 'agent' })
  })

  it('routes ordinary browser actions and classified Feishu writes to Agent, while dangerous actions and message sends stay with the user', () => {
    const imRules = resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'standard', rules: DEFAULT_POLICY_RULES })
    const transform = (rule: Parameters<typeof imEffectiveActionFor>[2]) => imEffectiveActionFor('im', 'standard', rule)
    const browserDeps = deps({ transform, config: { actRequiresConfirm: true, remoteActSkipConfirm: false } })
    const browserRead = decide(mkFacts('browser', 'execute', [
      { kind: 'browser-action', action: 'act', dangerous: false, sideEffect: 'read', completeness: 'complete' }
    ], 'low'), context, imRules, browserDeps)
    const browserDanger = decide(mkFacts('browser', 'execute', [
      { kind: 'browser-action', action: 'act', dangerous: true, sideEffect: 'delete', completeness: 'complete' }
    ], 'high'), context, imRules, browserDeps)
    const browserUnclassified = decide(mkFacts('browser', 'execute', [
      { kind: 'browser-action', action: 'act', dangerous: false, sideEffect: 'unknown', completeness: 'partial' }
    ], 'medium'), context, imRules, browserDeps)
    const larkDocWrite = decide(mkFacts('run_lark_cli', 'execute', [
      { kind: 'lark-subcommand', impact: 'low_write', category: 'doc_write', completeness: 'complete' }
    ], 'medium'), mkContext('feishu'), imRules, deps({ transform }))
    const larkSelf = decide(mkFacts('run_lark_cli', 'execute', [
      { kind: 'lark-subcommand', impact: 'low_write', category: 'message', completeness: 'complete', messageTarget: 'self' }
    ], 'medium'), mkContext('feishu'), imRules, deps({ transform }))
    const larkDirect = decide(mkFacts('run_lark_cli', 'execute', [
      { kind: 'lark-subcommand', impact: 'low_write', category: 'message', completeness: 'complete', messageTarget: 'direct-other' }
    ], 'medium'), mkContext('feishu'), imRules, deps({ transform }))
    const larkGroup = decide(mkFacts('run_lark_cli', 'execute', [
      { kind: 'lark-subcommand', impact: 'high_impact', category: 'group_message', completeness: 'complete', messageTarget: 'group-or-multiple' }
    ], 'high'), mkContext('feishu'), imRules, deps({ transform }))
    const larkMessageUnknown = decide(mkFacts('run_lark_cli', 'execute', [
      { kind: 'lark-subcommand', impact: 'low_write', category: 'message', completeness: 'complete', messageTarget: 'unknown' }
    ], 'medium'), mkContext('feishu'), imRules, deps({ transform }))

    expect(browserRead).toMatchObject({ type: 'require-confirm', ruleId: 'im-browser-act-review', answerer: 'agent' })
    expect(browserDanger).toMatchObject({ type: 'require-confirm', ruleId: 'im-browser-act-danger-human', answerer: 'user' })
    expect(browserUnclassified).toMatchObject({ type: 'require-confirm', ruleId: 'browser-act-ask-remote', answerer: 'agent' })
    expect(larkDocWrite).toMatchObject({ type: 'require-confirm', ruleId: 'lark-write-ask', answerer: 'user' })
    expect(larkSelf).toMatchObject({ type: 'require-confirm', ruleId: 'lark-write-ask', answerer: 'user' })
    expect(larkDirect).toMatchObject({ type: 'require-confirm', ruleId: 'lark-write-ask', answerer: 'user' })
    expect(larkGroup).toMatchObject({ type: 'require-confirm', ruleId: 'lark-message-group-human', answerer: 'user' })
    expect(larkMessageUnknown).toMatchObject({ type: 'require-confirm', ruleId: 'lark-message-target-unknown-human', answerer: 'user' })
    const larkUnknown = decide(mkFacts('run_lark_cli', 'execute', [
      { kind: 'lark-subcommand', impact: 'unknown', category: 'unknown', completeness: 'partial' }
    ], 'high'), mkContext('feishu'), imRules, deps({ transform }))
    const larkHigh = decide(mkFacts('run_lark_cli', 'execute', [
      { kind: 'lark-subcommand', impact: 'high_impact', category: 'delete', completeness: 'complete' }
    ], 'high'), mkContext('feishu'), imRules, deps({ transform }))
    expect(larkUnknown).toMatchObject({ type: 'require-confirm', ruleId: 'lark-unknown-ask', answerer: 'user' })
    expect(larkHigh).toMatchObject({ type: 'require-confirm', ruleId: 'lark-high-impact-ask', answerer: 'user' })
  })

  it('preserves explicit browser confirmation bypass settings after IM rules become Agent-review candidates', () => {
    const imRules = resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'standard', rules: DEFAULT_POLICY_RULES })
    const transform = (rule: Parameters<typeof imEffectiveActionFor>[2]) => imEffectiveActionFor('im', 'standard', rule)
    const lowRiskAct = mkFacts('browser', 'execute', [
      { kind: 'browser-action', action: 'act', dangerous: false, sideEffect: 'read', completeness: 'complete' }
    ], 'low')
    const remoteSkip = decide(lowRiskAct, mkContext('wechat'), imRules, deps({
      transform,
      config: { actRequiresConfirm: true, remoteActSkipConfirm: true }
    }))
    expect(remoteSkip).toMatchObject({ type: 'auto-allow', ruleId: 'browser-act-ask-remote' })

    const globalSkip = decide(lowRiskAct, mkContext('wechat'), imRules, deps({
      transform,
      config: { actRequiresConfirm: false, remoteActSkipConfirm: false }
    }))
    expect(globalSkip).toMatchObject({ type: 'auto-allow', ruleId: 'browser-act-allow-unconfigured' })
  })

  it('keeps shared candidate outcomes identical for the same facts in wechat and feishu', () => {
    const candidateRules = [
      { id: 'im-low-risk-create', when: 'invocation' as const, action: 'ask' as const, reason: 'new file' },
      { id: 'browser-navigate-ask-remote', when: 'invocation' as const, action: 'ask' as const, reason: 'navigation' },
      { id: 'im-mcp-public-read-review', when: 'invocation' as const, action: 'ask' as const, reason: 'public search' },
      { id: 'im-time-query-review', when: 'invocation' as const, action: 'ask' as const, reason: 'time' }
    ]
    const facts = mkFacts('write_file', 'write', [], 'low')
    for (const pkg of ['strict', 'standard', 'loose', 'custom'] as const) {
      const rules = resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg, rules: candidateRules })
      const channelResults = (['wechat', 'feishu'] as const).map((lane) => {
        const decision = decide(facts, mkContext(lane), rules, deps())
        return decision.type === 'require-confirm'
          ? [decision.type, decision.ruleId, decision.answerer, decision.disposition]
          : [decision.type, decision.ruleId]
      })
      expect(channelResults[0]).toEqual(channelResults[1])
    }
  })

})

describe('decide：脚本规则作用域不外溢', () => {
  it('桌面 run_shell 携带通用 network-egress 不被脚本规则卷入（按 execute 默认走确认）', () => {
    const d = decide(
      mkFacts('run_shell', 'execute', [{ kind: 'network-egress', domains: ['example.com'] }], 'high'),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('require-confirm')
    expect(d.type === 'deny').toBe(false)
  })

  it('桌面 browser navigate 不因脚本规则出现确认（按 outbound 默认放行）', () => {
    const d = decide(
      mkFacts('browser', 'outbound', [{ kind: 'network-egress', domains: ['example.com'] }], 'low'),
      { ...mkContext('desktop'), policyTier: 'loose' },
      DEFAULT_POLICY_RULES,
      deps({ transform: (rule) => effectiveActionFor('desktop', 'loose', rule) })
    )
    expect(d.type).toBe('auto-allow')
  })
})

describe('decide：desktop「自动」路径（P1：standard 变换 + 快通道 + Agent 兜底）', () => {
  // P1 生效语义：desktop standard 规则集经 LANE_PROFILES 变换后喂给引擎（等价 runtime 装配）
  const desktopStandard = () => resolvePolicyRules({ lane: 'desktop', rules: DEFAULT_POLICY_RULES })
  const standardTransform = (r: { action: PolicyAction; locked?: boolean }) => effectiveActionFor('desktop', 'standard', r)

  it('4.1.1: auto-evaluator fallback selects Agent; explicit and human-required asks stay user-owned', () => {
    const auto = decide(mkFacts('write_file', 'write', []), mkContext('desktop'), [
      { id: 'review-candidate', when: 'invocation', action: 'auto-evaluator', reason: 'review' }
    ], deps())
    const explicit = decide(mkFacts('write_file', 'write', []), mkContext('wechat'), [
      { id: 'explicit-human', when: 'invocation', action: 'ask', reason: 'human' }
    ], deps())
    const floor = decide(mkFacts('write_file', 'write', []), mkContext('feishu'), [
      { id: 'human-floor', when: 'invocation', action: 'ask', humanRequired: true, reason: 'floor' }
    ], deps())
    expect(auto).toMatchObject({ type: 'require-confirm', answerer: 'agent' })
    expect(explicit).toMatchObject({ type: 'require-confirm', answerer: 'user' })
    expect(floor).toMatchObject({ type: 'require-confirm', answerer: 'user' })
  })

  it('IM standard auto-evaluator candidates route to Agent while explicit asks and human floors stay user-owned', () => {
    const imRules = resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'standard', rules: DEFAULT_POLICY_RULES })
    const candidate = decide(mkFacts('toolkit.call', 'execute', [
      { kind: 'toolkit-capability', capabilityId: 'env.time', risk: 'read' }
    ], 'low'), mkContext('feishu'), imRules, deps())
    const explicit = decide(mkFacts('run_lark_cli', 'execute', [{ kind: 'lark-subcommand', impact: 'unknown' }]),
      mkContext('feishu'), [{ id: 'explicit-human', when: 'invocation', action: 'ask', reason: 'human' }], deps())
    const floor = decide(mkFacts('run_script', 'execute', []), mkContext('feishu'), [
      { id: 'human-floor', when: 'invocation', action: 'auto-evaluator', humanRequired: true, reason: 'floor' }
    ], deps())
    expect(candidate).toMatchObject({ type: 'require-confirm', ruleId: 'im-time-query-review', answerer: 'agent', disposition: 'auto-eligible' })
    expect(explicit).toMatchObject({ type: 'require-confirm', ruleId: 'explicit-human', answerer: 'user', disposition: 'human-required' })
    expect(floor).toMatchObject({ type: 'require-confirm', ruleId: 'human-floor', answerer: 'agent', disposition: 'auto-eligible' })
  })

  it('write_file 快通道批准 → 自动放行（default-write-execute-ask 经 transform 变 auto）', () => {
    const d = decide(
      mkFacts('write_file', 'write', [{ kind: 'path-target', path: 'a.txt', zone: 'workdir-normal' }], 'medium'),
      mkContext('desktop'),
      desktopStandard(),
      deps({ transform: standardTransform, autoEvaluator: () => ({ approve: true, reason: '低风险' }) })
    )
    expect(d.type).toBe('auto-allow')
    expect(d.type === 'auto-allow' && d.ruleId).toBe('default-write-execute-ask')
  })

  it('write_file 快通道未裁决 → require-confirm(answerer=agent)，不再交还默认表问人', () => {
    const d = decide(
      mkFacts('write_file', 'write', [{ kind: 'path-target', path: 'a.txt', zone: 'workdir-normal' }], 'medium'),
      mkContext('desktop'),
      desktopStandard(),
      deps({
        transform: standardTransform,
        autoEvaluator: () => ({ approve: false, reason: '文件过大' })
      })
    )
    expect(d.type).toBe('require-confirm')
    if (d.type === 'require-confirm') {
      expect(d.ruleId).toBe('default-write-execute-ask')
      expect(d.answerer).toBe('agent')
    }
  })

  it('mcp-tool 经 standard 变换为 auto-evaluator：评估器批准 → 自动放行（ruleId=mcp-tool-ask）', () => {
    const d = decide(
      mkFacts('mcp_query', 'write', [{ kind: 'mcp-tool', serverId: 'srv', toolName: 'query' }]),
      mkContext('desktop'),
      desktopStandard(),
      deps({
        transform: standardTransform,
        autoEvaluator: (f) =>
          f.toolName === 'mcp_query' ? { approve: true as const, reason: '信任' } : { approve: false as const, reason: 'x' }
      })
    )
    expect(d.type).toBe('auto-allow')
    expect(d.type === 'auto-allow' && d.ruleId).toBe('mcp-tool-ask')
  })

  it('mcp-tool 未裁决 → require-confirm(answerer=agent, ruleId=mcp-tool-ask)', () => {
    const d = decide(
      mkFacts('mcp_query', 'write', [{ kind: 'mcp-tool', serverId: 'srv', toolName: 'query' }]),
      mkContext('desktop'),
      desktopStandard(),
      deps({ transform: standardTransform })
    )
    expect(d.type).toBe('require-confirm')
    if (d.type === 'require-confirm') {
      expect(d.ruleId).toBe('mcp-tool-ask')
      expect(d.answerer).toBe('agent')
    }
  })

  it('persisted IM MCP ask override takes precedence over generic automatic write review', () => {
    const facts = mkFacts('mcp__srv__create', 'write', [
      { kind: 'mcp-tool', serverId: 'srv', toolName: 'create' },
      { kind: 'mcp-invocation', serverId: 'srv', toolName: 'create', actionClass: 'write', completeness: 'complete' }
    ])
    const rules = [
      { id: 'mcp-tool-ask', when: 'invocation' as const, match: { signals: ['mcp-tool'] }, action: 'ask' as const, userOverride: true as const, reason: 'MCP confirmation' },
      { id: 'im-write-ask', when: 'invocation' as const, match: { lane: ['wechat', 'feishu'] as const, actionClass: 'write' as const, excludeSignals: ['write-target-new', 'write-target-existing'] }, action: 'auto-evaluator' as const, reason: 'Generic write review' }
    ]
    const lookup = vi.fn(() => ({ id: 'stale-session-allow', key: { kind: 'mcp-tool', serverId: 'srv', toolName: 'create', sessionId: 's1' },
      decision: 'allow' as const, lane: 'wechat' as const, scope: 'session' as const, createdAt: 1, lastHitAt: 1, hitCount: 1, source: 'user-confirm' as const }))
    const decision = decide(facts, mkContext('wechat'), rules, deps({ cache: { lookup },
      transform: (rule) => rule.id === 'mcp-tool-ask' ? 'ask' : rule.action,
      autoEvaluator: () => ({ approve: true as const, reason: 'generic reviewer approved' })
    }))
    expect(decision).toMatchObject({ type: 'require-confirm', answerer: 'user', ruleId: 'mcp-tool-ask', disposition: 'human-required' })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('legacy default MCP ask remains below a prior explicit session allow cache', () => {
    const lookup = vi.fn((key: import('../confirmation/types').CacheKey) => ({
      id: 'session-mcp-allow', key, decision: 'allow' as const, lane: 'wechat' as const, scope: 'session' as const,
      createdAt: 1, lastHitAt: 1, hitCount: 1, source: 'user-confirm' as const
    }))
    const decision = decide(
      mkFacts('mcp__srv__query', 'read', [{ kind: 'mcp-tool', serverId: 'srv', toolName: 'query' }]),
      mkContext('wechat'),
      [{ id: 'mcp-tool-ask', when: 'invocation', match: { signals: ['mcp-tool'] }, action: 'ask', reason: 'MCP tool call requires confirmation' }],
      deps({ cache: { lookup } })
    )
    expect(decision).toMatchObject({ type: 'auto-allow', ruleId: 'cache-hit' })
    expect(lookup).toHaveBeenCalledOnce()
  })

  it.each([
    ['loose', 'desktop', { type: 'auto-allow', ruleId: 'outbound-mode-loose-allow' }],
    ['standard', 'desktop', { type: 'require-confirm', ruleId: 'outbound-mode-standard-review', answerer: 'agent' }],
    ['strict', 'desktop', { type: 'require-confirm', ruleId: 'outbound-mode-strict-human', answerer: 'user' }],
    ['standard', 'wechat', { type: 'require-confirm', ruleId: 'outbound-mode-standard-review', answerer: 'agent' }],
    ['strict', 'feishu', { type: 'require-confirm', ruleId: 'outbound-mode-strict-human', answerer: 'user' }]
  ] as const)('outbound policy matrix %s/%s selects answerer before confirmation adapter', (tier, lane, expected) => {
    const outboundFacts = mkFacts('send_email', 'outbound', [{ kind: 'network-egress', domains: ['example.test'] }], 'medium')
    const effectiveTier = lane === 'desktop' ? tier : 'standard'
    const result = decide(outboundFacts, { ...mkContext(lane), policyTier: tier }, DEFAULT_POLICY_RULES, deps({ transform: (rule) => effectiveActionFor(lane, effectiveTier, rule) }))
    expect(result).toMatchObject(expected)
  })

  it('existing locked remote outbound deny remains higher priority than the outbound tier table', () => {
    const remoteDeny = { id: 'remote-outbound-deny', when: 'invocation' as const,
      match: { lane: ['wechat'] as const, actionClass: 'outbound' as const }, action: 'deny' as const, locked: true, reason: 'explicit remote deny' }
    const result = decide(mkFacts('wechat_send', 'outbound', []), { ...mkContext('wechat'), policyTier: 'loose' }, [remoteDeny], deps())
    expect(result).toMatchObject({ type: 'deny', ruleId: 'remote-outbound-deny' })
  })

  it.each([
    ['loose', { type: 'require-confirm', ruleId: 'write-outside-loose-review', answerer: 'agent' }],
    ['standard', { type: 'require-confirm', ruleId: 'write-outside-standard-review', answerer: 'agent' }],
    ['strict', { type: 'require-confirm', ruleId: 'write-outside-strict-human', answerer: 'user' }]
  ] as const)('outside-workdir write %s stays distinct from inside write', (tier, expected) => {
    const facts = mkFacts('write_file', 'write', [{ kind: 'write-target-scope', scope: 'outside-workdir' }], 'medium')
    const result = decide(facts, { ...mkContext('desktop'), policyTier: tier }, DEFAULT_POLICY_RULES, deps({ transform: (rule) => effectiveActionFor('desktop', tier, rule) }))
    expect(result).toMatchObject(expected)
  })

  it.each([
    ['loose', { type: 'require-confirm', ruleId: 'outbound-sensitive-loose-review', answerer: 'agent' }],
    ['standard', { type: 'require-confirm', ruleId: 'outbound-sensitive-standard-human', answerer: 'user' }],
    ['strict', { type: 'require-confirm', ruleId: 'outbound-sensitive-strict-human', answerer: 'user' }]
  ] as const)('sensitive outbound %s has an explicit answerer and outranks ordinary outbound', (tier, expected) => {
    const facts = mkFacts('send_message', 'outbound', [
      { kind: 'outbound-content', inspectionCoverage: 'complete', evidenceKinds: ['credential-like-pattern'] }
    ])
    const result = decide(facts, { ...mkContext('desktop'), policyTier: tier }, DEFAULT_POLICY_RULES, deps({ transform: (rule) => effectiveActionFor('desktop', tier, rule) }))
    expect(result).toMatchObject(expected)
  })

  it('incomplete outbound facts remain distinct from sensitive content and enter review', () => {
    const facts = mkFacts('send_message', 'outbound', [
      { kind: 'outbound-content', inspectionCoverage: 'partial', evidenceKinds: [] }
    ])
    expect(decide(facts, { ...mkContext('desktop'), policyTier: 'standard' }, DEFAULT_POLICY_RULES, deps()))
      .toMatchObject({ type: 'require-confirm', ruleId: 'outbound-incomplete-standard-review', answerer: 'agent' })
  })

  it('standard Feishu outbound with missing content is marked unavailable and remains in review', () => {
    const rules = resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'standard', rules: DEFAULT_POLICY_RULES })
    const facts = mkFacts('run_lark_cli', 'outbound', [
      { kind: 'lark-subcommand', impact: 'low_write', category: 'message', completeness: 'complete', messageTarget: 'self' },
      { kind: 'outbound-content', inspectionCoverage: 'unavailable', evidenceKinds: [] },
      { kind: 'policy-tier', tier: 'standard' }
    ])
    const result = decide(facts, { ...mkContext('feishu'), policyTier: 'standard' }, rules,
      deps({ transform: (rule) => effectiveActionFor('feishu', 'standard', rule) }))
    expect(result).toMatchObject({ type: 'require-confirm', ruleId: 'outbound-incomplete-standard-review', answerer: 'agent' })
  })

  it('sensitive outbound in standard IM requires human approval through an explicit policy rule', () => {
    const facts = mkFacts('wechat_send', 'outbound', [
      { kind: 'outbound-content', inspectionCoverage: 'complete', evidenceKinds: ['credential-like-pattern'] }
    ])
    const result = decide(facts, { ...mkContext('wechat'), policyTier: 'standard' }, DEFAULT_POLICY_RULES,
      deps({ transform: (rule) => effectiveActionFor('wechat', 'standard', rule) }))
    expect(result).toMatchObject({ type: 'require-confirm', ruleId: 'outbound-sensitive-standard-human', answerer: 'user' })
  })

  it('sensitive WeChat attachment evidence participates in the standard outbound policy', () => {
    const facts = mkFacts('wechat_send', 'outbound', [
      { kind: 'wechat-media-content-assessment', factId: 'fact-1', contentDigest: 'a'.repeat(64), extractorVersion: 'host-v1',
        inspectionCoverage: 'complete', evidenceKinds: ['credential-like-pattern'] }
    ])
    const result = decide(facts, { ...mkContext('wechat'), policyTier: 'standard' }, DEFAULT_POLICY_RULES,
      deps({ transform: (rule) => effectiveActionFor('wechat', 'standard', rule) }))
    expect(result).toMatchObject({ type: 'require-confirm', ruleId: 'outbound-sensitive-standard-human', answerer: 'user' })
  })

  it('ordinary outbound in standard IM is assigned to the policy-selected Agent reviewer', () => {
    const facts = mkFacts('wechat_reply', 'outbound', [])
    const result = decide(facts, { ...mkContext('wechat'), policyTier: 'standard' }, DEFAULT_POLICY_RULES,
      deps({ transform: (rule) => effectiveActionFor('wechat', 'standard', rule) }))
    expect(result).toMatchObject({ type: 'require-confirm', ruleId: 'outbound-mode-standard-review', answerer: 'agent' })
  })

  it('read_file 不被评估器截胡（默认放行）', () => {
    const d = decide(
      mkFacts('read_file', 'read', [], 'low'),
      mkContext('desktop'),
      desktopStandard(),
      deps({
        transform: standardTransform,
        autoEvaluator: () => ({ approve: true, reason: '不该被调用' })
      })
    )
    expect(d.type).toBe('auto-allow')
    expect(d.type === 'auto-allow' && d.ruleId).toBe('default-read-outbound-allow')
  })

  it('桌面 clean 脚本仍免确认（评估器不拦截 run_script）', () => {
    const d = decide(
      mkFacts('run_script', 'execute', [{ kind: 'script-analysis', signal: 'clean', patterns: [] }], 'high'),
      mkContext('desktop'),
      desktopStandard(),
      deps({
        transform: standardTransform,
        autoEvaluator: () => ({ approve: true, reason: '不该被调用' })
      })
    )
    expect(d.type).toBe('auto-allow')
    expect(d.type === 'auto-allow' && d.ruleId).toBe('script-clean-allow-desktop')
  })

  it('首条 auto 条目未裁决时继续评估后续条目（M3 级联），批准落在后续条目', () => {
    const rules = [
      {
        id: 'auto-1',
        when: 'invocation',
        match: { lane: ['desktop'], toolName: ['write_file'] },
        action: 'auto-evaluator',
        reason: 'r1'
      },
      {
        id: 'auto-2',
        when: 'invocation',
        match: { lane: ['desktop'], toolName: ['write_file'] },
        action: 'auto-evaluator',
        reason: 'r2'
      }
    ]
    let calls = 0
    const d = decide(
      mkFacts('write_file', 'write', [], 'medium'),
      mkContext('desktop'),
      rules,
      deps({
        autoEvaluator: () => {
          calls++
          return calls === 1 ? { approve: false, reason: '信息不足' } : { approve: true, reason: '低风险' }
        }
      })
    )
    expect(calls).toBe(2)
    expect(d.type === 'auto-allow' && d.ruleId).toBe('auto-2')
  })

  it('全部 auto 条目均未裁决 → require-confirm(answerer=agent, 末次命中条目 id)', () => {
    const rules = [
      {
        id: 'auto-1',
        when: 'invocation',
        match: { lane: ['desktop'], toolName: ['write_file'] },
        action: 'auto-evaluator',
        reason: 'r1'
      },
      {
        id: 'auto-2',
        when: 'invocation',
        match: { lane: ['desktop'], toolName: ['write_file'] },
        action: 'auto-evaluator',
        reason: 'r2'
      }
    ]
    const d = decide(
      mkFacts('write_file', 'write', [], 'medium'),
      mkContext('desktop'),
      rules,
      deps({ autoEvaluator: () => ({ approve: false, reason: '未裁决' }) })
    )
    expect(d.type).toBe('require-confirm')
    if (d.type === 'require-confirm') {
      expect(d.ruleId).toBe('auto-2')
      expect(d.answerer).toBe('agent')
    }
  })
})

describe('decide：远程写会话信任（decision_cache remote-write）', () => {
  it('无会话写信任 → 远程写默认回落到确认（im-write-ask）', () => {
    const d = decide(
      mkFacts('write_file', 'write', [], 'medium'),
      mkContext('wechat'),
      DEFAULT_POLICY_RULES,
      deps({ config: {}, migrationComplete: true })
    )
    expect(d.type).toBe('require-confirm')
    if (d.type === 'require-confirm') expect(d.ruleId).toBe('im-write-ask')
  })

  it('新版 IM 标准将普通未分类写入交审核 Agent，敏感路径仍由 humanRequired 底线拦截', () => {
    const standardRules = resolveImPolicyRulesForVersion({
      policyBehaviorVersion: 'im-standard-v2', pkg: 'standard', rules: DEFAULT_POLICY_RULES
    })
    const transform = (candidate: Parameters<typeof imEffectiveActionFor>[2]) => imEffectiveActionFor('im', 'standard', candidate)
    const ordinary = decide(mkFacts('write_file', 'write', []), mkContext('wechat'), standardRules,
      deps({ transform, autoEvaluator: () => ({ approve: false, reason: 'needs review' }) }))
    expect(ordinary).toMatchObject({ type: 'require-confirm', ruleId: 'im-write-ask', answerer: 'agent', disposition: 'auto-eligible' })

    const sensitive = decide(mkFacts('write_file', 'write', [
      { kind: 'path-target', path: '.env', zone: 'sensitive-file' }
    ]), mkContext('wechat'), standardRules,
      deps({ transform, autoEvaluator: () => ({ approve: true }) }))
    expect(sensitive).toMatchObject({ type: 'require-confirm', ruleId: 'im-write-sensitive-path-confirm', answerer: 'user' })
  })

  it('用户选择的本会话远程写信任可复用于同会话调用', () => {
    const cache: DecisionCacheView = {
      lookup: () => ({
        id: 'rw',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        key: { kind: 'remote-write', sessionId: 's1' } as any,
        decision: 'allow',
        lane: 'wechat',
        scope: 'session',
        createdAt: 1,
        lastHitAt: 1,
        hitCount: 1,
        source: 'user-confirm'
      })
    }
    const d = decide(
      mkFacts('write_file', 'write', [], 'medium'),
      mkContext('wechat'),
      DEFAULT_POLICY_RULES,
      deps({ cache })
    )
    expect(d).toMatchObject({ type: 'auto-allow', ruleId: 'cache-hit' })
  })

  it('非远程链路（桌面）不消费 remote-write 会话信任，写文件走确认', () => {
    const d = decide(
      mkFacts('write_file', 'write', [], 'medium'),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('require-confirm')
  })
})

describe('decide：安全不变量（硬约束先于缓存）+ 默认兜底', () => {
  it('危险脚本信号由显式规则在缓存查询前拒绝', () => {
    const d = decide(
      mkFacts('run_script', 'execute', [
        { kind: 'script-analysis', signal: 'dangerous', patterns: ['rm -rf'] }
      ], 'high'),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps({ cache: cacheWith('allow') })
    )
    expect(d).toMatchObject({ type: 'deny', ruleId: 'script-dangerous-deny' })
  })

  it('没有危险脚本规则时不保留隐藏的危险信号终局拒绝', () => {
    const rules = DEFAULT_POLICY_RULES.filter((rule) => rule.id !== 'script-dangerous-deny')
    const d = decide(
      mkFacts('run_script', 'execute', [
        { kind: 'script-analysis', signal: 'dangerous', patterns: ['rm -rf'] }
      ], 'high'),
      mkContext('desktop'), rules, deps({ cache: cacheWith('allow') })
    )
    expect(d).toMatchObject({ type: 'require-confirm', ruleId: 'default-write-execute-ask' })
  })

  it('未受信来源的 declared capability 不绕过正常策略规则', () => {
    const context = { ...mkContext('desktop'), declaredCapabilities: [{ actionClass: 'execute', scope: '*' }] } as ExecutionContext
    const d = decide(mkFacts('run_script', 'execute', [], 'medium'), context, DEFAULT_POLICY_RULES, deps())
    expect(d).toMatchObject({ type: 'require-confirm', ruleId: 'default-write-execute-ask' })
  })

  it('deniedTools 配置命中的工具被硬拒绝（第 1 步）', () => {
    const d = decide(
      mkFacts('wechat_send', 'outbound', [], 'medium'),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps({ config: { deniedTools: ['wechat_send'] } })
    )
    expect(d.type).toBe('deny')
  })
})

describe('decide：extraction-failed 一律问用户', () => {
  it('即使 read 工具，提取失败也走确认', () => {
    const d = decide(
      mkFacts('read_file', 'read', [{ kind: 'extraction-failed', reason: '无法解析' }], 'low'),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('require-confirm')
  })
})

describe('decideIngress：消息入口准入', () => {
  it('飞书群聊默认拒绝', () => {
    const r = decideIngress({ lane: 'feishu', origin: { kind: 'group' } }, DEFAULT_POLICY_RULES)
    expect(r.action).toBe('deny')
    expect(r.ruleId).toBe('ingress-feishu-group-deny')
  })

  it('白名单内单聊（direct-owner）默认放行', () => {
    const r = decideIngress({ lane: 'wechat', origin: { kind: 'direct-owner', senderId: 'u1' } }, DEFAULT_POLICY_RULES)
    expect(r.action).toBe('allow')
  })

  it('deny ingress 约束优先于 allow，且不依赖规则数组顺序', () => {
    const rules = [
      { id: 'allow-any', when: 'ingress', match: { lane: ['feishu'] }, action: 'allow', reason: 'r' },
      { id: 'deny-group', when: 'ingress', match: { lane: ['feishu'], origin: 'group' }, action: 'deny', reason: 'r' }
    ]
    const r = decideIngress({ lane: 'feishu', origin: { kind: 'group' } }, rules)
    expect(r.ruleId).toBe('deny-group')
    expect(r.action).toBe('deny')
    expect(decideIngress({ lane: 'feishu', origin: { kind: 'group' } }, [...rules].reverse())).toMatchObject({ action: 'deny', ruleId: 'deny-group' })
  })
})

describe('buildMemoryTiers：run_script 记忆封顶（§5.3）', () => {
  it('携带 script-network 信号的调用强制"仅此一次"，不开放记忆档位', () => {
    const facts = mkFacts('run_script', 'execute', [
      { kind: 'script-analysis', signal: 'clean', patterns: [] },
      { kind: 'script-network', patterns: ['https://example.com'] },
      // 同时携带可派生缓存键的 path-target 信号：封顶必须压过它，"记住路径"不得绕过网络确认
      { kind: 'path-target', path: 'out/report.txt', zone: 'workdir-normal' }
    ], 'high')
    expect(buildMemoryTiers(facts)).toEqual([])
  })

  it('携带 script-uncertified 信号的调用强制"仅此一次"，不开放记忆档位', () => {
    const facts = mkFacts('run_script', 'execute', [
      { kind: 'script-analysis', signal: 'clean', patterns: [] },
      { kind: 'script-uncertified' },
      { kind: 'path-target', path: 'out/report.txt', zone: 'workdir-normal' }
    ], 'high')
    expect(buildMemoryTiers(facts)).toEqual([])
  })

  it('普通脚本（无网络/未认证信号）不受影响', () => {
    const facts = mkFacts('run_shell', 'execute', [
      {
        kind: 'command-sequence',
        commands: [{ verb: 'ls', signature: 'ls', args: [] }],
        persistable: true
      }
    ], 'high')
    expect(buildMemoryTiers(facts).length).toBeGreaterThan(0)
  })
})

describe('buildMemoryTiers：远程链路不开放持久档（B4）', () => {
  it('远程 outbound navigate 不提供记忆档位', () => {
    const facts = mkFacts('browser', 'outbound', [
      { kind: 'network-egress', domains: ['example.com'], via: 'browser-navigate' }
    ], 'medium')
    const tiers = buildMemoryTiers(facts, 's1', 'feishu')
    // IM outbound is never remembered (memoryEligibility); this is stricter than
    // the general remote-session-only rule exercised by remote file writes below.
    expect(tiers).toEqual([])
  })

  it('桌面链路仍开放持久档（行为不回退）', () => {
    const facts = mkFacts('browser', 'outbound', [
      { kind: 'network-egress', domains: ['example.com'], via: 'browser-navigate' }
    ], 'medium')
    const tiers = buildMemoryTiers(facts, 's1', 'desktop')
    expect(tiers.some((t) => !('sessionId' in t.key))).toBe(true)
  })

  it('远程链路写文件只保留 remote-write 会话档，path 持久档不开放', () => {
    const facts = mkFacts('write_file', 'write', [
      { kind: 'path-target', path: 'a.txt', zone: 'workdir-normal' }
    ], 'medium')
    const tiers = buildMemoryTiers(facts, 's1', 'wechat')
    expect(tiers.every((t) => 'sessionId' in t.key && t.key.sessionId)).toBe(true)
    expect(tiers.some((t) => t.key.kind === 'remote-write')).toBe(true)
  })
})

describe('deriveCacheKeys/buildMemoryTiers：sensitive-file zone 不派生键（B4）', () => {
  it('敏感文件路径不开放记忆档位', () => {
    const facts = mkFacts('write_file', 'write', [
      { kind: 'path-target', path: '.env', zone: 'sensitive-file' }
    ], 'high')
    expect(buildMemoryTiers(facts, 's1', 'desktop')).toEqual([])
  })

  it('敏感文件路径不消费已有缓存键（lookup 不派生键）', () => {
    const facts = mkFacts('write_file', 'write', [
      { kind: 'path-target', path: '.env', zone: 'sensitive-file' }
    ], 'high')
    const d = decide(facts, mkContext('desktop'), DEFAULT_POLICY_RULES, deps({ cache: cacheWith('allow') }))
    expect(d.type).not.toBe('auto-allow')
  })

  it('普通 workdir 路径仍派生记忆档位', () => {
    const facts = mkFacts('write_file', 'write', [
      { kind: 'path-target', path: 'out/a.txt', zone: 'workdir-normal' }
    ], 'medium')
    expect(buildMemoryTiers(facts, 's1', 'desktop').length).toBeGreaterThan(0)
  })

  it.each(['outside-workdir', 'system-dir'] as const)('%s 路径风险不消费已有缓存键', (zone) => {
    const facts = mkFacts('write_file', 'write', [
      { kind: 'path-target', path: '/risk', zone }
    ], 'high')
    const d = decide(facts, mkContext('desktop'), DEFAULT_POLICY_RULES, deps({ cache: cacheWith('allow') }))
    expect(d.type).not.toBe('auto-allow')
  })
})

describe('mcp-readonly-allow：只读注解放行不收编远程链路（B5）', () => {
  const mcpReadonlySignals: ContentFacts['signals'] = [
    { kind: 'mcp-tool', serverId: 'srv', toolName: 'query' },
    { kind: 'mcp-readonly', serverId: 'srv', toolName: 'query' }
  ]

  it('桌面：只读 allow 与通用 MCP ask 同时命中时 ask 优先', () => {
    const d = decide(
      mkFacts('mcp__srv__query', 'read', mcpReadonlySignals, 'medium'),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d).toMatchObject({ type: 'require-confirm', ruleId: 'mcp-tool-ask', answerer: 'user' })
  })

  it('远程链路：server 自我声明的只读注解不免确认（不可信输入不得静默执行）', () => {
    for (const lane of ['wechat', 'feishu'] as const) {
      const d = decide(
        mkFacts('mcp__srv__query', 'read', mcpReadonlySignals, 'medium'),
        mkContext(lane),
        DEFAULT_POLICY_RULES,
        deps()
      )
      expect(d.type).toBe('require-confirm')
      expect(d.type === 'require-confirm' && d.ruleId).toBe('mcp-tool-ask')
    }
  })

  it('IM standard 将其他 MCP 调用默认交给审核 Agent，拒绝规则仍优先', () => {
    const imStandard = (rule: Parameters<typeof imEffectiveActionFor>[2]) => imEffectiveActionFor('im', 'standard', rule)
    const unknownMcp = mkFacts('mcp__srv__fetch', 'write', [
      { kind: 'mcp-tool', serverId: 'srv', toolName: 'fetch' }
    ])
    for (const lane of ['wechat', 'feishu'] as const) {
      expect(decide(unknownMcp, mkContext(lane), DEFAULT_POLICY_RULES, deps({ transform: imStandard })))
        .toMatchObject({ type: 'require-confirm', ruleId: 'mcp-tool-ask', answerer: 'agent' })
      const unauthorized = decide(mkFacts('mcp__srv__fetch', 'write', [
        { kind: 'mcp-tool', serverId: 'srv', toolName: 'fetch' },
        { kind: 'mcp-invocation', serverId: 'srv', toolName: 'fetch', actionClass: 'write',
          classificationBasis: 'schema-heuristic', sideEffect: 'read', dataSources: [], dataDestinations: [],
          querySource: 'public', accountAuthorization: 'unauthorized', completeness: 'complete', missingFacts: [],
          argNames: ['url'], argsDigest: 'digest', argsTruncated: false }
      ]), mkContext(lane), DEFAULT_POLICY_RULES, deps({ transform: imStandard }))
      expect(unauthorized).toMatchObject({ type: 'deny', ruleId: 'mcp-account-unauthorized-deny' })
    }
  })

  it('远程只把带齐主进程来源与授权事实的只读 MCP 调用交给 standard 审核 Agent', () => {
    const trustedFacts = mkFacts('mcp__srv__search', 'read', [
      { kind: 'mcp-tool', serverId: 'srv', toolName: 'search' },
      { kind: 'mcp-readonly', serverId: 'srv', toolName: 'search' },
      {
        kind: 'mcp-invocation', serverId: 'srv', toolName: 'search', actionClass: 'read',
        classificationBasis: 'annotations-readonly', sideEffect: 'read', dataSources: [], dataDestinations: [],
        queryText: 'public documentation', querySource: 'public', accountAuthorization: 'authorized',
        completeness: 'complete', missingFacts: [], argNames: ['query'], argsDigest: 'digest', argsTruncated: false
      }
    ])
    const imStandard = (rule: Parameters<typeof imEffectiveActionFor>[2]) => imEffectiveActionFor('im', 'standard', rule)
    for (const lane of ['wechat', 'feishu'] as const) {
      expect(decide(trustedFacts, mkContext(lane), DEFAULT_POLICY_RULES, deps({ transform: imStandard })))
        .toMatchObject({ type: 'require-confirm', ruleId: 'im-mcp-public-read-review', answerer: 'agent' })
    }
  })

  it('automation lane：MCP 只读注解仍交由 agent 回答者审批', () => {
    const d = decide(
      mkFacts('mcp__srv__query', 'read', mcpReadonlySignals, 'medium'),
      mkContext('automation'),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('require-confirm')
    expect(d.type === 'require-confirm' && d.ruleId).toBe('mcp-tool-ask')
    expect(d.type === 'require-confirm' && d.answerer).toBe('agent')
  })
})

describe('confirm-every-time', () => {
  it('命中的普通 deny 规则优先于既有 allow 缓存', () => {
    const rule = {
      id: 'user-deny', when: 'invocation' as const, match: { toolName: 'mcp__srv__query' },
      action: 'deny' as const, reason: '用户拒绝'
    }
    const d = decide(mkFacts('mcp__srv__query', 'read', [{ kind: 'mcp-tool', serverId: 'srv', toolName: 'query' }]), mkContext('desktop'), [rule], deps({ cache: cacheWith('allow') }))
    expect(d).toMatchObject({ type: 'deny', ruleId: 'user-deny' })
  })

  it('locked rule wins over an existing allow cache', () => {
    const rule = {
      id: 'shell-confirm-every-time',
      when: 'invocation' as const,
      match: { toolName: 'run_shell' },
      action: 'confirm-every-time' as const,
      locked: true,
      reason: '每次执行都需要确认'
    }
    const facts = mkFacts('run_shell', 'execute', [
      { kind: 'command-sequence', commands: [{ verb: 'echo', args: [], signature: 'echo' }], persistable: true }
    ])
    const d = decide(facts, mkContext('desktop'), [rule], deps({ cache: cacheWith('allow') }))
    expect(d.type).toBe('require-confirm')
    expect(d.type === 'require-confirm' && d.ruleId).toBe('shell-confirm-every-time')
    expect(d.type === 'require-confirm' && d.memoryTiers).toEqual([])
  })

  it('统一推导 invocation 级 memory constraints，partial facts 不读/展示/写入记忆', () => {
    const facts = mkFacts('run_shell', 'execute', [{ kind: 'extraction-failed', reason: 'partial' }])
    const constraints = deriveInvocationPolicyConstraints(facts, mkContext('desktop'), [], deps())
    expect(constraints).toEqual({
      memory: { canRead: false, canOffer: false, canWrite: false, reason: 'analysis-incomplete' }
    })
    expect(buildMemoryTiers(facts, 's1', 'desktop', constraints)).toEqual([])
  })
})

describe('profile/dialect exact signature migration', () => {
  it('旧的无 namespace exact cache 不得命中新 namespace signature', () => {
    const facts = mkFacts('run_shell', 'execute', [{
      kind: 'command-sequence',
      commands: [{ verb: 'echo', args: ['ok'], signature: 'echo ok', profileNamespace: 'builtin-macos-bash:posix-bash' }],
      persistable: true
    }])
    const cache: DecisionCacheView = {
      lookup: (key) => key.kind === 'shell-command' && key.verb === 'echo ok'
        ? { id: 'legacy', key, decision: 'allow', lane: '*', scope: 'persistent', createdAt: 1, lastHitAt: 1, hitCount: 1, source: 'migration' }
        : null
    }
    const decision = decide(facts, mkContext('desktop'), DEFAULT_POLICY_RULES, deps({ cache }))
    expect(decision.type).toBe('require-confirm')
  })
})

describe('shell signal tokens', () => {
  it('preserves the real connector for policy matching', () => {
    const tokens = signalTokenSet(mkFacts('run_shell', 'execute', [{
      kind: 'command-sequence',
      commands: [{ verb: 'echo', args: [], connector: '&&' }]
    }]))
    expect(tokens).toContain('shell-connector:&&')
  })

  it('maps host-matched scheduled task tool permissions into policy tokens', () => {
    const tokens = signalTokenSet(mkFacts('grep', 'read', [
      { kind: 'automation-grep-permission', status: 'missing' },
      { kind: 'grep-invocation', path: '/workspace/src', pattern: 'TODO' }
    ]))
    expect(tokens).toContain('automation-grep-permission:missing')
    expect(tokens).toContain('grep-invocation')
    expect(signalTokenSet(mkFacts('run_script', 'execute', [{ kind: 'automation-script-permission', status: 'matched' }]))).toContain('automation-script-permission:matched')
  })
})

describe('decide：回答者派生（P0 §2.2，动作决定回答者）', () => {
  it('desktop 第 5 步 ask → answerer=user（mcp-tool 默认确认）', () => {
    const d = decide(
      mkFacts('mcp_query', 'write', [{ kind: 'mcp-tool', serverId: 'srv', toolName: 'query' }]),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('require-confirm')
    expect(d.type === 'require-confirm' && d.ruleId).toBe('mcp-tool-ask')
    expect(d.type === 'require-confirm' && d.answerer).toBe('user')
  })

  it('wechat 第 5 步 ask → answerer=user（零行为变化硬回归）', () => {
    const d = decide(
      mkFacts('mcp_query', 'write', [{ kind: 'mcp-tool', serverId: 'srv', toolName: 'query' }]),
      mkContext('wechat'),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type === 'require-confirm' && d.answerer).toBe('user')
  })

  it('automation locked ask（automation-default-confirm）→ answerer=agent（等价 P2-6 现状）', () => {
    const d = decide(
      mkFacts('some_new_tool', 'write', []),
      mkContext('automation'),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('require-confirm')
    expect(d.type === 'require-confirm' && d.ruleId).toBe('automation-default-confirm')
    expect(d.type === 'require-confirm' && d.answerer).toBe('agent')
  })

  it('extraction-failed 兜底 → 恒落人工 answerer=user（M3 不变换例外）', () => {
    const d = decide(
      mkFacts('write_file', 'write', [{ kind: 'extraction-failed', reason: '无法解析' }]),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('require-confirm')
    expect(d.type === 'require-confirm' && d.ruleId).toBe('default-extraction-failed')
    expect(d.type === 'require-confirm' && d.answerer).toBe('user')
  })

  it('locked confirm-every-time → answerer=user（决策 3：始终人工逐次确认）', () => {
    const rule = { id: 'always-confirm', when: 'invocation' as const, match: { toolName: 'run_shell' }, action: 'confirm-every-time' as const, locked: true, reason: '逐次确认' }
    const d = decide(
      mkFacts('run_shell', 'execute', []),
      mkContext('desktop'),
      [rule],
      deps()
    )
    expect(d.type).toBe('require-confirm')
    expect(d.type === 'require-confirm' && d.answerer).toBe('user')
  })

  it('deps.transform 缺省恒等：default-write-execute-ask 仍落人工（desktop 生效前零行为变化）', () => {
    const d = decide(
      mkFacts('brand_new_tool', 'write', []),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps()
    )
    expect(d.type).toBe('require-confirm')
    expect(d.type === 'require-confirm' && d.ruleId).toBe('default-write-execute-ask')
    expect(d.type === 'require-confirm' && d.answerer).toBe('user')
  })

  it('deps.transform 提供（desktop standard 语义）：合成兜底 ask→auto-evaluator，快通道放行', () => {
    const d = decide(
      mkFacts('brand_new_tool', 'write', []),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps({
        transform: () => 'auto-evaluator',
        autoEvaluator: () => ({ approve: true, reason: '文件大小快通道' })
      })
    )
    expect(d.type).toBe('auto-allow')
    expect(d.type === 'auto-allow' && d.ruleId).toBe('default-write-execute-ask')
  })

  it('deps.transform 提供：快通道未裁决 → require-confirm(answerer=agent)', () => {
    const d = decide(
      mkFacts('brand_new_tool', 'write', []),
      mkContext('desktop'),
      DEFAULT_POLICY_RULES,
      deps({
        transform: () => 'auto-evaluator'
      })
    )
    expect(d.type).toBe('require-confirm')
    expect(d.type === 'require-confirm' && d.ruleId).toBe('default-write-execute-ask')
    expect(d.type === 'require-confirm' && d.answerer).toBe('agent')
  })
})

describe('automation 结果输出绑定策略', () => {
  it('仅主机给出的精确输出绑定信号命中放行规则，其他写入继续命中 locked deny', () => {
    const bound = decide(
      mkFacts('write_file', 'write', [{ kind: 'automation-output-binding', status: 'matched' } as never]),
      mkContext('automation'), DEFAULT_POLICY_RULES, deps()
    )
    const unbound = decide(mkFacts('write_file', 'write', []), mkContext('automation'), DEFAULT_POLICY_RULES, deps())

    expect(bound).toMatchObject({ type: 'auto-allow', ruleId: 'automation-bound-output-write-allow' })
    expect(unbound).toMatchObject({ type: 'deny', ruleId: 'automation-write-deny' })
  })

  it('输出目录不是授权读取根，automation 读取目录外目标时终局拒绝', () => {
    const decision = decide(
      mkFacts('read_file', 'read', [{ kind: 'path-target', path: '/results/20261018/report.txt', zone: 'outside-workdir' }]),
      mkContext('automation'), DEFAULT_POLICY_RULES, deps()
    )
    expect(decision).toMatchObject({ type: 'deny', ruleId: 'remote-outside-read-deny' })
  })
})

describe('desktop loose 语义锚定（评审低项明示）', () => {
  it('desktop loose：未过预检的 run_shell → 快通道(auto-evaluator 保持)→ 审批 Agent 裁决（非人工）', () => {
    const rules = resolvePolicyRules({ lane: 'desktop', packages: { desktop: 'loose' }, rules: DEFAULT_POLICY_RULES })
    // loose 下 ask→allow、auto-evaluator 保持：shell-precheck-auto-allow 仍为快通道
    expect(rules.find((r) => r.id === 'shell-precheck-auto-allow')?.action).toBe('auto-evaluator')
    const d = decide(
      mkFacts('run_shell', 'execute', [{ kind: 'command-sequence', commands: [{ verb: 'curl', args: ['x'] }] }]),
      mkContext('desktop'),
      rules,
      deps({ autoEvaluator: () => ({ approve: false, reason: '预检未放行' }) })
    )
    // 预检未过 → 交审批 Agent（决策 1：loose 由用户显式选择，回答者口径随之）
    expect(d.type).toBe('require-confirm')
    if (d.type === 'require-confirm') expect(d.answerer).toBe('agent')
  })
})
