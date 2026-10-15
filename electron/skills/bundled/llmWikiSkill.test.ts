import { describe, expect, it } from 'vitest'
import { getBundledLlmWikiSkill, LLM_WIKI_SKILL_NAME } from './llmWikiSkill'
import { getSkillByName } from '../skillScanner'
import { buildSkillCatalogSection } from '../../../src/shared/skillPrompt'
import { WIKI_VOCABULARY_PREFIX } from '../../../src/shared/wikiConstants'

describe('llmWikiSkill', () => {
  it('解析通过 validateSkillMeta：name=llm-wiki，triggers 覆盖知识库/存入 wiki/llm-wiki 变体', () => {
    const skill = getBundledLlmWikiSkill()
    expect(skill.meta.name).toBe(LLM_WIKI_SKILL_NAME)
    expect(LLM_WIKI_SKILL_NAME).toBe(WIKI_VOCABULARY_PREFIX)
    expect(skill.scope).toBe('builtin')
    expect(skill.meta.triggers.length).toBeGreaterThan(0)
    expect(skill.meta.triggers).toContain('知识库')
    expect(skill.meta.triggers).toContain('存入wiki')
    expect(skill.meta.triggers).toContain('存到知识库')
    expect(skill.meta.triggers).toContain('llm-wiki')
    expect(skill.meta.triggers).toContain('llm wiki')
  })

  it('正文给出 llm-wiki/ 词汇路径约定并禁止文件系统盲搜与旧别名绕行', () => {
    const skill = getBundledLlmWikiSkill()
    expect(skill.content).toContain('`llm-wiki/`')
    expect(skill.content).toMatch(/禁止.*list_directory/)
    expect(skill.content).toContain('wiki-readonly-alias')
    expect(skill.content).toMatch(/未启用/)
  })

  it('skillScanner 合并后包含 llm-wiki', () => {
    const skill = getSkillByName('/tmp/user', '/tmp/work', LLM_WIKI_SKILL_NAME)
    expect(skill?.meta.name).toBe(LLM_WIKI_SKILL_NAME)
  })

  it('常驻目录行长度受控（≤300 字符，防 description 回胖）', () => {
    const skill = getBundledLlmWikiSkill()
    const section = buildSkillCatalogSection([skill], 200_000)
    const line = section.text.split('\n').find((candidate) => candidate.includes('**llm-wiki**'))
    expect(line).toBeTruthy()
    expect(line!.length).toBeLessThanOrEqual(300)
  })
})
