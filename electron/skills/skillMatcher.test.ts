import { describe, expect, it } from 'vitest'
import type { SkillDefinition, SkillsConfig, SessionSkillsState } from '../../src/shared/domainTypes'
import { DEFAULT_SKILLS_CONFIG } from '../../src/shared/domainTypes'
import { matchSkills } from './skillMatcher'

function skill(name: string, scope: 'project' | 'user', triggers: string[], description: string): SkillDefinition {
  return {
    meta: { name, description, triggers, version: '1.0.0', author: '' },
    content: `# ${name}`,
    scope,
    directoryPath: `/tmp/${name}`,
    filePath: `/tmp/${name}/SKILL.md`,
    lastModified: Date.now()
  }
}

const config: SkillsConfig = { ...DEFAULT_SKILLS_CONFIG, maxConcurrent: 2 }
const emptyState: SessionSkillsState = { manualActivated: [], manualDisabled: [] }

describe('skillMatcher', () => {
  it('matches by keyword', () => {
    const skills = [skill('pdf-handling', 'user', ['pdf'], 'PDF 文档处理')]
    const matched = matchSkills({ userInput: '请处理这个 PDF 文件', skills, config, sessionState: emptyState })
    expect(matched.map((s) => s.meta.name)).toEqual(['pdf-handling'])
  })

  it('excludes disabled skills', () => {
    const skills = [skill('code-review', 'user', ['review'], '审查')]
    const matched = matchSkills({
      userInput: 'review this',
      skills,
      config: { ...config, disabled: ['code-review'] },
      sessionState: emptyState
    })
    expect(matched).toHaveLength(0)
  })

  it('respects maxConcurrent', () => {
    const skills = [
      skill('a', 'user', ['test'], 'test a'),
      skill('b', 'user', ['test'], 'test b'),
      skill('c', 'user', ['test'], 'test c')
    ]
    const matched = matchSkills({ userInput: 'test', skills, config, sessionState: emptyState })
    expect(matched.length).toBeLessThanOrEqual(2)
  })

  it('matches by description similarity', () => {
    const skills = [skill('docx-generation', 'user', [], 'Word 文档格式规范')]
    const matched = matchSkills({
      userInput: '请生成 Word 文档',
      skills,
      config,
      sessionState: emptyState
    })
    expect(matched.some((s) => s.meta.name === 'docx-generation')).toBe(true)
  })

  it('includes manual activated skills', () => {
    const skills = [skill('manual-one', 'user', [], 'hidden')]
    const matched = matchSkills({
      userInput: 'hello',
      skills,
      config,
      sessionState: { manualActivated: ['manual-one'], manualDisabled: [] }
    })
    expect(matched[0]?.meta.name).toBe('manual-one')
  })
})
