import { describe, expect, it, vi } from 'vitest'
import { parseSkillCommand } from './skillCommandService'
import type { SkillDefinition } from '../../shared/domainTypes'

function makeSkill(name: string, scope: SkillDefinition['scope']): SkillDefinition {
  return {
    meta: { name, description: '演示技能', triggers: [], version: '1.0.0', author: 'test' },
    content: '',
    scope,
    directoryPath: '',
    filePath: '',
    lastModified: 0
  }
}

function makeDeps(overrides: Partial<{ listSkills: ReturnType<typeof vi.fn>; getSkill: ReturnType<typeof vi.fn> }> = {}) {
  return {
    listSkills: overrides.listSkills ?? vi.fn().mockResolvedValue([]),
    getSkill: overrides.getSkill ?? vi.fn().mockResolvedValue(null)
  }
}

describe('skillCommandService', () => {
  it('returns chat for normal messages', async () => {
    const r = await parseSkillCommand('hello world', { manualActivated: [], manualDisabled: [] }, makeDeps())
    expect(r.type).toBe('chat')
    if (r.type === 'chat') expect(r.text).toBe('hello world')
  })

  it('handles list command via injected listSkills port', async () => {
    const deps = makeDeps({ listSkills: vi.fn().mockResolvedValue([makeSkill('demo', 'project')]) })
    const r = await parseSkillCommand('/skill list', { manualActivated: [], manualDisabled: [] }, deps)
    expect(r.type).toBe('command')
    if (r.type === 'command') {
      expect(r.hint).toContain('可用 Skill')
      expect(r.hint).toContain('demo')
    }
    expect(deps.listSkills).toHaveBeenCalled()
  })

  it('activates skill via injected getSkill port', async () => {
    const deps = makeDeps({ getSkill: vi.fn().mockResolvedValue(makeSkill('demo', 'user')) })
    const r = await parseSkillCommand('/skill use demo', { manualActivated: [], manualDisabled: [] }, deps)
    expect(r.type).toBe('command')
    if (r.type === 'command') {
      expect(r.skillsState?.manualActivated).toContain('demo')
    }
    expect(deps.getSkill).toHaveBeenCalledWith({ name: 'demo' })
  })

  it('reports missing skill via injected getSkill port', async () => {
    const r = await parseSkillCommand('/skill use nope', { manualActivated: [], manualDisabled: [] }, makeDeps())
    expect(r.type).toBe('command')
    if (r.type === 'command') expect(r.hint).toContain('未找到')
  })
})
