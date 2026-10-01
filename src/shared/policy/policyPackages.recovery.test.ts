import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY_RULES } from './defaultRules'
import { effectiveActionFor, LANE_PROFILES } from './policyPackages'

describe('恢复档位覆盖的安全 floor', () => {
  it('desktop loose 档按云端语义放行未建模调用规则', () => {
    const rule = DEFAULT_POLICY_RULES.find((candidate) => candidate.id === 'script-unmodeled-path-ask')
    expect(rule).toBeDefined()
    expect(effectiveActionFor('desktop', 'loose', rule!)).toBe('allow')
    expect(effectiveActionFor('wechat', 'loose', rule!)).toBe('ask')
  })

  it('动态执行规则保持 locked 且不能被档位转换放宽', () => {
    const rule = DEFAULT_POLICY_RULES.find((candidate) => candidate.id === 'script-unverified-language-confirm')
    expect(rule).toBeDefined()
    expect(rule?.locked).toBe(true)
    expect(effectiveActionFor('desktop', 'loose', rule!)).toBe('confirm-every-time')
  })

  it('按 ruleId 档位动作只影响精确登记的桌面规则', () => {
    expect(effectiveActionFor('desktop', 'standard', { id: 'browser-act-ask-desktop', action: 'ask' })).toBe('allow')
    expect(effectiveActionFor('desktop', 'standard', { id: 'browser-act-danger-ask', action: 'ask' })).toBe('auto-evaluator')
    expect(effectiveActionFor('desktop', 'loose', { id: 'script-network-ask-desktop', action: 'ask' })).toBe('auto-evaluator')
    expect(effectiveActionFor('desktop', 'loose', { id: 'default-write-execute-ask', action: 'ask' })).toBe('allow')
    expect(effectiveActionFor('desktop', 'loose', { id: 'browser-navigate-ask-desktop', action: 'ask' })).toBe('ask')
    expect(effectiveActionFor('wechat', 'loose', { id: 'script-network-ask-desktop', action: 'ask' })).toBe('ask')
  })

  it('档位动作不能放宽 deny、locked、必须真人确认或 custom', () => {
    expect(effectiveActionFor('desktop', 'loose', { id: 'remote-shell-disabled', action: 'deny', locked: true })).toBe('deny')
    expect(effectiveActionFor('desktop', 'loose', { id: 'script-path-unknown-confirm', action: 'confirm-every-time' })).toBe('confirm-every-time')
    expect(effectiveActionFor('desktop', 'loose', { id: 'script-unverified-language-confirm', action: 'ask', locked: true })).toBe('ask')
    expect(effectiveActionFor('desktop', 'custom', { id: 'default-write-execute-ask', action: 'ask' })).toBe('ask')
  })

  it('声明式范围自动放行规则默认关闭，可由显式配置开启', () => {
    const rule = DEFAULT_POLICY_RULES.find((candidate) => candidate.id === 'script-declared-path-scope-allow-desktop')
    expect(rule).toMatchObject({ action: 'allow', configRequires: { config: 'allowDeclaredPathScopeScripts', equals: true } })
  })
})
