import { describe, expect, it, beforeEach, vi } from 'vitest'
import { pendingConfirmStore } from './pendingConfirmStore'
import { clearRunRequestIndex, registerRunRequest } from './runRequestIndex'

describe('pendingConfirmStore', () => {
  const seedConfirm = (data: {
    requestId: string
    sessionId?: string
    toolUseId: string
    toolName: string
    input: unknown
    riskLevel: 'low' | 'medium' | 'high'
    turnId?: string
    turnVersion?: number
  }): void => {
    pendingConfirmStore.syncFromProjection({
      sessionId: data.sessionId ?? 'seed-session',
      requestId: data.requestId,
      ...(data.turnId ? { turnId: data.turnId, turnVersion: data.turnVersion ?? 1 } : {}),
      message: {
        id: `assistant-${data.requestId}`,
        sessionId: data.sessionId ?? 'seed-session',
        role: 'assistant',
        content: '',
        timestamp: 1,
        status: 'streaming',
        schemaVersion: 1,
        toolCalls: [{ id: data.toolUseId, toolName: data.toolName, input: data.input as Record<string, unknown>, riskLevel: data.riskLevel, status: 'confirming' }]
      }
    })
  }

  beforeEach(() => {
    pendingConfirmStore.reset()
    pendingConfirmStore.dispose()
    clearRunRequestIndex()
    vi.stubGlobal('window', {
      api: {
        toolConfirmResponse: vi.fn()
      }
    })
    pendingConfirmStore.init()
  })

  it('独立确认快照未 ready 前拒绝批准，ready 后允许批准', async () => {
    const response = vi.fn().mockResolvedValue({ sessionId: 's1', turnId: 't1', requestId: 'r1', turnVersion: 2, toolCallId: 'tool-1', confirmation: { complete: true } })
    vi.stubGlobal('window', { api: { chatGetPendingConfirmation: response, toolConfirmResponse: vi.fn() } })
    seedConfirm({ requestId: 'r1', sessionId: 's1', toolUseId: 'tool-1', toolName: 'write_file', input: {}, riskLevel: 'medium', turnId: 't1', turnVersion: 2 })
    pendingConfirmStore.respond('r1', 'tool-1', true)
    expect(window.api.toolConfirmResponse).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 0))
    pendingConfirmStore.respond('r1', 'tool-1', true)
    expect(window.api.toolConfirmResponse).toHaveBeenCalled()
  })

  it('queues confirm when session resolved from request index', () => {
    registerRunRequest('sess-a', 'req-1')
    seedConfirm({
      requestId: 'req-1',
      sessionId: 'sess-a',
      toolUseId: 'tool-1',
      toolName: 'write_file',
      input: { path: 'a.ts' },
      riskLevel: 'medium'
    })
    expect(pendingConfirmStore.getItems()).toHaveLength(1)
    expect(pendingConfirmStore.getItems()[0]?.sessionId).toBe('sess-a')
  })

  it('queues confirm when sessionId is included in IPC payload', () => {
    seedConfirm({
      requestId: 'req-direct',
      sessionId: 'sess-direct',
      toolUseId: 'tool-1',
      toolName: 'run_shell',
      input: { command: 'echo hi' },
      riskLevel: 'high'
    })
    expect(pendingConfirmStore.getItems()).toHaveLength(1)
    expect(pendingConfirmStore.getItems()[0]?.sessionId).toBe('sess-direct')
  })

  it('respond sends ipc and removes item', () => {
    registerRunRequest('sess-a', 'req-1')
    seedConfirm({
      requestId: 'req-1',
      sessionId: 's1',
      toolUseId: 'tool-1',
      toolName: 'write_file',
      input: {},
      riskLevel: 'medium'
    })
    pendingConfirmStore.respond('req-1', 'tool-1', true)
    expect(window.api.toolConfirmResponse).toHaveBeenCalledWith({
      requestId: 'req-1',
      toolUseId: 'tool-1',
      approved: true
    })
    expect(pendingConfirmStore.getItems()).toHaveLength(0)
  })

  it('rejectAllForSession rejects all pending for session', () => {
    registerRunRequest('s1', 'r1')
    registerRunRequest('s2', 'r2')
    seedConfirm({
      requestId: 'r1',
      sessionId: 's1',
      toolUseId: 't1',
      toolName: 'write_file',
      input: {},
      riskLevel: 'medium'
    })
    seedConfirm({
      requestId: 'r2',
      sessionId: 's2',
      toolUseId: 't2',
      toolName: 'write_file',
      input: {},
      riskLevel: 'medium'
    })
    pendingConfirmStore.rejectAllForSession('s1')
    expect(window.api.toolConfirmResponse).toHaveBeenCalledWith({
      requestId: 'r1',
      toolUseId: 't1',
      approved: false
    })
    expect(pendingConfirmStore.getItems()).toHaveLength(1)
    expect(pendingConfirmStore.getItems()[0]?.sessionId).toBe('s2')
  })

  it('removeAllForRequest clears orphan items', () => {
    registerRunRequest('s1', 'r1')
    registerRunRequest('s1', 'r2')
    seedConfirm({
      requestId: 'r1',
      sessionId: 's1',
      toolUseId: 't1',
      toolName: 'write_file',
      input: {},
      riskLevel: 'medium'
    })
    seedConfirm({
      requestId: 'r2',
      sessionId: 's1',
      toolUseId: 't2',
      toolName: 'write_file',
      input: {},
      riskLevel: 'medium'
    })
    pendingConfirmStore.removeAllForRequest('r1')
    expect(pendingConfirmStore.getItems()).toHaveLength(1)
    expect(pendingConfirmStore.getItems()[0]?.requestId).toBe('r2')
  })

  it('rebuilds confirmation cards from a Core projection snapshot', () => {
    pendingConfirmStore.syncFromProjection({
      sessionId: 's-core',
      requestId: 'r-core',
      message: {
        id: 'a-core',
        sessionId: 's-core',
        role: 'assistant',
        content: '',
        timestamp: 1,
        status: 'streaming',
        schemaVersion: 1,
        toolCalls: [{
          id: 'tool-core',
          toolName: 'run_shell',
          input: { command: 'echo hi' },
          status: 'confirming',
          riskLevel: 'high',
          confirmDiff: { oldContent: '', newContent: 'x', oldPath: 'a.txt' }
        }]
      }
    })
    expect(pendingConfirmStore.getItems()).toEqual([expect.objectContaining({
      sessionId: 's-core',
      requestId: 'r-core',
      toolUseId: 'tool-core',
      toolName: 'run_shell',
      diff: { oldContent: '', newContent: 'x', oldPath: 'a.txt' }
    })])
  })
})
