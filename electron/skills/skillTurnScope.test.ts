import { describe, expect, it } from 'vitest'
import type { SkillDefinition } from '../../src/shared/domainTypes'
import { createSkillTurnScope } from './skillTurnScope'

function skill(name: string, content = `${name} body`): SkillDefinition {
  return {
    meta: { name, description: `${name} description`, triggers: [], version: '1', author: '' },
    content, scope: 'user', directoryPath: `/private/${name}`, filePath: `/private/${name}/SKILL.md`, lastModified: 1
  }
}

describe('skill turn scope', () => {
  it('freezes authorized skill bodies and counts preloaded skills against the turn budget', () => {
    const original = skill('alpha', 'version one')
    const scope = createSkillTurnScope({ catalogSkills: [original, skill('beta')], preloadedSkills: [original], maxConcurrent: 2 })
    original.content = 'mutated after acceptance'

    expect(scope.planRead('alpha', 100).content).toBe('version one')
    expect(scope.committedNames).toEqual(['alpha'])
    scope.close()
    expect(() => scope.planRead('alpha', 100)).toThrow('SKILL_TURN_SCOPE_CLOSED')
  })

  it('permits only catalog names, commits only successful distinct reads, and is idempotent by name', () => {
    const scope = createSkillTurnScope({ catalogSkills: [skill('alpha'), skill('beta')], preloadedSkills: [], maxConcurrent: 1 })
    const alpha = scope.planRead('alpha', 100)
    expect(() => scope.planRead('../alpha', 100)).toThrow('SKILL_NOT_AUTHORIZED')
    expect(scope.committedNames).toEqual([])
    expect(scope.commitRead(alpha.name)).toBe(true)
    expect(scope.commitRead(alpha.name)).toBe(true)
    expect(scope.commitRead('beta')).toBe(false)
    expect(scope.committedNames).toEqual(['alpha'])
  })

  it('isolates concurrently created turns and closes only the selected turn', () => {
    const first = createSkillTurnScope({ catalogSkills: [skill('alpha')], preloadedSkills: [], maxConcurrent: 1 })
    const second = createSkillTurnScope({ catalogSkills: [skill('beta')], preloadedSkills: [], maxConcurrent: 1 })
    first.close()

    expect(first.isActive).toBe(false)
    expect(second.planRead('beta', 100).content).toBe('beta body')
    expect(second.committedNames).toEqual([])
  })

  it('preserves the budget invariant across a deterministic randomized operation sequence', () => {
    const scope = createSkillTurnScope({
      catalogSkills: Array.from({ length: 5 }, (_, index) => skill(`skill-${index}`)),
      preloadedSkills: [skill('skill-0')], maxConcurrent: 3
    })
    let state = 0x51a11
    for (let i = 0; i < 250; i += 1) {
      state = (state * 48271) % 0x7fffffff
      const name = `skill-${state % 5}`
      try { scope.planRead(name, 100) } catch { /* A read may be unauthorized only if the catalog changes. */ }
      scope.commitRead(name)
      expect(new Set(scope.committedNames).size).toBe(scope.committedNames.length)
      expect(scope.committedNames.length).toBeLessThanOrEqual(3)
    }
  })
})
