import { describe, expect, it } from 'vitest'
import { groupSessionsByTime } from './groupSessions'
import type { Session } from '../../shared/domainTypes'

function session(id: string, updatedAt: number): Session {
  return {
    id,
    name: id,
    preview: '',
    model: 'm',
    temperature: 0.7,
    maxTokens: 4096,
    createdAt: updatedAt,
    updatedAt,
    messageCount: 0,
    skillsState: { manualActivated: [], manualDisabled: [] },
    metadata: {},
    schemaVersion: 1
  }
}

describe('groupSessionsByTime', () => {
  it('groups sessions into time buckets', () => {
    const now = Date.now()
    const groups = groupSessionsByTime([
      session('today', now),
      session('old', now - 10 * 86400000)
    ])
    expect(groups.some((g) => g.label === '今天' && g.sessions.some((s) => s.id === 'today'))).toBe(true)
    expect(groups.some((g) => g.label === '更早' && g.sessions.some((s) => s.id === 'old'))).toBe(true)
  })
})
