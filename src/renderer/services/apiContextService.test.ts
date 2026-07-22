import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../shared/domainTypes'
import type { ApiContextBaseline } from '../../shared/displayOrder'
import {
  ackApiContextMessagePersisted,
  ApiContextInvariantError,
  buildHistoryForApiFromEntries,
  mergeApiContextBaselineWithOverlay,
  resetApiContextServiceForTest,
  resolveSessionContextForApi,
  routeAddApiContextMessageOptimistic,
  routePatchApiContextMessage
} from './apiContextService'

function msg(partial: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message {
  return {
    sessionId: 's1',
    timestamp: 1,
    status: partial.role === 'user' ? 'sent' : 'completed',
    schemaVersion: 1,
    ...partial
  }
}

function baselineFromIds(ids: string[]): ApiContextBaseline {
  return {
    sessionId: 's1',
    entries: ids.map((id, sequence) => ({
      message: msg({
        id,
        role: sequence % 2 === 0 ? 'user' : 'assistant',
        content: id,
        status: sequence % 2 === 0 ? 'sent' : 'completed'
      }),
      sequence
    }))
  }
}

describe('apiContextService payload isolation', () => {
  beforeEach(() => {
    resetApiContextServiceForTest()
  })

  it('keeps baseline m0..m499 even when UI would only hold latest page', async () => {
    const baselineIds = Array.from({ length: 500 }, (_, i) => `m${i}`)
    const baseline = baselineFromIds(baselineIds)
    const fetcher = vi.fn(async () => baseline)

    const currentUser = msg({ id: 'm1000', role: 'user', content: 'new', status: 'sent' })
    routeAddApiContextMessageOptimistic(currentUser)
    // simulate UI page only having m940..m999 — must not affect API
    const { historyForApi } = await resolveSessionContextForApi(
      {
        sessionId: 's1',
        requiredCurrentUser: {
          message: currentUser,
          order: { kind: 'optimistic', ordinal: 0 }
        }
      },
      fetcher
    )

    const ids = historyForApi.map((m) => m.id)
    expect(ids.slice(0, 500)).toEqual(baselineIds)
    expect(ids.filter((id) => id === 'm1000')).toEqual(['m1000'])
    expect(ids[ids.length - 1]).toBe('m1000')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('appends routeAdd once and ack/patch do not duplicate', async () => {
    const baseline = baselineFromIds(Array.from({ length: 500 }, (_, i) => `m${i}`))
    const fetcher = async () => baseline
    const currentUser = msg({ id: 'm1000', role: 'user', content: 'u', status: 'sent' })
    const entry = routeAddApiContextMessageOptimistic(currentUser)
    expect(entry.order).toEqual({ kind: 'optimistic', ordinal: 0 })

    ackApiContextMessagePersisted({ messageId: 'm1000', sequence: 1000 }, 's1')
    routePatchApiContextMessage('s1', 'm1000', { content: 'u-patched' })

    const { historyForApi } = await resolveSessionContextForApi(
      {
        sessionId: 's1',
        requiredCurrentUser: {
          message: { ...currentUser, content: 'u-patched' },
          order: { kind: 'persisted', sequence: 1000 }
        }
      },
      fetcher
    )
    expect(historyForApi.filter((m) => m.id === 'm1000')).toHaveLength(1)
    expect(historyForApi.find((m) => m.id === 'm1000')?.content).toBe('u-patched')
  })

  it('throws when required current user is not sent', () => {
    expect(() =>
      buildHistoryForApiFromEntries([], {
        sessionId: 's1',
        requiredCurrentUser: {
          message: msg({ id: 'u1', role: 'user', content: 'x', status: 'queued' }),
          order: { kind: 'optimistic', ordinal: 0 }
        }
      })
    ).toThrow(ApiContextInvariantError)
  })

  it('excludes ids from final union so baseline cannot resurrect them', () => {
    const baseline = baselineFromIds(['m0', 'm1', 'u-keep'])
    // force roles: rewrite
    baseline.entries = [
      { message: msg({ id: 'm0', role: 'user', content: 'a', status: 'sent' }), sequence: 0 },
      { message: msg({ id: 'bad', role: 'assistant', content: 'fail', status: 'failed' }), sequence: 1 },
      { message: msg({ id: 'u-keep', role: 'user', content: 'ok', status: 'sent' }), sequence: 2 }
    ]
    const merged = mergeApiContextBaselineWithOverlay(baseline, [])
    const history = buildHistoryForApiFromEntries(merged, {
      sessionId: 's1',
      requiredCurrentUser: {
        message: msg({ id: 'u-keep', role: 'user', content: 'ok', status: 'sent' }),
        order: { kind: 'persisted', sequence: 2 }
      },
      excludeMessageIds: ['bad']
    })
    expect(history.map((m) => m.id)).toEqual(['m0', 'u-keep'])
  })

  it('orders by sequence even when timestamps are reversed', () => {
    const baseline: ApiContextBaseline = {
      sessionId: 's1',
      entries: [
        {
          message: msg({ id: 'm0', role: 'user', content: 'old', status: 'sent', timestamp: 999 }),
          sequence: 0
        },
        {
          message: msg({ id: 'm1', role: 'assistant', content: 'a', status: 'completed', timestamp: 1 }),
          sequence: 1
        }
      ]
    }
    const merged = mergeApiContextBaselineWithOverlay(baseline, [])
    expect(merged.map((e) => e.message.id)).toEqual(['m0', 'm1'])
  })
})
