import { describe, expect, it } from 'vitest'
import type { Session } from './domainTypes'
import {
  pickRemoteSessionCandidate,
  readRemoteSessionIdleMinutes,
  resolveActivityAt
} from './remoteSessionResolve'

function makeSession(over: Partial<Session> & { id: string }): Session {
  return {
    id: over.id,
    name: over.name ?? 'S',
    model: 'm',
    createdAt: over.createdAt ?? 1,
    updatedAt: over.updatedAt ?? 1,
    metadata: over.metadata ?? {},
    schemaVersion: 1
  }
}

describe('remoteSessionResolve', () => {
  it('readRemoteSessionIdleMinutes prefers new field and falls back', () => {
    expect(readRemoteSessionIdleMinutes({ remoteSessionIdleMinutes: 5 })).toBe(5)
    expect(readRemoteSessionIdleMinutes({ remoteSessionMergeMinutes: 7 })).toBe(7)
    expect(readRemoteSessionIdleMinutes({})).toBe(10)
    expect(readRemoteSessionIdleMinutes({ remoteSessionIdleMinutes: 0 })).toBe(0)
  })

  it('resolveActivityAt falls back to updatedAt', () => {
    const s = makeSession({ id: 'a', updatedAt: 42 })
    expect(resolveActivityAt(s)).toBe(42)
    s.metadata = { remoteSessionLastActivityAt: 99 }
    expect(resolveActivityAt(s)).toBe(99)
  })

  it('pickRemoteSessionCandidate sorts by newer activity', () => {
    const sessions = [
      makeSession({
        id: 'old',
        createdAt: 1,
        metadata: { source: 'feishu', feishuChatId: 'c1', remoteSessionLastActivityAt: 100 }
      }),
      makeSession({
        id: 'new',
        createdAt: 2,
        metadata: { source: 'feishu', feishuChatId: 'c1', remoteSessionLastActivityAt: 200 }
      })
    ]
    const picked = pickRemoteSessionCandidate(sessions, 'feishu', 'c1', (s) =>
      (s.metadata as { feishuChatId?: string }).feishuChatId
    )
    expect(picked?.id).toBe('new')
  })
})
