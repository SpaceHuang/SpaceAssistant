import { describe, expect, it, vi } from 'vitest'
import { createStorageSessionContextAdapter } from './contextAdapter'

describe('storage session context adapter', () => {
  it('reads its initial capture through the prepared API baseline capability', async () => {
    const events: string[] = []
    const ensureChatBodyV1 = vi.fn(async () => { events.push('ensure'); return { sourceIdentityJson: 'fresh' } })
    const readPreparedApiBaseline = vi.fn(async () => { events.push('prepared-baseline'); return { sessionId: 'context-session', entries: [] } })

    const bound = await createStorageSessionContextAdapter({
      sessionId: 'context-session', session: { id: 'context-session', createdAt: 1 },
      queries: { readApiBaseline: vi.fn(() => { events.push('authority-baseline'); return { sessionId: 'context-session', entries: [] } }),
        readPreparedApiBaseline } as never,
      ensureChatBodyV1, workDir: '/tmp', userDataDir: '/tmp', replay: { committed: [] } as never,
      sink: {} as never, commitCanonicalCompaction: vi.fn(async () => undefined), isBusy: () => false
    })

    expect(bound.messages).toEqual([])
    expect(events).toEqual(['ensure', 'prepared-baseline'])
    expect(readPreparedApiBaseline).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'context-session', limit: 500 }))
  })
})
