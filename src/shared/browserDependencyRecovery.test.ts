import { describe, expect, it } from 'vitest'
import {
  CHROMIUM_RECOVERY_CODES,
  resolveDependencyRecoverySkill,
  activateRecoverySkillInState
} from './browserDependencyRecovery'

describe('browserDependencyRecovery (shared)', () => {
  it('exports chromium recovery codes whitelist', () => {
    expect(CHROMIUM_RECOVERY_CODES).toContain('chromium_missing')
    expect(CHROMIUM_RECOVERY_CODES).not.toContain('stagehand_missing')
  })

  it('resolveDependencyRecoverySkill maps chromium codes', () => {
    expect(resolveDependencyRecoverySkill('chromium_missing')).toBe('browser-setup-guide')
    expect(resolveDependencyRecoverySkill('stagehand_missing')).toBeNull()
  })

  it('activateRecoverySkillInState adds manual activation', () => {
    const next = activateRecoverySkillInState({ manualActivated: [], manualDisabled: [] }, 'browser-setup-guide')
    expect(next.manualActivated).toContain('browser-setup-guide')
  })
})
