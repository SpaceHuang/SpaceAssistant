import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../shared/domainTypes'
import {
  ackApiContextMessagePersisted,
  buildHistoryForApiFromEntries,
  mergeApiContextBaselineWithOverlay,
  resetApiContextServiceForTest,
  resolveSessionContextForApi,
  routeAddApiContextMessage,
  routePatchApiContextMessage
} from './apiContextService'
import type { ApiContextBaseline } from '../../shared/displayOrder'

function msg(partial: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message {
  return {
    sessionId: 's1',
    timestamp: 1,
    status: partial.role === 'user' ? 'sent' : 'completed',
    schemaVersion: 1,
    ...partial
  }
}

describe('apiContext queue and retry', () => {
  beforeEach(() => {
    resetApiContextServiceForTest()
  })

  it('queued -> sent gateway then required user appears exactly once', async () => {
    const baseline: ApiContextBaseline = {
      sessionId: 's1',
      entries: Array.from({ length: 500 }, (_, i) => ({
        message: msg({
          id: `m${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `c${i}`,
          status: i % 2 === 0 ? 'sent' : 'completed'
        }),
        sequence: i
      }))
    }
    const queued = msg({
      id: 'q-user',
      role: 'user',
      content: 'queued text',
      status: 'queued',
      attachments: [{ id: 'img1', fileName: 'a.png', mimeType: 'image/png', relPath: 'a.png', byteSize: 10 }]
    })
    routeAddApiContextMessage({
      message: queued,
      order: { kind: 'persisted', sequence: 998 }
    })
    // gateway: patch to sent
    routePatchApiContextMessage('s1', 'q-user', { status: 'sent' })
    const sent = { ...queued, status: 'sent' as const }

    const { historyForApi, requiredCurrentUserId } = await resolveSessionContextForApi(
      {
        sessionId: 's1',
        requiredCurrentUser: {
          message: sent,
          order: { kind: 'persisted', sequence: 998 }
        }
      },
      async () => baseline
    )

    expect(requiredCurrentUserId).toBe('q-user')
    expect(historyForApi.filter((m) => m.id === 'q-user')).toHaveLength(1)
    expect(historyForApi.find((m) => m.id === 'q-user')?.attachments?.[0]?.fileName).toBe('a.png')
  })

  it('retry excludes failed assistant and includes target user outside baseline', () => {
    const baseline: ApiContextBaseline = {
      sessionId: 's1',
      entries: Array.from({ length: 500 }, (_, i) => ({
        message: msg({
          id: `m${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `c${i}`,
          status: i % 2 === 0 ? 'sent' : 'completed'
        }),
        sequence: i
      }))
    }
    const user = msg({ id: 'u998', role: 'user', content: 'retry me', status: 'sent' })
    const failed = msg({
      id: 'a999',
      role: 'assistant',
      content: 'broken',
      status: 'failed',
      toolCalls: [{ id: 't1', toolName: 'x', input: {}, status: 'calling', riskLevel: 'low' }]
    })
    const overlay = [
      { message: user, order: { kind: 'persisted' as const, sequence: 998 } },
      { message: failed, order: { kind: 'persisted' as const, sequence: 999 } }
    ]
    const merged = mergeApiContextBaselineWithOverlay(baseline, overlay)
    const history = buildHistoryForApiFromEntries(merged, {
      sessionId: 's1',
      requiredCurrentUser: {
        message: user,
        order: { kind: 'persisted', sequence: 998 }
      },
      excludeMessageIds: [failed.id]
    })
    expect(history.filter((m) => m.id === 'u998')).toHaveLength(1)
    expect(history.filter((m) => m.id === 'a999')).toHaveLength(0)
  })
})
