import { describe, expect, it } from 'vitest'
import type { SkillDefinition } from './domainTypes'
import { buildSystemPromptFromSkills, truncateSystemPrompt } from './skillPrompt'

describe('skillPrompt', () => {
  it('builds system prompt from skills', () => {
    const skills: SkillDefinition[] = [
      {
        meta: { name: 'demo', description: 'd', triggers: ['x'], version: '1.2.0', author: '' },
        content: 'Rule one',
        scope: 'user',
        directoryPath: '/a',
        filePath: '/a/SKILL.md',
        lastModified: 0
      }
    ]
    const prompt = buildSystemPromptFromSkills(skills)
    expect(prompt).toContain('Skill: demo (v1.2.0)')
    expect(prompt).toContain('Rule one')
  })

  it('truncates long system prompt', () => {
    const long = 'x'.repeat(1000)
    const truncated = truncateSystemPrompt(long, 100)
    expect(truncated.length).toBeLessThanOrEqual(100)
    expect(truncated).toContain('截断')
  })
})
