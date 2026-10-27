import { describe, expect, it, vi } from 'vitest'
import { prepareChatBodiesForSessions, readApiBaselineAfterPreparation, readChatMessageAfterPreparation, readChatMessagesAfterPreparation, readChatPageAfterPreparation, readSearchCorpusPageAfterPreparation, readExportPageAfterPreparation, readRetryTargetAfterPreparation } from './readChatMessages'
import { createSessionSwitchTrace } from '../public/readMessages'

describe('readChatMessagesAfterPreparation', () => {
  it('prepares the chat body view and reruns the complete synchronous selection', async () => {
    const events: string[] = []
    const messages = [{ id: 'selected-after-ensure' }]
    const result = await readChatMessagesAfterPreparation({
      ensureChatBodyV1: async ({ sessionId }) => { events.push(`ensure:${sessionId}`); return [{ id: 'discard-preparation-payload' }] },
      queries: { readMessages: (input) => { events.push(`select:${input.sessionId}`); return messages as never } }
    }, { sessionId: 'chat-session', limit: 20, offset: 3 })

    expect(result).toBe(messages)
    expect(events).toEqual(['ensure:chat-session', 'select:chat-session'])
  })

  it('uses the freshly validated prepared cache query after preparation', async () => {
    const events: string[] = []
    const prepared = [{ id: 'fresh-body', content: 'cache body' }]
    const result = await readChatMessagesAfterPreparation({
      ensureChatBodyV1: async () => { events.push('ensure'); return prepared },
      queries: {
        readMessages: () => { events.push('legacy-read'); return [] as never },
        readPreparedMessages: (input) => { events.push(`prepared-read:${input.sessionId}`); expect(input.prepared).toBe(prepared); return prepared as never }
      }
    }, { sessionId: 'prepared-session', limit: 20 })
    expect(result).toBe(prepared)
    expect(events).toEqual(['ensure', 'prepared-read:prepared-session'])
  })

  it('falls back to the authority reader when the prepared cache misses at selection time', async () => {
    const events: string[] = []
    const messages = [{ id: 'authority', content: 'history checked' }]
    const result = await readChatMessagesAfterPreparation({
      ensureChatBodyV1: async () => { events.push('ensure'); return [] },
      queries: {
        readMessages: () => { events.push('legacy-read'); return messages as never },
        readPreparedMessages: () => { events.push('cache-miss'); return undefined }
      }
    }, { sessionId: 'cache-miss-session' })
    expect(result).toBe(messages)
    expect(events).toEqual(['ensure', 'cache-miss', 'legacy-read'])
  })

  it('falls back to the authoritative message reader when projection preparation is unavailable', async () => {
    const events: string[] = []
    const messages = [{ id: 'canonical-reader-result' }]
    const result = await readChatMessagesAfterPreparation({
      ensureChatBodyV1: async () => { events.push('ensure'); throw new Error('PROJECTION_PREPARATION_DEFERRED_LARGE') },
      queries: { readMessages: () => { events.push('read'); return messages as never } },
    }, { sessionId: 'large-session' })

    expect(result).toBe(messages)
    expect(events).toEqual(['ensure', 'read'])
  })

  it('falls back for a single canonical message and preserves non-projection failures', async () => {
    const message = { id: 'canonical-message' }
    await expect(readChatMessageAfterPreparation({
      ensureChatBodyV1: async () => { throw new Error('PROJECTION_BUILD_DEFERRED:DEFERRED_LARGE') },
      queries: { readMessage: () => message },
    }, { sessionId: 'large-session', messageId: message.id })).resolves.toBe(message)

    const failure = new Error('PROJECTION_VIEW_CANCELLED')
    await expect(readChatMessagesAfterPreparation({ ensureChatBodyV1: async () => { throw failure },
      queries: { readMessages: () => [] } }, { sessionId: 'cancelled-session' })).rejects.toBe(failure)
  })

  it('prepares before selecting one message body', async () => {
    const events: string[] = []
    const message = { id: 'm', role: 'user', content: 'body', timestamp: 1 }
    const storage = {
      ensureChatBodyV1: async ({ sessionId }: { sessionId: string }) => { events.push(`ensure:${sessionId}`) },
      queries: { readMessage: (input: { sessionId: string; messageId: string }) => { events.push(`select:${input.sessionId}:${input.messageId}`); return message } }
    } as never

    await expect(readChatMessageAfterPreparation(storage, { sessionId: 's', messageId: 'm' })).resolves.toBe(message)
    expect(events).toEqual(['ensure:s', 'select:s:m'])
  })

  it('uses a prepared single message body before falling back to authority', async () => {
    const events: string[] = []
    const message = { id: 'prepared-message', content: 'canonical body' }
    await expect(readChatMessageAfterPreparation({
      ensureChatBodyV1: async () => { events.push('ensure'); return 'view' },
      queries: {
        readPreparedMessage: async (input) => { events.push(`prepared:${input.messageId}:${input.prepared}`); return message as never },
        readMessage: () => { events.push('authority'); return undefined }
      }
    }, { sessionId: 's', messageId: 'prepared-message' })).resolves.toBe(message)
    expect(events).toEqual(['ensure', 'prepared:prepared-message:view'])
  })

  it('prepares each cross-session source once in stable order', async () => {
    const sessions: string[] = []
    await prepareChatBodiesForSessions({ ensureChatBodyV1: async ({ sessionId }) => { sessions.push(sessionId) } }, ['b', 'a', 'b'])
    expect(sessions).toEqual(['b', 'a'])
  })
})

