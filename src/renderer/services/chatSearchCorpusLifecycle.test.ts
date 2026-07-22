import { describe, expect, it, vi } from 'vitest'
import {
  shouldClearSearchCorpus,
  shouldReloadSearchCorpus
} from './chatSearchCorpusLifecycle'

describe('search corpus lifecycle gate', () => {
  it('reloads only when session changes while panel open, not on query', () => {
    expect(
      shouldReloadSearchCorpus({
        active: true,
        isOpen: true,
        sessionId: 's1',
        loadedSessionId: null
      })
    ).toBe(true)

    expect(
      shouldReloadSearchCorpus({
        active: true,
        isOpen: true,
        sessionId: 's1',
        loadedSessionId: 's1'
      })
    ).toBe(false)

    expect(
      shouldReloadSearchCorpus({
        active: true,
        isOpen: true,
        sessionId: 's2',
        loadedSessionId: 's1'
      })
    ).toBe(true)
  })

  it('clears when panel closes', () => {
    expect(
      shouldClearSearchCorpus({ active: true, isOpen: false, sessionId: 's1' })
    ).toBe(true)
  })
})

describe('corpus IPC once per panel open', () => {
  it('multiple query changes do not multiply loadSessionSearchCorpus calls', async () => {
    const { loadSessionSearchCorpus } = await import('./chatSearchCorpus')
    const fetcher = vi.fn().mockResolvedValue({
      entries: [
        {
          message: {
            id: 'm0',
            sessionId: 's1',
            role: 'user',
            content: 'a',
            timestamp: 1,
            status: 'sent',
            schemaVersion: 1
          },
          sequence: 0
        }
      ],
      nextSequence: 1,
      hasMore: false
    })

    let loadedSessionId: string | null = null
    const loadIfNeeded = async (sessionId: string) => {
      if (
        !shouldReloadSearchCorpus({
          active: true,
          isOpen: true,
          sessionId,
          loadedSessionId
        })
      ) {
        return
      }
      await loadSessionSearchCorpus(sessionId, fetcher)
      loadedSessionId = sessionId
    }

    await loadIfNeeded('s1')
    await loadIfNeeded('s1')
    await loadIfNeeded('s1')
    await loadIfNeeded('s1')

    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
