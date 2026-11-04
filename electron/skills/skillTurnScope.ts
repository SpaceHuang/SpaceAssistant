import { createHash, randomUUID } from 'node:crypto'
import type { SkillDefinition } from '../../src/shared/domainTypes'
import { readSkillForTool } from '../../src/shared/skillPrompt'

export type SkillReadPlan = Readonly<{
  scopeId: string
  name: string
  content: string
  contentSha256: string
}>

export interface SkillTurnScope {
  readonly id: string
  readonly catalogSkills: readonly SkillDefinition[]
  readonly readableSkills: readonly SkillDefinition[]
  readonly maxConcurrent: number
  readonly committedNames: readonly string[]
  readonly isActive: boolean
  planRead(name: string, maxChars: number): SkillReadPlan
  validateRead(plan: SkillReadPlan): void
  commitRead(name: string): boolean
  close(): void
}

/**
 * Desktop turn authorization invariant: SkillManager.prepareTurn creates this frozen allowlist;
 * skills.read uses planRead/validateRead as its final scope checks, and commitRead is the sole
 * budget writer. Boundary coverage lives in skillTurnScope.test.ts and skillsReadTool.test.ts.
 */
export function createSkillTurnScope(input: {
  catalogSkills: readonly SkillDefinition[]
  preloadedSkills: readonly SkillDefinition[]
  maxConcurrent: number
}): SkillTurnScope {
  const freezeSkills = (skills: readonly SkillDefinition[]): readonly SkillDefinition[] =>
    Object.freeze(structuredClone(skills).map((skill) => Object.freeze({
      ...skill,
      meta: Object.freeze({ ...skill.meta, triggers: Object.freeze([...skill.meta.triggers]) })
    }))) as unknown as readonly SkillDefinition[]
  const catalogSkills = freezeSkills(input.catalogSkills)
  const readableSkills = catalogSkills
  const byName = new Map(readableSkills.map((skill) => [skill.meta.name, skill]))
  const committed = new Set(input.preloadedSkills.map((skill) => skill.meta.name))
  const maxConcurrent = Math.max(0, Math.floor(input.maxConcurrent))
  let active = true
  const id = randomUUID()

  const assertActive = (): void => {
    if (!active) throw new Error('SKILL_TURN_SCOPE_CLOSED')
  }
  const assertAuthorized = (name: string): SkillDefinition => {
    assertActive()
    const skill = byName.get(name)
    if (!skill) throw new Error('SKILL_NOT_AUTHORIZED')
    return skill
  }

  return {
    id,
    catalogSkills,
    readableSkills,
    maxConcurrent,
    get committedNames() { return [...committed].sort() },
    get isActive() { return active },
    planRead(name, maxChars) {
      const skill = assertAuthorized(name)
      const content = readSkillForTool([skill], name, maxChars)
      return Object.freeze({ scopeId: id, name, content, contentSha256: createHash('sha256').update(content).digest('hex') })
    },
    validateRead(plan) {
      const skill = assertAuthorized(plan.name)
      if (plan.scopeId !== id || createHash('sha256').update(skill.content).digest('hex') !== plan.contentSha256 ||
        skill.content !== plan.content) {
        throw new Error('SKILL_READ_PLAN_CHANGED')
      }
    },
    commitRead(name) {
      assertAuthorized(name)
      if (committed.has(name)) return true
      if (committed.size >= maxConcurrent) return false
      committed.add(name)
      return true
    },
    close() { active = false }
  }
}