describe('readChatPageAfterPreparation', () => {
  it('keeps the ready cache page ahead of cold source-locator discovery', async () => {
    const events: string[] = []
    const prepared = { view: 'ready' }
    const page = { entries: [], oldestSequence: null, hasMoreBefore: false }
    const result = await readChatPageAfterPreparation({
      readPreparedChatBodyV1: () => prepared,
      ensureChatBodyV1: async () => { events.push('ensure'); return undefined },
      queries: {
        readPreparedChatPage: async ({ prepared: view }) => { events.push('ready-page'); expect(view).toBe(prepared); return page },
        readSourceChatPage: async () => { events.push('source-page'); return undefined },
        readChatPage: () => { events.push('legacy'); return page }
      }
    }, { sessionId: 'ready-session' })
    expect(result).toBe(page)
    expect(events).toEqual(['ready-page'])
  })

  it('uses a complete source-locator page before waiting for projection preparation', async () => {
    const events: string[] = []
    const emit = vi.fn()
    const trace = createSessionSwitchTrace({ instance: 'main', traceId: 'cold-source-page', emit })
    const page = { entries: [{ sequence: 4, message: { id: 'cold-canonical', content: 'source body' } }], oldestSequence: 4, hasMoreBefore: true }
    let cachePath: 'ready' | 'prior-authority' | 'cold' | 'invalidated' = 'prior-authority'
    const result = await readChatPageAfterPreparation({
      ensureChatBodyV1: async () => { events.push('ensure'); throw new Error('must not wait for projection') },
      queries: {
        readSourceChatPage: async () => { events.push('source-page'); return page as never },
        readPreparedChatPage: async () => { events.push('prepared'); return undefined },
        readChatPage: () => { events.push('authority'); return { entries: [], oldestSequence: null, hasMoreBefore: false } }
      }
    }, { sessionId: 'cold-session', limit: 20 }, { trace, onCachePath: (value) => { cachePath = value } })
    trace.finish({ outcome: 'ok', cachePath, pageSize: page.entries.length })
    expect(cachePath).toBe('cold')
    expect(result).toBe(page)
    expect(events).toEqual(['source-page'])
    expect(emit.mock.calls[0]?.[0]?.stages).toEqual([{ name: 'source-page-read', durationMs: expect.any(Number), outcome: 'ok' }])
  })

  it('reselects once after a source revision changes during a cold page read', async () => {
    const events: string[] = []
    const page = { entries: [], oldestSequence: null, hasMoreBefore: false }
    let calls = 0
    const result = await readChatPageAfterPreparation({
      ensureChatBodyV1: async () => { throw new Error('projection preparation should not run') },
      queries: {
        readSourceChatPage: async () => {
          calls += 1
          events.push(`source:${calls}`)
          if (calls === 1) throw new Error('PROJECTION_SOURCE_REVISION_CHANGED')
          return page
        },
        readPreparedChatPage: async () => undefined,
        readChatPage: () => page
      }
    }, { sessionId: 'changed-source-session' })
    expect(result).toBe(page)
    expect(events).toEqual(['source:1', 'source:2'])
  })

  it('does not retry a drifting cold page more than once', async () => {
    const failure = new Error('PROJECTION_SOURCE_PAGE_CHANGED')
    const readSourceChatPage = vi.fn(async () => { throw failure })
    await expect(readChatPageAfterPreparation({
      ensureChatBodyV1: async () => { throw new Error('projection preparation should not run') },
      queries: { readSourceChatPage, readPreparedChatPage: async () => undefined,
        readChatPage: () => ({ entries: [], oldestSequence: null, hasMoreBefore: false }) }
    }, { sessionId: 'always-changing-source' })).rejects.toBe(failure)
    expect(readSourceChatPage).toHaveBeenCalledTimes(2)
  })

  it('passes the prepared view into sequence-page selection and uses the verified result', async () => {
    const events: string[] = []
    const prepared = { sourceIdentityJson: 'fresh-source' }
    const page = { entries: [{ sequence: 4, message: { id: 'canonical-page-body', content: 'body' } }], oldestSequence: 4, hasMoreBefore: true }
    const result = await readChatPageAfterPreparation({
      ensureChatBodyV1: async () => { events.push('ensure'); return prepared },
      queries: {
        readPreparedChatPage: async (input) => { events.push(`prepared:${input.beforeSequence ?? 'tail'}`); expect(input.prepared).toBe(prepared); return page as never },
        readChatPage: () => { events.push('authority'); return { entries: [], oldestSequence: null, hasMoreBefore: false } }
      }
    }, { sessionId: 'page-session', beforeSequence: 10, limit: 20 })
    expect(result).toBe(page)
    expect(events).toEqual(['ensure', 'prepared:10'])
  })

  it('falls back to the authority page reader when preparation or the prepared lookup misses', async () => {
    const events: string[] = []
    const page = { entries: [], oldestSequence: null, hasMoreBefore: false }
    const result = await readChatPageAfterPreparation({
      ensureChatBodyV1: async () => { events.push('ensure'); throw new Error('PROJECTION_PREPARATION_DEFERRED_LARGE') },
      queries: {
        readPreparedChatPage: async () => { events.push('prepared-miss'); return undefined },
        readChatPage: () => { events.push('authority'); return page }
      }
    }, { sessionId: 'large-page-session' })
    expect(result).toBe(page)
    expect(events).toEqual(['ensure', 'prepared-miss', 'authority'])
  })
})

