import { describe, expect, it } from 'vitest'
import type { SkillDefinition } from './domainTypes'
import { buildAvailableToolsHint, buildSkillCatalogSection, buildSkillRouteSignature, buildSystemPromptFromSkills, buildToolCapabilityConventionHint, readSkillForTool, truncateSystemPrompt } from './skillPrompt'

describe('skillPrompt', () => {
  it('renders tool capability conventions without enumerating tool names', () => {
    const hint = buildToolCapabilityConventionHint(['run_shell'])
    expect(hint).toContain('run_shell')
    expect(hint).toContain('run_script')
    expect(hint).not.toContain('当前可用工具')
    expect(hint).not.toContain('仅可调用以下工具名称')
  })
  it('toolkit 提示按工具面条件注入（评审 S6）：暴露 toolkit_find 时含 compat 名；否则不诱导', () => {
    const withToolkit = buildToolCapabilityConventionHint(['run_shell', 'toolkit_find', 'toolkit_call'])
    expect(withToolkit).toContain('toolkit_find')
    expect(withToolkit).toContain('toolkit_call')
    expect(withToolkit).not.toContain('toolkit.find')
    const withoutToolkit = buildToolCapabilityConventionHint(['run_shell'])
    expect(withoutToolkit).not.toContain('toolkit')
  })
  it('reads a registered skill by name with a bounded response', () => {
    const skill = { meta: { name: 'demo', description: '', triggers: [], version: '1', author: '' }, content: 'content', scope: 'user' as const, directoryPath: '/a', filePath: '/a/SKILL.md', lastModified: 0 }
    expect(readSkillForTool([skill], 'demo', 100)).toBe('content')
    expect(() => readSkillForTool([skill], '../secret', 100)).toThrow(/not found/i)
    expect(() => readSkillForTool([skill], 'demo', 0)).toThrow(/budget/i)
  })
  it('builds a bounded catalog without skill bodies', () => {
    const skills: SkillDefinition[] = [{
      meta: { name: 'demo', description: 'Use this for demos', triggers: ['x'], version: '1', author: '' },
      content: 'SECRET BODY', scope: 'user', directoryPath: '/a', filePath: '/a/SKILL.md', lastModified: 0
    }]
    const section = buildSkillCatalogSection(skills, 10_000)
    expect(section.name).toBe('skills:catalog')
    expect(section.text).toContain('### Available skills')
    expect(section.text).toContain('demo')
    expect(section.text).not.toContain('SECRET BODY')
  })

  it('does not expose host paths or imply that hidden skills are readable', () => {
    const skill: SkillDefinition = {
      meta: { name: 'private-skill', description: 'Private task helper', triggers: [], version: '1', author: '' },
      content: 'PRIVATE BODY', scope: 'user', directoryPath: '/Users/alice/.spaceassistant/skills/private-skill',
      filePath: '/Users/alice/.spaceassistant/skills/private-skill/SKILL.md', lastModified: 0
    }
    const section = buildSkillCatalogSection([skill], 10_000)
    expect(section.text).toContain('skills.read')
    expect(section.text).not.toContain('/Users/alice')
    expect(section.text).not.toContain('Additional skills are available')
  })

  it('uses a stable truncation marker without suggesting hidden skills can be read', () => {
    const skills: SkillDefinition[] = Array.from({ length: 8 }, (_, index) => ({
      meta: { name: `skill-${index}`, description: 'A long description '.repeat(10), triggers: [], version: '1', author: '' },
      content: '', scope: 'user', directoryPath: `/private/${index}`, filePath: `/private/${index}/SKILL.md`, lastModified: 0
    }))
    const first = buildSkillCatalogSection(skills, 5_000)
    const second = buildSkillCatalogSection([...skills].reverse(), 5_000)
    expect(first.text).toBe(second.text)
    expect(first.text).toContain('truncated')
    expect(first.text).not.toContain('skills.read(\"skill-')
  })
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
