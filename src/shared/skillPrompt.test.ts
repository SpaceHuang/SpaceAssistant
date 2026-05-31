import { describe, expect, it } from 'vitest'
import type { SkillDefinition } from './domainTypes'
import { buildAvailableToolsHint, buildSkillRouteSignature, buildSystemPromptFromSkills, truncateSystemPrompt } from './skillPrompt'

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

  it('buildAvailableToolsHint lists tools and notes when run_shell disabled', () => {
    const hint = buildAvailableToolsHint(['read_file', 'browser_detect'])
    expect(hint).toContain('read_file, browser_detect')
    expect(hint).toContain('run_shell 当前未启用')
    expect(hint).toContain('run_script')
  })

  it('buildSkillRouteSignature is stable for same route', () => {
    const skills = [
      {
        meta: { name: 'browser-setup-guide', description: '', triggers: [], version: '1', author: '' },
        content: '',
        scope: 'builtin' as const,
        directoryPath: '',
        filePath: '',
        lastModified: 0
      }
    ]
    const sources = { 'browser-setup-guide': 'manual' as const }
    expect(buildSkillRouteSignature(skills, sources)).toBe('browser-setup-guide@manual')
  })
})