describe('readApiBaselineAfterPreparation', () => {
  it('uses the prepared canonical bodies while preserving the latest-window query selection', async () => {
    const events: string[] = []
    const prepared = { sourceIdentityJson: 'api-source' }
    const baseline = { sessionId: 'api-session', entries: [{ sequence: 8, message: { id: 'api-body', content: 'canonical' } }] }
    const result = await readApiBaselineAfterPreparation({
      ensureChatBodyV1: async () => { events.push('ensure'); return prepared },
      queries: {
        readPreparedApiBaseline: async (input) => { events.push(`prepared:${input.limit}`); expect(input.prepared).toBe(prepared); return baseline as never },
        readApiBaseline: () => { events.push('authority'); return { sessionId: 'api-session', entries: [] } }
      }
    }, { sessionId: 'api-session', limit: 80 })
    expect(result).toBe(baseline)
    expect(events).toEqual(['ensure', 'prepared:80'])
  })

  it('falls back to the authority baseline when preparation is deferred or selection misses', async () => {
    const events: string[] = []
    const baseline = { sessionId: 'api-session', entries: [] }
    const result = await readApiBaselineAfterPreparation({
      ensureChatBodyV1: async () => { events.push('ensure'); throw new Error('PROJECTION_BUILD_DEFERRED:DEFERRED_LARGE') },
      queries: {
        readPreparedApiBaseline: async () => { events.push('prepared-miss'); return undefined },
        readApiBaseline: () => { events.push('authority'); return baseline }
      }
    }, { sessionId: 'api-session' })
    expect(result).toBe(baseline)
    expect(events).toEqual(['ensure', 'prepared-miss', 'authority'])
  })
})


