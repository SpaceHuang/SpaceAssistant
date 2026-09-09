import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../../shared/domainTypes'
import { getApiContextOverlaySnapshot, resetApiContextServiceForTest } from './apiContextService'
import { ackContextSummaryPersisted, resetContextHistorySummaryForTest } from './contextHistorySummaryService'
import { store } from '../store'
import { ackDisplayMessagePersisted, addMessage, removeMessage, setDisplayPage, setSession } from '../store/chatSlice'
import { prepareSendContext } from './messageMutationGateway'

function preparedTurn(input: { sessionId: string; requestId: string; text: string }) {
  const user: Message = {
    id: 'core-user',
    sessionId: input.sessionId,
    role: 'user',
    content: input.text,
    timestamp: 1,
    status: 'sent',
    schemaVersion: 1
  }
  const assistant: Message = {
    id: 'core-assistant',
    sessionId: input.sessionId,
    role: 'assistant',
    content: '',
    timestamp: 2,
    status: 'streaming',
    schemaVersion: 1
  }
  return {
    turnId: 'turn-1',
    requestId: input.requestId,
    sessionId: input.sessionId,
    userMessage: user,
    assistantMessage: assistant,
    version: 0,
    startToken: 'start-1'
  }
}

describe('prepareSendContext Core contract', () => {
  beforeEach(() => {
    resetApiContextServiceForTest()
    resetContextHistorySummaryForTest()
    store.dispatch(setSession('s1'))
    window.api = {
      chatPrepareTurn: vi.fn(async (payload: { sessionId: string; requestId: string; input: { text: string } }) =>
        preparedTurn({ sessionId: payload.sessionId, requestId: payload.requestId, text: payload.input.text })
      ),
      chatGetMessageSequence: vi.fn().mockResolvedValue(10)
    } as unknown as typeof window.api
  })

  it('returns the atomic user/assistant turn without append-message writes', async () => {
    const result = await prepareSendContext('s1', { kind: 'create-user', text: 'hello' }, 'request-1')

    expect(window.api.chatPrepareTurn).toHaveBeenCalledWith({
      mode: 'create-user',
      requestId: 'request-1',
      sessionId: 's1',
      input: { text: 'hello', attachments: undefined },
      config: {}
    })
    expect(result.coordinatorTurn?.turnId).toBe('turn-1')
    expect(result.requiredCurrentUser.message.id).toBe('core-user')
    expect(result.requiredCurrentUser.order).toEqual({ kind: 'persisted', sequence: 10 })
    expect(getApiContextOverlaySnapshot('s1').map((entry) => entry.message.id)).toEqual(['core-user'])
    expect(() => ackContextSummaryPersisted('s1', 'core-user', 10)).not.toThrow()
    expect(store.getState().chat.displayEntries).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ id: 'core-user' }),
        order: { kind: 'persisted', sequence: 10 }
      })
    ])
  })

  it('reuse-user retry also prepares through Core and never appends a user fact locally', async () => {
    const user: Message = {
      id: 'retry-user', sessionId: 's1', role: 'user', content: 'retry me', timestamp: 1, status: 'sent', schemaVersion: 1
    }
    const prepare = vi.mocked(window.api.chatPrepareTurn)
    prepare.mockResolvedValueOnce({
      ...preparedTurn({ sessionId: 's1', requestId: 'retry-request', text: 'retry me' }),
      userMessage: user
    } as never)
    store.dispatch(setDisplayPage({
      entries: [
        { message: user, sequence: 7 },
        {
          message: {
            id: 'failed-assistant', sessionId: 's1', role: 'assistant', content: '',
            timestamp: 2, status: 'failed', schemaVersion: 1
          },
          sequence: 8
        }
      ],
      oldestSequence: 7,
      hasMoreBefore: false,
      generation: 1
    }))

    const result = await prepareSendContext('s1', {
      kind: 'reuse-user',
      currentUser: { message: user, order: { kind: 'persisted', sequence: 7 } },
      excludeMessageIds: ['failed-assistant']
    }, 'retry-request')

    expect(prepare).toHaveBeenCalledWith({
      mode: 'reuse-user',
      requestId: 'retry-request',
      sessionId: 's1',
      userMessageId: 'retry-user',
      excludeMessageIds: ['failed-assistant'],
      config: {}
    })
    expect(result.requiredCurrentUser.message.id).toBe('retry-user')
    expect(getApiContextOverlaySnapshot('s1').map((entry) => entry.message.id)).toEqual(['retry-user'])
    expect(store.getState().chat.displayEntries.find((entry) => entry.message.id === 'retry-user')?.order)
      .toEqual({ kind: 'persisted', sequence: 7 })

    store.dispatch(removeMessage('failed-assistant'))
    store.dispatch(addMessage(result.coordinatorTurn!.assistantMessage))
    store.dispatch(ackDisplayMessagePersisted({
      messageId: result.coordinatorTurn!.assistantMessage.id,
      sequence: 9
    }))
    expect(store.getState().chat.displayEntries.map((entry) => entry.message.id))
      .toEqual(['retry-user', 'core-assistant'])
  })

  it('queued drain reuses the queued user through the atomic Core prepare path', async () => {
    const queued: Message = {
      id: 'queued-user', sessionId: 's1', role: 'user', content: 'queued', timestamp: 1, status: 'queued', schemaVersion: 1
    }
    vi.mocked(window.api.chatPrepareTurn).mockResolvedValueOnce({
      ...preparedTurn({ sessionId: 's1', requestId: 'queued-request', text: 'queued' }),
      userMessage: { ...queued, status: 'sent' }
    } as never)

    const result = await prepareSendContext('s1', {
      kind: 'reuse-user',
      currentUser: { message: queued, order: { kind: 'persisted', sequence: 8 } },
      requestId: 'queued-request'
    }, 'queued-request')

    expect(window.api.chatPrepareTurn).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'reuse-user', userMessageId: 'queued-user', requestId: 'queued-request'
    }))
    expect(result.requiredCurrentUser.message.status).toBe('sent')
  })
})
