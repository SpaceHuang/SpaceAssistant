import { describe, expect, it } from 'vitest'
import { parseFrozenLegacyPolicyBehavior, resolveFrozenLegacyPolicyBehavior } from './legacyPolicyBehavior'

const fixtures = {
  readOnly: {
    remoteConfirmPolicy: 'remote_read_only', remoteAllowLocalWrite: false,
    remoteDenyOutbound: true, browserConfirm: true, scriptRequiresConfirm: true,
    larkWriteRequiresConfirm: true, disabledRuleIds: ['legacy-custom-1'],
    capabilities: ['read-file', 'navigate']
  },
  standard: { pkg: 'standard', rules: [{ id: 'script-clean', action: 'allow' }], conditional: { browserAct: 'always-ask' } },
  strict: { pkg: 'strict', scope: ['script-clean', 'browser-act'], rules: [] },
  loose: { pkg: 'loose', scope: ['browser-navigate'], rules: [] },
  custom: { pkg: 'custom', rules: [{ id: 'custom-ask', action: 'ask', when: 'owner-only' }] }
} as const

describe('frozen legacy IM policy behavior', () => {
  it('restores legacy package scopes, conditions, final actions, capabilities, and disabled rules', () => {
    const parsed = parseFrozenLegacyPolicyBehavior({ policyBehaviorVersion: 'im-v1.6', fixtures })
    expect(parsed.sourcePolicyBehaviorVersion).toBe('im-v1.6')
    expect(parsed.packages.strict.scope).toEqual(['script-clean', 'browser-act'])
    expect(parsed.packages.loose.scope).toEqual(['browser-navigate'])
    expect(parsed.packages.standard.rules[0]).toMatchObject({ id: 'script-clean', action: 'allow' })
    expect(parsed.packages.standard.conditional).toEqual({ browserAct: 'always-ask' })
    expect(parsed.packages.custom.rules[0]).toMatchObject({ id: 'custom-ask', action: 'ask', when: 'owner-only' })
    expect(parsed.capabilities).toEqual(expect.arrayContaining(['read-file', 'navigate']))
    expect(parsed.disabledRuleIds).toEqual(['legacy-custom-1'])
    expect(parsed.remoteConfirmPolicy).toMatchObject({ remoteReadOnly: true, denyWrite: true, denyOutbound: true })
  })

  it('rejects missing or unknown behavior version instead of inferring schema/config version', () => {
    expect(() => parseFrozenLegacyPolicyBehavior({ policyBehaviorVersion: undefined, schemaVersion: 1, remoteSecurityConfigVersion: 1, fixtures })).toThrow()
    expect(() => parseFrozenLegacyPolicyBehavior({ policyBehaviorVersion: 'im-v9', schemaVersion: 1, remoteSecurityConfigVersion: 1, fixtures })).toThrow()
  })

  it('restores the persisted frozen snapshot only when its source behavior version is explicit', () => {
    const parsed = parseFrozenLegacyPolicyBehavior({ policyBehaviorVersion: 'im-v1.6', fixtures })
    expect(resolveFrozenLegacyPolicyBehavior({ policyBehaviorVersion: 'im-v1.6', legacyBehavior: parsed })).toEqual(parsed)
    expect(() => resolveFrozenLegacyPolicyBehavior({ policyBehaviorVersion: 'im-v2', legacyBehavior: parsed })).toThrow()
    expect(() => resolveFrozenLegacyPolicyBehavior({ policyBehaviorVersion: 'im-v1.6', legacyBehavior: { ...parsed, sourcePolicyBehaviorVersion: 'im-v2' } })).toThrow()
  })
})