describe('readSearchCorpusPageAfterPreparation', () => {
  it('passes the ASC cursor and page size to the prepared reader and preserves its cursor metadata', async () => {
    const events: string[] = []
    const prepared = { sourceIdentityJson: 'search-source' }
    const page = { entries: [{ sequence: 17, message: { id: 'search-body', content: 'canonical' } }], nextSequence: 18, hasMore: true }
    const result = await readSearchCorpusPageAfterPreparation({
      ensureChatBodyV1: async () => { events.push('ensure'); return prepared },
      queries: {
        readPreparedSearchCorpusPage: async (input) => { events.push(`prepared:${input.fromSequence}:${input.pageSize}`); expect(input.prepared).toBe(prepared); return page as never },
        readSearchCorpusPage: () => { events.push('authority'); return { entries: [], nextSequence: 0, hasMore: false } }
      }
    }, { sessionId: 'search-session', fromSequence: 17, pageSize: 50 })
    expect(result).toBe(page)
    expect(events).toEqual(['ensure', 'prepared:17:50'])
  })
})

describe('readExportPageAfterPreparation', () => {
  it('forwards cancellation to the prepared export worker reader', async () => {
    const controller = new AbortController()
    const page = { rows: [], nextSequence: 0 }
    const readPreparedExportPage = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      expect(signal).toBe(controller.signal)
      return page as never
    })
    await expect(readExportPageAfterPreparation({ ensureChatBodyV1: async () => 'prepared',
      queries: { readPreparedExportPage, readExportPage: () => page } },
    { sessionId: 'export-session', fromSequence: 0, pageSize: 25, signal: controller.signal })).resolves.toBe(page)
    expect(readPreparedExportPage).toHaveBeenCalledOnce()
  })

  it('prepares each cursor page and preserves authority paging when the cache reader misses', async () => {
    const events: string[] = []
    const page = { rows: [{ sequence: 22, message: { id: 'export-row', content: 'body' } }], nextSequence: 23 }
    const result = await readExportPageAfterPreparation({
      ensureChatBodyV1: async () => { events.push('ensure'); return 'prepared' },
      queries: {
        readPreparedExportPage: async ({ fromSequence, pageSize, prepared }) => { events.push(`prepared:${fromSequence}:${pageSize}:${prepared}`); return page as never },
        readExportPage: () => { events.push('authority'); return { rows: [], nextSequence: 0 } }
      }
    }, { sessionId: 'export-session', fromSequence: 22, pageSize: 25 })
    expect(result).toBe(page)
    expect(events).toEqual(['ensure', 'prepared:22:25:prepared'])
  })
})

describe('readRetryTargetAfterPreparation', () => {
  it('uses the prepared retry target and falls back after a selection miss', async () => {
    const events: string[] = []
    const target = { failedAssistant: { message: { id: 'failed' } }, currentUser: { message: { id: 'user' } }, excludeMessageIds: [] }
    const preparedResult = await readRetryTargetAfterPreparation({
      ensureChatBodyV1: async () => { events.push('ensure'); return 'prepared' },
      queries: {
        readPreparedRetryTarget: async (input) => { events.push(`prepared:${input.failedAssistantMessageId}:${input.prepared}`); return target as never },
        readRetryTarget: () => { events.push('authority'); return null },
        readLatestRetryTarget: () => null
      }
    }, { sessionId: 'retry-session', failedAssistantMessageId: 'failed' })
    expect(preparedResult).toBe(target)
    expect(events).toEqual(['ensure', 'prepared:failed:prepared'])

    await expect(readRetryTargetAfterPreparation({ ensureChatBodyV1: async () => undefined,
      queries: { readPreparedRetryTarget: async () => undefined, readRetryTarget: () => null, readLatestRetryTarget: () => target as never } },
    { sessionId: 'retry-session' })).resolves.toBe(target)
  })
})
