import { describe, expect, it } from 'vitest'
import { appendMessage, createSession, getSessionMessageRevisionSnapshot } from '../../../database/operations'
import { getDbConnection } from '../../../database/sqliteStore'
import { createTempDatabase } from '../../../database/testHelpers'
import { readContextHistorySummaryInWorker, summarizeContextHistoryRowsInWorker } from './contextHistorySummaryWorker'

describe('context history summary worker', () => {
  it('estimates complete lightweight rows off the main thread', async () => {
    const result = await summarizeContextHistoryRowsInWorker([
      { id: 'image', role: 'user', thinking: null, attachments: JSON.stringify([
        { id: 'image-file', stagingKey: 'chat-attachments/image.png', fileName: 'image.png', mimeType: 'image/png', byteLength: 4096, width: 512, height: 512 }
      ]), sequence: 1 },
      { id: 'thinking', role: 'assistant', thinking: JSON.stringify({ content: 'reasoning text', isVisible: true }), attachments: null, sequence: 2 },
      { id: 'plain', role: 'user', thinking: null, attachments: null, sequence: 3 }
    ])

    expect(result.workerThreadId).toBeGreaterThan(0)
    expect(result.entries).toEqual([
      { messageId: 'image', role: 'user', imageTokens: 400, thinkingTokens: 0, sequence: 1 },
      { messageId: 'thinking', role: 'assistant', imageTokens: 0, thinkingTokens: 4, sequence: 2 }
    ])
  })

  it('reads the revision-fenced lightweight SQLite snapshot on a worker thread', async () => {
    const temporary = createTempDatabase('context-history-summary-worker-')
    try {
      const session = createSession(temporary.db, { name: 'worker summary source' })
      appendMessage(temporary.db, { id: 'worker-image', sessionId: session.id, role: 'user', content: 'omitted', timestamp: 1,
        status: 'sent', attachments: [{ id: 'image-file', stagingKey: 'chat-attachments/image.png', fileName: 'image.png', mimeType: 'image/png', byteLength: 4096, width: 512, height: 512 }] })
      const source = getSessionMessageRevisionSnapshot(temporary.db, session.id)!
      const result = await readContextHistorySummaryInWorker({ dbPath: temporary.dbPath, sessionId: session.id,
        expectedGeneration: source.generation, expectedMessageRevision: source.messageRevision })
      expect(result.workerThreadId).toBeGreaterThan(0)
      expect(result.entries).toEqual([{ messageId: 'worker-image', role: 'user', imageTokens: 400, thinkingTokens: 0, sequence: 0 }])
      appendMessage(temporary.db, { id: 'worker-new-row', sessionId: session.id, role: 'assistant', content: 'new', timestamp: 2, status: 'completed' })
      await expect(readContextHistorySummaryInWorker({ dbPath: temporary.dbPath, sessionId: session.id,
        expectedGeneration: source.generation, expectedMessageRevision: source.messageRevision }))
        .rejects.toThrow('CONTEXT_HISTORY_SUMMARY_SOURCE_CHANGED')
    } finally { temporary.cleanup() }
  })

  it('rejects a damaged thinking payload without returning a partial summary', async () => {
    const temporary = createTempDatabase('context-history-summary-damaged-')
    try {
      const session = createSession(temporary.db, { name: 'damaged worker source' })
      appendMessage(temporary.db, { id: 'damaged-thinking', sessionId: session.id, role: 'assistant', content: 'omitted', timestamp: 1,
        status: 'completed', thinking: { content: 'valid before damage', isVisible: true, startTime: 1 } })
      getDbConnection(temporary.db).prepare('UPDATE messages SET thinking=? WHERE session_id=? AND id=?')
        .run('{invalid', session.id, 'damaged-thinking')
      const source = getSessionMessageRevisionSnapshot(temporary.db, session.id)!

      await expect(readContextHistorySummaryInWorker({ dbPath: temporary.dbPath, sessionId: session.id,
        expectedGeneration: source.generation, expectedMessageRevision: source.messageRevision })).rejects.toThrow()
    } finally { temporary.cleanup() }
  })
})
