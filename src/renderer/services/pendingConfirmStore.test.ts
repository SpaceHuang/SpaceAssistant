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

  // ---- J-04（docs/develop/chat-message-list-streaming-jitter-fix-plan.md）：
  // 幂等守卫语义特征测试。fixture 携带 startedAt 以固定 createdAt
  // （无 startedAt 时 createdAt 走 Date.now() 兜底，任何守卫实现都会判定"已变化"，见方案 §J-04 已知边界）。
  const guardSync = (options?: { input?: unknown; retryAttempt?: number }): void => {
    pendingConfirmStore.syncFromProjection({
      sessionId: 's-guard',
      requestId: 'r-guard',
      ...(options?.retryAttempt ? { retryAttempt: options.retryAttempt } : {}),
      message: {
        id: 'a-guard',
        sessionId: 's-guard',
        role: 'assistant',
        content: '',
        timestamp: 1,
        status: 'streaming',
        schemaVersion: 1,
        toolCalls: [{
          id: 'tool-guard',
          toolName: 'write_file',
          input: (options?.input ?? { path: 'a.ts' }) as Record<string, unknown>,
          riskLevel: 'medium',
          status: 'confirming',
          startedAt: 1000
        }]
      }
    })
  }

  it('同一 projection 重复 sync 不触发 notify（幂等守卫）', () => {
    guardSync()
    let calls = 0
    const unsubscribe = pendingConfirmStore.subscribe(() => {
      calls += 1
    })
    try {
      guardSync()
      expect(calls).toBe(0)
    } finally {
      unsubscribe()
    }
  })

  it('confirmationReady 翻转后，相同 projection 的再次 sync 仍触发 notify', async () => {
    const getConfirmation = vi.fn().mockResolvedValue({
      sessionId: 's-guard',
      turnId: 't-guard',
      requestId: 'r-guard',
      turnVersion: 1,
      toolCallId: 'tool-guard',
      confirmation: { complete: true, riskLevel: 'medium', memoryTiers: [], browser: {} }
    })
    vi.stubGlobal('window', { api: { chatGetPendingConfirmation: getConfirmation, toolConfirmResponse: vi.fn() } })
    const args = {
      sessionId: 's-guard',
      requestId: 'r-guard',
      turnId: 't-guard',
      turnVersion: 1,
      message: {
        id: 'a-guard',
        sessionId: 's-guard',
        role: 'assistant',
        content: '',
        timestamp: 1,
        status: 'streaming',
        schemaVersion: 1,
        toolCalls: [{
          id: 'tool-guard',
          toolName: 'write_file',
          input: { path: 'a.ts' } as Record<string, unknown>,
          riskLevel: 'medium',
          status: 'confirming',
          startedAt: 1000
        }]
      }
    }
    pendingConfirmStore.syncFromProjection(args)
    let calls = 0
    const unsubscribe = pendingConfirmStore.subscribe(() => {
      calls += 1
    })
    try {
      // IPC 快照返回后 confirmationReady 翻转为 true 并 notify
      await new Promise((resolve) => setTimeout(resolve, 0))
      const afterFlip = calls
      expect(afterFlip).toBeGreaterThanOrEqual(1)
      // 再次相同 sync：重建的 next 恒为 confirmationReady:false，与当前 true 不同 → 必须 notify
      pendingConfirmStore.syncFromProjection(args)
      expect(calls).toBeGreaterThan(afterFlip)
    } finally {
      unsubscribe()
    }
  })

  it('retryAttempt > 0 时即使 projection 相同也执行 notify（保持重试放行语义）', () => {
    guardSync()
    let calls = 0
    const unsubscribe = pendingConfirmStore.subscribe(() => {
      calls += 1
    })
    try {
      guardSync()
      expect(calls).toBe(0)
      guardSync({ retryAttempt: 1 })
      expect(calls).toBe(1)
    } finally {
      unsubscribe()
    }
  })

  it('仅 input 内容不同的两次 sync 触发 notify（深度字段感知）', () => {
    guardSync()
    let calls = 0
    const unsubscribe = pendingConfirmStore.subscribe(() => {
      calls += 1
    })
    try {
      guardSync({ input: { path: 'b.ts' } })
      expect(calls).toBe(1)
    } finally {
      unsubscribe()
    }
  })
})
