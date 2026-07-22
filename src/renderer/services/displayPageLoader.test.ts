import { describe, expect, it, vi } from 'vitest'
import type { Message } from '../../shared/domainTypes'
import { ensureDisplayContainsMessage, loadPreviousDisplayPage } from './displayPageLoader'

function msg(id: string, sessionId = 's1'): Message {
  return {
    id,
    sessionId,
    role: 'user',
    content: id,
    timestamp: 1,
    status: 'sent',
    schemaVersion: 1
  }
}

describe('displayPageLoader', () => {
  it('loadPreviousDisplayPage reads beforeSequence from latest getState each call', async () => {
    let oldest = 180
    let hasMore = true
    const fetched: number[] = []

    const load = () =>
      loadPreviousDisplayPage({
        sessionId: 's1',
        getState: () => ({
          currentSessionId: 's1',
          hasMoreBefore: hasMore,
          oldestSequence: oldest,
          loadingBefore: false,
          displayGeneration: 1
        }),
        fetchPage: async ({ beforeSequence }) => {
          fetched.push(beforeSequence)
          const start = beforeSequence - 60
          const entries = Array.from({ length: 60 }, (_, i) => ({
            message: msg(`m${start + i}`),
            sequence: start + i
          }))
          oldest = start
          hasMore = start > 0
          return {
            entries,
            oldestSequence: start,
            hasMoreBefore: hasMore
          }
        },
        setLoading: () => {},
        prepend: () => {}
      })

    await load()
    await load()
    await load()

    expect(fetched).toEqual([180, 120, 60])
    expect(fetched[0]).toBeGreaterThan(fetched[1]!)
    expect(fetched[1]).toBeGreaterThan(fetched[2]!)
  })

  it('ensureDisplayContainsMessage loads until third page target is found', async () => {
    // 展示最新页 m120..m179；目标 m10 在第三页更早
    let loaded = Array.from({ length: 60 }, (_, i) => msg(`m${120 + i}`))
    let oldest = 120
    let hasMore = true
    const beforeSequences: number[] = []

    const result = await ensureDisplayContainsMessage({
      sessionId: 's1',
      messageId: 'm10',
      getMessages: () => loaded,
      getState: () => ({
        currentSessionId: 's1',
        hasMoreBefore: hasMore,
        oldestSequence: oldest,
        loadingBefore: false,
        displayGeneration: 1
      }),
      loadPrevious: async () => {
        const r = await loadPreviousDisplayPage({
          sessionId: 's1',
          getState: () => ({
            currentSessionId: 's1',
            hasMoreBefore: hasMore,
            oldestSequence: oldest,
            loadingBefore: false,
            displayGeneration: 1
          }),
          fetchPage: async ({ beforeSequence }) => {
            beforeSequences.push(beforeSequence)
            const start = Math.max(0, beforeSequence - 60)
            const entries = Array.from({ length: beforeSequence - start }, (_, i) => ({
              message: msg(`m${start + i}`),
              sequence: start + i
            }))
            loaded = [...entries.map((e) => e.message), ...loaded]
            oldest = start
            hasMore = start > 0
            return {
              entries,
              oldestSequence: start,
              hasMoreBefore: hasMore
            }
          },
          setLoading: () => {},
          prepend: () => {}
        })
        return r
      }
    })

    expect(result.found).toBe(true)
    expect(beforeSequences.length).toBeGreaterThanOrEqual(2)
    expect(beforeSequences.every((v, i) => i === 0 || v < beforeSequences[i - 1]!)).toBe(true)
    expect(loaded.some((m) => m.id === 'm10')).toBe(true)
  })
})
