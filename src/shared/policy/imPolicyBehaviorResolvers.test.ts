import { describe, expect, it } from 'vitest'
import { resolveImPolicyRulesForVersion } from './policyPackages'
import { DEFAULT_POLICY_RULES } from './defaultRules'
import { decide } from './policyEngine'
import { resolveImPolicyFloorForVersion } from './policyFloor'

const rules = [
  { id: 'im-low-risk-create', when: 'invocation' as const, action: 'ask' as const, reason: 'new file', match: { lane: ['wechat', 'feishu'], toolName: 'write_file', signals: ['write-target-new', 'write-target-scope:inside-workdir', 'path-target:workdir-normal'] } },
  { id: 'im-low-risk-edit', when: 'invocation' as const, action: 'ask' as const, reason: 'edit file' },
  { id: 'im-write-ask', when: 'invocation' as const, action: 'ask' as const, reason: 'other IM writes' },
  { id: 'browser-navigate-ask-remote', when: 'invocation' as const, action: 'ask' as const, reason: 'navigation' },
  { id: 'im-mcp-public-read-review', when: 'invocation' as const, action: 'ask' as const, reason: 'public search' },
  { id: 'im-time-query-review', when: 'invocation' as const, action: 'ask' as const, reason: 'time' },
  { id: 'script-clean-certified-remote', when: 'invocation' as const, action: 'ask' as const, reason: 'certified clean script' },
  { id: 'script-dynamic-execution-confirm', when: 'invocation' as const, action: 'confirm-every-time' as const, locked: true, reason: 'dynamic script floor' },
  { id: 'browser-act-ask-remote', when: 'invocation' as const, action: 'ask' as const, reason: 'ordinary remote browser act', match: { lane: ['wechat', 'feishu'], toolName: 'browser', signals: ['browser-act'], excludeSignals: ['browser-act-dangerous'] } },
  { id: 'im-browser-act-danger-human', when: 'invocation' as const, action: 'ask' as const, locked: true, humanRequired: true, reason: 'dangerous IM browser action' },
  { id: 'im-browser-act-review', when: 'invocation' as const, action: 'ask' as const, reason: 'low-risk browser action' },
  { id: 'lark-write-ask', when: 'invocation' as const, action: 'ask' as const, reason: 'classified low-impact Feishu write' },
  { id: 'im-lark-low-write-review', when: 'invocation' as const, action: 'ask' as const, reason: 'classified ordinary Feishu write' },
  { id: 'lark-high-impact-ask', when: 'invocation' as const, action: 'ask' as const, locked: true, reason: 'high-impact Feishu write' },
  { id: 'lark-unknown-ask', when: 'invocation' as const, action: 'ask' as const, locked: true, reason: 'unknown Feishu command' },
  { id: 'im-lark-message-self-review', when: 'invocation' as const, action: 'ask' as const, reason: 'self message' },
  { id: 'im-lark-message-direct-review', when: 'invocation' as const, action: 'ask' as const, reason: 'direct message' },
  { id: 'lark-message-group-human', when: 'invocation' as const, action: 'ask' as const, locked: true, reason: 'group message' },
  { id: 'lark-message-target-unknown-human', when: 'invocation' as const, action: 'ask' as const, locked: true, reason: 'unknown recipient' },
  { id: 'browser-act-danger-ask', when: 'invocation' as const, action: 'ask' as const, reason: 'dangerous browser action' },
  { id: 'path-sensitive-read-confirm', when: 'invocation' as const, action: 'confirm-every-time' as const, locked: true, reason: 'sensitive path' },
  { id: 'remote-deny-lark-write-outbound', when: 'invocation' as const, action: 'deny' as const, locked: true, reason: 'outbound disabled' },
  { id: 'mcp-tool-ask', when: 'invocation' as const, action: 'ask' as const, reason: 'non-candidate' },
  { id: 'hard-deny', when: 'invocation' as const, action: 'deny' as const, locked: true, reason: 'floor' }
]

