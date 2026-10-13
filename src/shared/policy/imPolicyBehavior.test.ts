import { describe, expect, it } from 'vitest'
import { resolveImPolicyAction, type ImPolicyScenario } from './policyPackages'

const PACKAGES = ['strict', 'standard', 'loose', 'custom'] as const
const SCENARIOS: readonly ImPolicyScenario[] = [
  'ordinary-read',
  'low-risk-create',
  'low-risk-edit',
  'ordinary-navigation',
  'public-search',
  'time-query',
  'certified-clean-script',
  'ordinary-browser-action',
  'low-risk-feishu-write',
  'overwrite-delete',
  'unknown-write-execute',
  'outbound'
] as const

describe('common IM policy behavior', () => {
  it('resolves the IM action matrix by domain and package', () => {
    const matrix = Object.fromEntries(PACKAGES.map((pkg) => [
      pkg,
      Object.fromEntries(SCENARIOS.map((scenario) => [
        scenario,
        resolveImPolicyAction({ domain: 'im', pkg, scenario })
      ]))
    ]))
    expect(matrix).toEqual({
      strict: {
        'ordinary-read': 'allow', 'low-risk-create': 'ask', 'low-risk-edit': 'ask', 'ordinary-navigation': 'ask', 'public-search': 'ask', 'time-query': 'ask', 'certified-clean-script': 'ask', 'ordinary-browser-action': 'ask', 'low-risk-feishu-write': 'ask', 'overwrite-delete': 'ask',
        'unknown-write-execute': 'ask', outbound: 'ask'
      },
      standard: {
        'ordinary-read': 'allow', 'low-risk-create': 'auto-evaluator', 'low-risk-edit': 'auto-evaluator', 'ordinary-navigation': 'auto-evaluator', 'public-search': 'auto-evaluator', 'time-query': 'auto-evaluator', 'certified-clean-script': 'auto-evaluator', 'ordinary-browser-action': 'auto-evaluator', 'low-risk-feishu-write': 'auto-evaluator', 'overwrite-delete': 'ask',
        'unknown-write-execute': 'ask', outbound: 'ask'
      },
      loose: {
        'ordinary-read': 'allow', 'low-risk-create': 'allow', 'low-risk-edit': 'allow', 'ordinary-navigation': 'allow', 'public-search': 'allow', 'time-query': 'allow', 'certified-clean-script': 'allow', 'ordinary-browser-action': 'ask', 'low-risk-feishu-write': 'ask', 'overwrite-delete': 'ask',
        'unknown-write-execute': 'ask', outbound: 'ask'
      },
      custom: {
        'ordinary-read': 'allow', 'low-risk-create': 'ask', 'low-risk-edit': 'ask', 'ordinary-navigation': 'ask', 'public-search': 'ask', 'time-query': 'ask', 'certified-clean-script': 'ask', 'ordinary-browser-action': 'ask', 'low-risk-feishu-write': 'ask', 'overwrite-delete': 'ask',
        'unknown-write-execute': 'ask', outbound: 'ask'
      }
    })
  })

  it('hard deny and per-action human floor override every package', () => {
    for (const pkg of PACKAGES) {
      expect(resolveImPolicyAction({ domain: 'im', pkg, scenario: 'hard-deny' })).toBe('deny')
      expect(resolveImPolicyAction({ domain: 'im', pkg, scenario: 'human-required' })).toBe('ask')
    }
  })

  it('custom explicit ask remains ask', () => {
    expect(resolveImPolicyAction({ domain: 'im', pkg: 'custom', scenario: 'low-risk-create', customAction: 'ask' })).toBe('ask')
  })
})
