import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendMessage, createSession } from '../database/operations'
import { createTempDatabase } from '../database/testHelpers'

const { readContextHistorySummaryInWorker, summarizeContextHistoryRowsInWorker } = vi.hoisted(() => ({
  readContextHistorySummaryInWorker: vi.fn(),
  summarizeContextHistoryRowsInWorker: vi.fn()
}))

vi.mock('./infrastructure/sqlite/contextHistorySummaryWorker', () => ({
  readContextHistorySummaryInWorker,
  summarizeContextHistoryRowsInWorker
}))

import { createSessionQueries } from './queries'

describe('context history summary source fencing', () => {
  let cleanup: (() => void) | undefined

  afterEach(() => {
    cleanup?.()
    cleanup = undefined
    vi.clearAllMocks()
  })

  it('discards a completed worker result when the source revision changed and retries once', async () => {
    const temporary = createTempDatabase('context-summary-query-fence-')
    cleanup = temporary.cleanup
    const session = createSession(temporary.db, { name: 'summary revision fence' })
    appendMessage(temporary.db, { id: 'summary-initial', sessionId: session.id, role: 'user', content: 'initial', timestamp: 1, status: 'sent' })
    let attempt = 0
    readContextHistorySummaryInWorker.mockImplementation(async ({ expectedGeneration, expectedMessageRevision }) => {
      attempt += 1
      if (attempt === 1) {
        appendMessage(temporary.db, { id: 'summary-after-worker-start', sessionId: session.id, role: 'user', content: 'new source', timestamp: 2, status: 'sent' })
      }
      return { entries: [{ messageId: `worker-${attempt}`, role: 'user', imageTokens: 1, thinkingTokens: 0, sequence: attempt }],
        workerThreadId: 2, generation: expectedGeneration, messageRevision: expectedMessageRevision }
    })

    const queries = createSessionQueries(temporary.db)
    const baseline = await queries.readContextHistorySummaryBaseline(session.id)
    const cachedBaseline = await queries.readContextHistorySummaryBaseline(session.id)

    expect(readContextHistorySummaryInWorker).toHaveBeenCalledTimes(2)
    expect(baseline.entries).toEqual([{ messageId: 'worker-2', role: 'user', imageTokens: 1, thinkingTokens: 0, sequence: 2 }])
    expect(cachedBaseline).toEqual(baseline)
  })

  it('shares one worker read for concurrent misses at the same source revision', async () => {
    const temporary = createTempDatabase('context-summary-query-inflight-')
    cleanup = temporary.cleanup
    const session = createSession(temporary.db, { name: 'summary in-flight coalescing' })
    appendMessage(temporary.db, { id: 'summary-inflight-source', sessionId: session.id, role: 'user', content: 'source', timestamp: 1, status: 'sent' })
    let finishWorker!: (value: { entries: []; workerThreadId: number; generation: string; messageRevision: number }) => void
    readContextHistorySummaryInWorker.mockImplementation(({ expectedGeneration, expectedMessageRevision }) =>
      new Promise((resolve) => { finishWorker = resolve }).then((value) => ({ ...value, generation: expectedGeneration, messageRevision: expectedMessageRevision })))
    const queries = createSessionQueries(temporary.db)

    const first = queries.readContextHistorySummaryBaseline(session.id)
    const second = queries.readContextHistorySummaryBaseline(session.id)
    await Promise.resolve()

    expect(readContextHistorySummaryInWorker).toHaveBeenCalledTimes(1)
    finishWorker({ entries: [], workerThreadId: 2, generation: '', messageRevision: 0 })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { sessionId: session.id, entries: [] }, { sessionId: session.id, entries: [] }
    ])
  })
})