describe('version-pinned IM behavior candidates', () => {
  it('keeps v3-only locked rules out of frozen v1.6 and v2 rule sets and floors', () => {
    const v3OnlyIds = [
      'im-outside-write-review-materials-incomplete-deny', 'im-shell-review-materials-incomplete-deny',
      'im-script-review-materials-incomplete-deny', 'im-wechat-attachment-review-materials-incomplete-deny',
      'remote-wechat-media-sensitive-file-outside-deny', 'remote-wechat-media-system-dir-outside-deny'
    ]
    for (const version of ['im-v1.6', 'im-standard-v2'] as const) {
      const resolved = resolveImPolicyRulesForVersion({ policyBehaviorVersion: version, pkg: 'standard', rules: DEFAULT_POLICY_RULES })
      const floor = resolveImPolicyFloorForVersion(version, 'standard')
      expect(resolved.some((rule) => v3OnlyIds.includes(rule.id))).toBe(false)
      expect(floor.some((rule) => v3OnlyIds.includes(rule.id))).toBe(false)
    }
    const v3 = resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v3', pkg: 'standard', rules: DEFAULT_POLICY_RULES })
    expect(v3OnlyIds.every((id) => v3.some((rule) => rule.id === id && rule.locked && rule.action === 'deny'))).toBe(true)
    expect(v3OnlyIds.every((id) => resolveImPolicyFloorForVersion('im-standard-v3', 'standard').some((rule) => rule.id === id))).toBe(true)

    const legacyOverride = DEFAULT_POLICY_RULES.map((rule) => rule.id === 'remote-wechat-media-outside-deny' ? { ...rule, action: 'allow' as const } : rule)
    const legacy = resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-v1.6', pkg: 'custom', rules: legacyOverride })
    expect(legacy.find((rule) => rule.id === 'remote-wechat-media-outside-deny')?.action).toBe('allow')
    expect(legacy.some((rule) => v3OnlyIds.includes(rule.id))).toBe(false)
    const sensitiveAttachment = decide({ toolName: 'wechat_reply', actionClass: 'outbound', baseRiskLevel: 'medium',
      signals: [{ kind: 'wechat-media-target', boundary: 'outside-workdir', zone: 'sensitive-file', targetKind: 'file' }],
      summary: { text: 'legacy reviewed attachment' } },
    { lane: 'wechat', origin: { kind: 'direct-owner' }, sessionId: 'legacy-sensitive-override', policyTier: 'custom' },
    [legacy.find((rule) => rule.id === 'remote-wechat-media-outside-deny')!],
    { cache: { lookup: () => null }, config: {}, migrationComplete: false })
    expect(sensitiveAttachment).toMatchObject({ type: 'auto-allow', ruleId: 'remote-wechat-media-outside-deny' })
  })

  it.each(['strict', 'loose', 'custom'] as const)('keeps v3 file and Git policy unchanged for %s package', (pkg) => {
    const samples = [
      { toolName: 'read_file', actionClass: 'read' as const, signals: [{ kind: 'path-target', path: '/tmp/outside.txt', zone: 'outside-workdir' as const }, { kind: 'read-target-scope', scope: 'single-target' as const }, { kind: 'read-target-kind', targetKind: 'file' as const }] },
      { toolName: 'write_file', actionClass: 'write' as const, signals: [{ kind: 'write-target-scope', scope: 'outside-workdir' as const }, { kind: 'write-target-new' as const }] },
      { toolName: 'edit_file', actionClass: 'write' as const, signals: [{ kind: 'write-target-scope', scope: 'outside-workdir' as const }, { kind: 'write-target-existing' as const }] },
      { toolName: 'run_shell', actionClass: 'execute' as const, signals: [{ kind: 'im-shell-review-candidate', command: 'git-status' as const }] }
    ]
    for (const sample of samples) {
      const decisions = ['im-standard-v2', 'im-standard-v3'].map((policyBehaviorVersion) => decide({ ...sample, baseRiskLevel: 'medium', summary: { text: 'candidate' } },
        { lane: 'wechat', origin: { kind: 'direct-owner' }, sessionId: 'pkg-parity', policyTier: pkg },
        resolveImPolicyRulesForVersion({ policyBehaviorVersion, pkg, rules: DEFAULT_POLICY_RULES }), { cache: { lookup: () => null }, config: {}, migrationComplete: false }))
      expect(decisions[1]).toMatchObject({ type: decisions[0]!.type, ruleId: decisions[0]!.ruleId })
    }
  })

  it('applies explicit candidate mappings only to im-standard-v2', () => {
    const v2 = resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'standard', rules })
    expect(v2.map(({ id, action }) => [id, action])).toEqual([
      ['im-low-risk-create', 'auto-evaluator'],
      ['im-low-risk-edit', 'auto-evaluator'],
      ['im-write-ask', 'auto-evaluator'],
      ['browser-navigate-ask-remote', 'auto-evaluator'],
      ['im-mcp-public-read-review', 'auto-evaluator'],
      ['im-time-query-review', 'auto-evaluator'],
      ['script-clean-certified-remote', 'auto-evaluator'],
      ['script-dynamic-execution-confirm', 'confirm-every-time'],
      ['browser-act-ask-remote', 'auto-evaluator'],
      ['im-browser-act-danger-human', 'ask'],
      ['im-browser-act-review', 'auto-evaluator'],
      ['lark-write-ask', 'ask'],
      ['im-lark-low-write-review', 'auto-evaluator'],
      ['lark-high-impact-ask', 'ask'],
      ['lark-unknown-ask', 'ask'],
      ['im-lark-message-self-review', 'auto-evaluator'],
      ['im-lark-message-direct-review', 'auto-evaluator'],
      ['lark-message-group-human', 'ask'],
      ['lark-message-target-unknown-human', 'ask'],
      ['browser-act-danger-ask', 'ask'],
      ['path-sensitive-read-confirm', 'confirm-every-time'],
      ['remote-deny-lark-write-outbound', 'deny'],
      ['mcp-tool-ask', 'auto-evaluator'],
      ['hard-deny', 'deny']
    ])
  })

  it('preserves frozen legacy actions without applying current candidates', () => {
    const legacyRules = rules.map((rule) => ({ ...rule, action: rule.id === 'im-time-query-review' ? 'allow' as const : rule.action }))
    expect(resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-v1.6', pkg: 'standard', rules: legacyRules }))
      .toEqual(legacyRules)
  })

  it('requires a known behavior version and retains package floors', () => {
    expect(() => resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-v99', pkg: 'standard', rules })).toThrow()
    for (const pkg of ['strict', 'custom'] as const) {
      const resolved = resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg, rules })
      expect(resolved[1]?.action).toBe('ask')
      expect(resolved.find((rule) => rule.id === 'hard-deny')?.action).toBe('deny')
    }
    expect(resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'strict', rules })[6]?.action).toBe('ask')
    expect(resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'standard', rules })[7]?.action).toBe('confirm-every-time')
    const standard = resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'standard', rules })
    expect(standard.find((rule) => rule.id === 'lark-write-ask')?.action).toBe('ask')
    expect(standard.find((rule) => rule.id === 'im-lark-low-write-review')?.action).toBe('auto-evaluator')
    expect(standard.find((rule) => rule.id === 'im-write-ask')?.action).toBe('auto-evaluator')
    expect(standard.find((rule) => rule.id === 'lark-high-impact-ask')?.action).toBe('ask')
    expect(resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'strict', rules })
      .find((rule) => rule.id === 'im-write-ask')?.action).toBe('ask')
    expect(standard.find((rule) => rule.id === 'lark-unknown-ask')?.action).toBe('ask')
    expect(standard.find((rule) => rule.id === 'im-lark-message-self-review')?.action).toBe('auto-evaluator')
    expect(standard.find((rule) => rule.id === 'im-lark-message-direct-review')?.action).toBe('auto-evaluator')
    expect(standard.find((rule) => rule.id === 'lark-message-group-human')?.action).toBe('ask')
    expect(standard.find((rule) => rule.id === 'lark-message-target-unknown-human')?.action).toBe('ask')
    expect(standard.find((rule) => rule.id === 'browser-act-danger-ask')?.action).toBe('ask')
    expect(standard.find((rule) => rule.id === 'im-browser-act-danger-human'))
      .toMatchObject({ action: 'ask', locked: true, humanRequired: true })
    expect(resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'strict', rules })
      .find((rule) => rule.id === 'browser-act-ask-remote')?.action).toBe('ask')
    expect(standard.find((rule) => rule.id === 'path-sensitive-read-confirm')?.action).toBe('confirm-every-time')
    expect(standard.find((rule) => rule.id === 'remote-deny-lark-write-outbound')?.action).toBe('deny')
    expect(resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'loose', rules })[1]?.action).toBe('allow')
    expect(resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'loose', rules })[8]?.action).toBe('ask')
    expect(resolveImPolicyRulesForVersion({ policyBehaviorVersion: 'im-standard-v2', pkg: 'loose', rules })[8]?.action).toBe('ask')
  })
})
