import { describe, expect, it } from 'vitest'
import type { SkillDefinition, SkillsConfig, SessionSkillsState } from '../../src/shared/domainTypes'
import { DEFAULT_SKILLS_CONFIG } from '../../src/shared/domainTypes'
import {
  buildRecentContext,
  buildRoutingUserMessage,
  buildSkillsCatalog,
  parseRoutingResponse
} from './skillRoutingPrompt'
import {
  applyLlmRecommendations,
  collectHardRuleSkills,
  getAvailableSkills,
  mergeRouteSkills
} from './skillRouter'

function skill(name: string, scope: 'project' | 'user', description: string, triggers: string[] = []): SkillDefinition {
  return {
    meta: { name, description, triggers, version: '1.0.0', author: '' },
    content: `# ${name}`,
    scope,
    directoryPath: `/tmp/${name}`,
    filePath: `/tmp/${name}/SKILL.md`,
    lastModified: Date.now()
  }
}

const emptyState: SessionSkillsState = { manualActivated: [], manualDisabled: [] }

describe('skillRoutingPrompt', () => {
  it('builds catalog with name and description only', () => {
    const catalog = buildSkillsCatalog([skill('foo', 'user', 'bar desc')], false)
    expect(catalog).toBe('- foo：bar desc')
    expect(catalog).not.toContain('project')
    expect(catalog).not.toContain('triggers')
  })

  it('optionally includes triggers', () => {
    const catalog = buildSkillsCatalog([skill('foo', 'user', 'desc', ['pdf'])], true)
    expect(catalog).toContain('触发词：pdf')
  })

  it('builds recent context for last_user_turn', () => {
    const ctx = buildRecentContext(
      'current question',
      [
        { role: 'user', content: 'old question' },
        { role: 'assistant', content: 'old answer' }
      ],
      DEFAULT_SKILLS_CONFIG.routing
    )
    expect(ctx).toContain('上一条用户消息：old question')
    expect(ctx).toContain('当前用户消息：current question')
  })

  it('builds routing user message', () => {
    const msg = buildRoutingUserMessage({
      userInput: 'hello',
      catalog: '- a：desc',
      recentContext: ''
    })
    expect(msg).toContain('## 用户当前请求')
    expect(msg).toContain('hello')
    expect(msg).toContain('- a：desc')
  })

  it('parses valid JSON', () => {
    expect(parseRoutingResponse('{"skills":["a","b"]}')).toEqual({ skills: ['a', 'b'] })
  })

  it('parses fenced JSON', () => {
    expect(parseRoutingResponse('```json\n{"skills":["x"]}\n```')).toEqual({ skills: ['x'] })
  })

  it('returns null for invalid JSON', () => {
    expect(parseRoutingResponse('not json')).toBeNull()
    expect(parseRoutingResponse('{"wrong":[]}')).toBeNull()
  })
})

describe('skillRouter hard rules', () => {
  const config: SkillsConfig = {
    ...DEFAULT_SKILLS_CONFIG,
    maxConcurrent: 3,
    alwaysLoad: ['always-one']
  }

  it('collects alwaysLoad and manual skills', () => {
    const skills = [
      skill('always-one', 'user', 'always'),
      skill('manual-one', 'user', 'manual'),
      skill('other', 'user', 'other')
    ]
    const available = getAvailableSkills(skills, config, emptyState)
    const scored = collectHardRuleSkills({
      available,
      config,
      sessionState: { manualActivated: ['manual-one'], manualDisabled: [] }
    })
    const { skills: merged, sources } = mergeRouteSkills(scored, config.maxConcurrent)
    expect(merged.map((s) => s.meta.name)).toEqual(expect.arrayContaining(['always-one', 'manual-one']))
    expect(sources['always-one']).toBe('alwaysLoad')
    expect(sources['manual-one']).toBe('manual')
  })

  it('excludes disabled skills from available list', () => {
    const skills = [skill('blocked', 'user', 'x')]
    const available = getAvailableSkills(skills, config, { manualActivated: [], manualDisabled: ['blocked'] })
    expect(available).toHaveLength(0)
  })

  it('merges llm recommendations and ignores unknown names', () => {
    const skills = [skill('good', 'project', 'desc'), skill('bad', 'user', 'desc')]
    const available = getAvailableSkills(skills, config, emptyState)
    const scored = collectHardRuleSkills({ available, config, sessionState: emptyState })
    applyLlmRecommendations({
      scored,
      llmRecommended: ['good', 'not-exist'],
      available,
      excluded: new Set<string>()
    })
    const { skills: merged, sources } = mergeRouteSkills(scored, 5)
    expect(merged.some((s) => s.meta.name === 'good')).toBe(true)
    expect(merged.some((s) => s.meta.name === 'not-exist')).toBe(false)
    expect(sources['good']).toBe('llm')
  })

  it('prefers project scope when llm scores tie', () => {
    const projectSkill = skill('proj', 'project', 'p')
    const userSkill = skill('user', 'user', 'u')
    const available = [projectSkill, userSkill]
    const scored = collectHardRuleSkills({ available, config, sessionState: emptyState })
    applyLlmRecommendations({
      scored,
      llmRecommended: ['proj', 'user'],
      available,
      excluded: new Set<string>()
    })
    const { skills: merged } = mergeRouteSkills(scored, 1)
    expect(merged[0]?.meta.name).toBe('proj')
  })

  it('skips llm recommendations for recovery-only skills', () => {
    const skills = [
      skill('good', 'project', 'desc'),
      skill('browser-setup-guide', 'builtin', 'browser recovery')
    ]
    const available = getAvailableSkills(skills, config, emptyState)
    const scored = collectHardRuleSkills({ available, config, sessionState: emptyState })
    applyLlmRecommendations({
      scored,
      llmRecommended: ['browser-setup-guide', 'good'],
      available,
      excluded: new Set<string>()
    })
    const { skills: merged, sources } = mergeRouteSkills(scored, 5)
    expect(merged.some((s) => s.meta.name === 'good')).toBe(true)
    expect(merged.some((s) => s.meta.name === 'browser-setup-guide')).toBe(false)
    expect(sources['good']).toBe('llm')
  })

  it('respects maxConcurrent after merge', () => {
    const skills = [
      skill('a', 'user', 'a'),
      skill('b', 'user', 'b'),
      skill('c', 'user', 'c'),
      skill('d', 'user', 'd')
    ]
    const available = getAvailableSkills(skills, { ...config, maxConcurrent: 2 }, emptyState)
    const scored = collectHardRuleSkills({ available, config: { ...config, maxConcurrent: 2 }, sessionState: emptyState })
    applyLlmRecommendations({
      scored,
      llmRecommended: ['a', 'b', 'c', 'd'],
      available,
      excluded: new Set<string>()
    })
    const { skills: merged } = mergeRouteSkills(scored, 2)
    expect(merged).toHaveLength(2)
  })
})
