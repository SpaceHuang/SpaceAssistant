import { describe, expect, it, vi } from 'vitest'
import { createSession, getMessage, prepareTurnAtomically } from '../database/operations'
import { createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { createSessionExecutionStore } from './execution'
import type { SessionQueries } from './public/ports'
import type { PreparedChatBodyView } from './public/model'

describe('prepared accepted-input receipt validation', () => {
  it('rejects a duplicate receipt without replaying body-bearing History events', async () => {
    const temp = createTempDatabase('prepared-accepted-input-receipt-')
    const { db } = temp
    try {
      const sessionId = createSession(db, { name: 'prepared receipt' }).id
      prepareTurnAtomically(db, {
        user: { id: 'prepared-receipt-user', sessionId, role: 'user', content: 'accepted input', timestamp: 1, status: 'sent' },
        assistant: { id: 'prepared-receipt-assistant', sessionId, role: 'assistant', content: '', timestamp: 2, status: 'streaming' },
        turn: { turnId: 'prepared-receipt-turn', requestId: 'prepared-receipt-request', sessionId,
          assistantMessageId: 'prepared-receipt-assistant', state: 'executing', startToken: 'prepared-receipt-token' }
      })
      const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, sessionId)
      const receipt = history.readSync('prepared-receipt-turn').events[0]!
      await history.appendBatch([{ ...receipt, sequence: 2, eventId: 'duplicate-receipt', idempotencyKey: 'duplicate-receipt' }], 1)

      const preparedView = { sessionId, sessionGeneration: '1', sourceIdentityJson: '{}' } as PreparedChatBodyView
      const queries = {
        readPreparedTurnContext: vi.fn(async () => [getMessage(db, 'prepared-receipt-user')!]),
        isPreparedViewCurrent: vi.fn(() => true)
      } as unknown as SessionQueries
      const execution = createSessionExecutionStore(db, queries, { ensureChatBodyV1: async () => preparedView })
      const fullHistoryRead = vi.spyOn(SqliteAgentHistory.prototype, 'readSync')

      try {
        await expect(execution.loadAcceptedMessagesAsync({ sessionId, turnId: 'prepared-receipt-turn' }))
          .rejects.toThrow('TURN_USER_INPUT_FINGERPRINT_MISMATCH')
        expect(fullHistoryRead).not.toHaveBeenCalled()
        expect(queries.readPreparedTurnContext).toHaveBeenCalledTimes(1)
      } finally {
        fullHistoryRead.mockRestore()
      }
    } finally {
      temp.cleanup()
    }
  })
})
