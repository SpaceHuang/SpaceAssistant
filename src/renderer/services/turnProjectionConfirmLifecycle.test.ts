import { beforeEach, describe, expect, it, vi } from 'vitest'

const { patchMessage, dispatch } = vi.hoisted(() => ({ patchMessage: vi.fn(), dispatch: vi.fn() }))

vi.mock('./chatRunnerService', () => ({ routePatchMessage: patchMessage }))
vi.mock('../store', () => ({
  store: {
    getState: vi.fn(() => ({ chat: { currentSessionId: 's1' } })),
    dispatch
  }
}))

import { pendingConfirmStore } from './pendingConfirmStore'
import { initTurnProjectionBridge } from './turnProjectionService'

describe('turn projection confirmation lifecycle', () => {
  beforeEach(() => {
    patchMessage.mockReset()
    dispatch.mockReset()
    pendingConfirmStore.reset()
    pendingConfirmStore.dispose()
    pendingConfirmStore.init()
  })

  it('从 confirming projection 建立确认项，并由 terminal projection 清理', () => {
    let listener: ((payload: any) => void) | undefined
    vi.stubGlobal('window', {
      api: {
        usageSet: vi.fn().mockResolvedValue(undefined),
        chatListActiveTurns: vi.fn().mockResolvedValue([]),
        chatOnTurnProjection: vi.fn((cb) => {
          listener = cb
          return () => undefined
        })
      }
    })

    const off = initTurnProjectionBridge()
    const baseMessage = {
      id: 'assistant-1', sessionId: 's1', role: 'assistant', content: '', timestamp: 1,
      status: 'streaming', schemaVersion: 1
    }
    listener?.({
      turn: {
        turnId: 'turn-1', requestId: 'request-1', sessionId: 's1', version: 1,
        assistantMessage: {
          ...baseMessage,
          toolCalls: [{ id: 'tool-1', toolName: 'run_shell', input: { command: 'pwd' }, status: 'confirming', riskLevel: 'high' }]
        }
      },
      event: { type: 'confirm-requested' }
    })
    expect(pendingConfirmStore.find('s1', 'tool-1')).toMatchObject({ requestId: 'request-1', toolName: 'run_shell' })

    listener?.({
      turn: {
        turnId: 'turn-1', requestId: 'request-1', sessionId: 's1', version: 2,
        assistantMessage: { ...baseMessage, status: 'completed', toolCalls: [{ id: 'tool-1', toolName: 'run_shell', input: { command: 'pwd' }, status: 'completed', riskLevel: 'high' }] }
      },
      event: { type: 'source-completed' }
    })
    expect(pendingConfirmStore.find('s1', 'tool-1')).toBeUndefined()
    off()
  })

  it.each([
    ['no-tools', [
      { type: 'content-delta', version: 1, content: 'answer', status: 'streaming' },
      { type: 'source-completed', version: 2, content: 'answer', status: 'completed' }
    ], ['content-delta', 'source-completed']],
    ['tools-with-confirm', [
      { type: 'content-delta', version: 1, content: 'before', status: 'streaming' },
      { type: 'tool-use', version: 2, content: 'before', status: 'streaming', toolStatus: 'calling' },
      { type: 'confirm-requested', version: 3, content: 'before', status: 'streaming', toolStatus: 'confirming' },
      { type: 'tool-confirmed', version: 4, content: 'before', status: 'streaming', toolStatus: 'completed' },
      { type: 'tool-result', version: 5, content: 'before\nok', status: 'streaming', toolStatus: 'completed' },
      { type: 'source-completed', version: 6, content: 'before\nok', status: 'completed', toolStatus: 'completed' }
    ], ['content-delta', 'tool-use', 'confirm-requested', 'tool-confirmed', 'tool-result', 'source-completed']]
  ] as const)('%s: Core projection 序列完整驱动 renderer 状态且忽略旧版本', (_name, sequence, expectedEvents) => {
    let listener: ((payload: any) => void) | undefined
    vi.stubGlobal('window', {
      api: {
        usageSet: vi.fn().mockResolvedValue(undefined),
        chatListActiveTurns: vi.fn().mockResolvedValue([]),
        chatOnTurnProjection: vi.fn((cb) => {
          listener = cb
          return () => undefined
        })
      }
    })

    const off = initTurnProjectionBridge()
    const messageBase = {
      id: 'sequence-assistant', sessionId: 's1', role: 'assistant', timestamp: 1, schemaVersion: 1
    }
    const projectedEvents: string[] = []
    for (const item of sequence) {
      const toolCalls = item.toolStatus ? [{
        id: 'sequence-tool', toolName: 'run_shell', input: { command: 'pwd' },
        status: item.toolStatus, riskLevel: 'high' as const
      }] : undefined
      listener?.({
        turn: {
          turnId: 'sequence-turn', requestId: 'sequence-request', sessionId: 's1', version: item.version,
          assistantMessage: {
            ...messageBase, content: item.content, status: item.status,
            ...(toolCalls ? { toolCalls } : {})
          }
        },
        event: { type: item.type }
      })
      projectedEvents.push(item.type)
    }

    // 旧 snapshot/event 不得覆盖最新 projection，也不得改变 renderer 的最终状态。
    listener?.({
      turn: {
        turnId: 'sequence-turn', requestId: 'sequence-request', sessionId: 's1', version: 2,
        assistantMessage: { ...messageBase, content: 'stale', status: 'streaming' }
      },
      event: { type: 'content-delta' }
    })

    expect(patchMessage.mock.calls.map(([sessionId, messageId]) => [sessionId, messageId])).toEqual(
      projectedEvents.map(() => ['s1', 'sequence-assistant'])
    )
    expect(patchMessage.mock.calls.at(-1)?.[2]).toMatchObject({
      content: sequence.at(-1)?.content,
      status: sequence.at(-1)?.status
    })
    expect(pendingConfirmStore.find('s1', 'sequence-tool')).toBeUndefined()
    off()
  })
})
