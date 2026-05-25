import { describe, expect, it } from 'vitest'
import { buildDisambiguationReply, resolveWorkDirFromFeishuCommand } from './feishuWorkDirResolver'

describe('feishuWorkDirResolver', () => {
  const profiles = [
    { id: '1', name: 'SpaceAssistant', path: '/a', aliases: ['SA'] },
    { id: '2', name: 'SpaceAssistant-Docs', path: '/b' }
  ]

  it('matches alias from prefix', () => {
    const r = resolveWorkDirFromFeishuCommand('/sa @SA run test', profiles)
    expect(r.profile?.id).toBe('1')
    expect(r.strippedContent).toBe('run test')
  })

  it('returns ambiguous matches', () => {
    const r = resolveWorkDirFromFeishuCommand('/sa @Space run', profiles)
    expect(r.ambiguous?.length).toBe(2)
  })

  it('builds disambiguation reply', () => {
    expect(buildDisambiguationReply(profiles)).toContain('1)')
  })
})
