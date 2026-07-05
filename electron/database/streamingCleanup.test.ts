import { describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'
import { appendMessage, createSession } from './operations'
import { createMemoryAppDb } from './testHelpers'
import { cleanupStreamingResiduesOnStartup } from './streamingCleanup'
import { getMessages } from './index'

describe('cleanupStreamingResiduesOnStartup', () => {
  it('14: downgrades streaming assistant and in-progress toolCalls', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'test' })
    const msgId = randomUUID()
    appendMessage(db, {
      id: msgId,
      sessionId: session.id,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      status: 'streaming',
      toolCalls: [
        {
          id: 'toolu_x',
          toolName: 'read_file',
          input: { path: 'a.txt' },
          status: 'calling',
          riskLevel: 'low',
          startedAt: Date.now()
        }
      ]
    })

    const fixed = cleanupStreamingResiduesOnStartup(db)
    expect(fixed).toBe(1)

    const messages = getMessages(db, session.id)
    const msg = messages.find((m) => m.id === msgId)
    expect(msg?.status).toBe('failed')
    expect(msg?.toolCalls?.[0]?.status).toBe('failed')
    expect(msg?.toolCalls?.[0]?.interrupted).toBe(true)
    expect(msg?.toolCalls?.[0]?.result).toEqual({
      success: false,
      error: '工具调用因应用退出中断'
    })
    expect(msg?.toolCalls?.[0]?.completedAt).toBeTypeOf('number')
  })

  it('returns 0 when no streaming messages exist', () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'test' })
    appendMessage(db, {
      id: randomUUID(),
      sessionId: session.id,
      role: 'assistant',
      content: 'done',
      timestamp: Date.now(),
      status: 'completed'
    })
    expect(cleanupStreamingResiduesOnStartup(db)).toBe(0)
  })
})
