import { describe, expect, it, vi, beforeEach } from 'vitest'
import { parseSkillCommand } from './skillCommandService'

describe('skillCommandService', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      api: {
        skillList: vi.fn().mockResolvedValue([]),
        skillGet: vi.fn().mockResolvedValue(null)
      }
    })
  })

  it('returns chat for normal messages', async () => {
    const r = await parseSkillCommand('hello world', { manualActivated: [], manualDisabled: [] })
    expect(r.type).toBe('chat')
    if (r.type === 'chat') expect(r.text).toBe('hello world')
  })

  it('handles list command', async () => {
    const r = await parseSkillCommand('/skill list', { manualActivated: [], manualDisabled: [] })
    expect(r.type).toBe('command')
    if (r.type === 'command') expect(r.hint).toContain('可用 Skill')
  })
})
