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

  it('Q1/Q2 keeps completed A/B history and excludes queued or streaming placeholders', async () => {
    const aUser = msg({ id: 'a-user', role: 'user', content: 'A' })
    const aAssistant = msg({ id: 'a-assistant', role: 'assistant', content: 'A final', status: 'completed' })
    const bUser = msg({ id: 'b-user', role: 'user', content: 'B' })
    const bAssistant = msg({ id: 'b-assistant', role: 'assistant', content: '', status: 'streaming' })
    const cUser = msg({ id: 'c-user', role: 'user', content: 'C', status: 'queued' })

    const q1 = await resolveSessionContextForApi(
      {
        sessionId: 's1',
        requiredCurrentUser: { message: bUser, order: { kind: 'persisted', sequence: 3 } }
      },
      async () => ({
        sessionId: 's1',
        entries: [
          { message: aUser, sequence: 0 },
          { message: aAssistant, sequence: 1 },
          { message: bUser, sequence: 2 },
          { message: bAssistant, sequence: 3 },
          { message: cUser, sequence: 4 }
        ]
      })
    )
    expect(q1.historyForApi.map((m) => m.id)).toEqual(['a-user', 'a-assistant', 'b-user'])

    const cCompleted = msg({ id: 'c-assistant', role: 'assistant', content: 'C final', status: 'completed' })
    const dUser = msg({ id: 'd-user', role: 'user', content: 'D' })
    const q2 = await resolveSessionContextForApi(
      {
        sessionId: 's1',
        requiredCurrentUser: { message: dUser, order: { kind: 'persisted', sequence: 6 } }
      },
      async () => ({
        sessionId: 's1',
        entries: [
          { message: aUser, sequence: 0 },
          { message: aAssistant, sequence: 1 },
          { message: bUser, sequence: 2 },
          { message: msg({ ...bAssistant, content: 'B final', status: 'completed' }), sequence: 3 },
          { message: { ...cUser, status: 'sent' }, sequence: 4 },
          { message: cCompleted, sequence: 5 },
          { message: dUser, sequence: 6 }
        ]
      })
    )
    expect(q2.historyForApi.map((m) => m.id)).toEqual([
      'a-user',
      'a-assistant',
      'b-user',
      'b-assistant',
      'c-user',
      'c-assistant',
      'd-user'
    ])
  })
})
