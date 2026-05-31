import type { BrowserDependencyFailureCode } from './browserTypes'
import type { SessionSkillsState } from './domainTypes'
import { normalizeSessionSkillsState } from './domainTypes'

export const BROWSER_SETUP_RECOVERY_SKILL = 'browser-setup-guide'

export const CHROMIUM_RECOVERY_CODES = [
  'chromium_missing',
  'chromium_headless_only',
  'chromium_path_unresolved',
  'init_probe_failed'
] as const satisfies readonly BrowserDependencyFailureCode[]

export function isChromiumRecoveryFailure(code: BrowserDependencyFailureCode): boolean {
  return (CHROMIUM_RECOVERY_CODES as readonly string[]).includes(code)
}

export function resolveDependencyRecoverySkill(errorCode: string): string | null {
  if (isChromiumRecoveryFailure(errorCode as BrowserDependencyFailureCode)) {
    return BROWSER_SETUP_RECOVERY_SKILL
  }
  return null
}

export function activateRecoverySkillInState(
  state: SessionSkillsState | undefined,
  skillName: string
): SessionSkillsState {
  const base = normalizeSessionSkillsState(state)
  const manualActivated = [...new Set([...base.manualActivated, skillName])]
  const manualDisabled = base.manualDisabled.filter((n) => n !== skillName)
  return { manualActivated, manualDisabled }
}
