import { describe, expect, it } from 'vitest'
import type { Message } from '../../shared/domainTypes'
import {
  loadSessionSearchCorpus,
  mergeSearchCorpusWithLive
} from './chatSearchCorpus'
import { searchChatMessageEntries } from './chatStructuredSearchAdapter'

function msg(partial: Partial<Message> & Pick<Message, 'id' | 'content'>): Message {
  return {
    sessionId: 's1',
    role: 'user',
    timestamp: 1,
    status: 'sent',
    schemaVersion: 1,
    ...partial
  }
}

describe('chatSearchCorpus', () => {
  it('loads full corpus across pages and finds match before latest display window', async () => {
    const all = Array.from({ length: 120 }, (_, i) => ({
      message: msg({
        id: `m${i}`,
        content: i === 5 ? 'needle-early' : `c${i}`
      }),
      sequence: i
    }))

    const corpus = await loadSessionSearchCorpus('s1', async ({ fromSequence = 0, limit = 200 }) => {
      const slice = all.filter((e) => e.sequence >= fromSequence).slice(0, limit)
      const hasMore = all.some((e) => e.sequence >= (slice.at(-1)?.sequence ?? fromSequence) + 1)
      return {
        entries: slice,
        nextSequence: slice.length ? slice[slice.length - 1]!.sequence + 1 : fromSequence,
        hasMore: hasMore && slice.length === limit
      }
    })

    // 展示仅最新 60
    const displayOnly = corpus.slice(-60)
    const displaySearch = searchChatMessageEntries(displayOnly, 'needle-early', {
      caseSensitive: false,
      wholeWord: false,
      useRegex: false
    })
    expect(displaySearch.matches).toHaveLength(0)

    const fullSearch = searchChatMessageEntries(corpus, 'needle-early', {
      caseSensitive: false,
      wholeWord: false,
      useRegex: false
    })
    expect(fullSearch.matches).toHaveLength(1)
    expect(fullSearch.matches[0]?.messageId).toBe('m5')
    expect(fullSearch.matches[0]?.order).toEqual({ kind: 'persisted', sequence: 5 })
  })

  it('live overlay replaces same id and keeps optimistic after persisted', () => {
    const db = [
      {
        message: msg({ id: 'm1', content: 'old' }),
        order: { kind: 'persisted' as const, sequence: 1 }
      }
    ]
    const live = [
      {
        message: msg({ id: 'm1', content: 'new' }),
        order: { kind: 'persisted' as const, sequence: 1 }
      },
      {
        message: msg({ id: 'm2', content: 'opt' }),
        order: { kind: 'optimistic' as const, ordinal: 0 }
      }
    ]
    const merged = mergeSearchCorpusWithLive(db, live)
    expect(merged.map((e) => e.message.content)).toEqual(['new', 'opt'])
  })
})
