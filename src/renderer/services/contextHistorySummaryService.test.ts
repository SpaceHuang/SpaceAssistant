import { describe, expect, it, beforeEach } from 'vitest'
import type { Message } from '../../shared/domainTypes'
import {
  ackContextSummaryPersisted,
  applyContextSummaryDbBaseline,
  beginContextSummarySession,
  resetContextHistorySummaryForTest,
  selectContextSummaryScalars,
  summarizeContextMessage,
  upsertContextSummaryOverride
} from './contextHistorySummaryService'

function assistant(id: string, thinkingTokensContent: string | null): Message {
  return {
    id,
    sessionId: 's1',
    role: 'assistant',
    content: 'a',
    timestamp: 1,
    status: 'completed',
    schemaVersion: 1,
    thinking: thinkingTokensContent
      ? {
          content: thinkingTokensContent,
          isVisible: true,
          startTime: 1,
          segments: [{ content: thinkingTokensContent, startTime: 1, endTime: 2 }]
        }
      : undefined
  }
}

describe('contextHistorySummaryService', () => {
  beforeEach(() => {
    resetContextHistorySummaryForTest()
  })

  it('picks last assistant with thinkingTokens > 0; later zero-thinking does not mask', () => {
    const gen = beginContextSummarySession('s1')
    applyContextSummaryDbBaseline('s1', gen, [
      {
        messageId: 'a1',
        role: 'assistant',
        imageTokens: 0,
        thinkingTokens: 40,
        sequence: 1
      }
    ])
    upsertContextSummaryOverride(
      's1',
      summarizeContextMessage(assistant('a2', null), { kind: 'persisted', sequence: 2 })
    )
    const scalars = selectContextSummaryScalars('s1')
    expect(scalars.thinkingTokensToExclude).toBe(40)
  })

  it('same-id zero override removes thinking candidate', () => {
    const gen = beginContextSummarySession('s1')
    applyContextSummaryDbBaseline('s1', gen, [
      {
        messageId: 'a1',
        role: 'assistant',
        imageTokens: 0,
        thinkingTokens: 40,
        sequence: 1
      }
    ])
    upsertContextSummaryOverride('s1', {
      messageId: 'a1',
      role: 'assistant',
      imageTokens: 0,
      thinkingTokens: 0,
      order: { kind: 'persisted', sequence: 1 }
    })
    expect(selectContextSummaryScalars('s1').thinkingTokensToExclude).toBe(0)
  })

  it('counts optimistic image tokens before ack and keeps thinking across ack reorder', () => {
    beginContextSummarySession('s1')
    const user: Message = {
      id: 'u1',
      sessionId: 's1',
      role: 'user',
      content: 'hi',
      timestamp: 1,
      status: 'sent',
      schemaVersion: 1,
      attachments: [
        {
          id: 'i',
          fileName: 'a.png',
          mimeType: 'image/png',
          stagingKey: 'chat-attachments/s1/a.png',
          byteLength: 4000,
          width: 512,
          height: 512
        }
      ]
    }
    upsertContextSummaryOverride(
      's1',
      summarizeContextMessage(user, { kind: 'optimistic', ordinal: 0 })
    )
    const before = selectContextSummaryScalars('s1')
    expect(before.historyImageTokens).toBeGreaterThan(0)

    upsertContextSummaryOverride(
      's1',
      summarizeContextMessage(assistant('a1', 'think hard'), { kind: 'optimistic', ordinal: 1 })
    )
    ackContextSummaryPersisted('s1', 'a1', 10)
    ackContextSummaryPersisted('s1', 'u1', 9)
    const after = selectContextSummaryScalars('s1')
    expect(after.historyImageTokens).toBe(before.historyImageTokens)
    expect(after.thinkingTokensToExclude).toBeGreaterThan(0)
  })
})
