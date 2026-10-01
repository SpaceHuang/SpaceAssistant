import type { BrowserDependencyToolError } from '../../shared/browserTypes'
import { activateRecoverySkillInState, resolveDependencyRecoverySkill } from '../../shared/browserDependencyRecovery'
import type { SessionSkillsState } from '../../shared/domainTypes'
import { normalizeSessionSkillsState } from '../../shared/domainTypes'
import { runtimeText } from '../i18n/runtimeText'

export async function activateBrowserRecoverySkillIfNeeded(args: {
  dependencyRecovery: BrowserDependencyToolError
  sessionId: string
  currentSkillsState?: SessionSkillsState
}): Promise<{ activated: boolean; skillsState?: SessionSkillsState; hint?: string }> {
  const skillName = resolveDependencyRecoverySkill(args.dependencyRecovery.errorCode)
  if (!skillName) return { activated: false }

  const freshSession = await window.api.sessionGet(args.sessionId)
  const current = normalizeSessionSkillsState(freshSession?.skillsState ?? args.currentSkillsState)
  if (current.manualActivated.includes(skillName)) {
    return { activated: false }
  }

  const skillsState = activateRecoverySkillInState(current, skillName)
  const updated = await window.api.sessionUpdate({ sessionId: args.sessionId, skillsState })
  if (!updated) return { activated: false }

  return {
    activated: true,
    skillsState,
    hint: runtimeText('chat.skillLoaded', { name: skillName })
  }
}
