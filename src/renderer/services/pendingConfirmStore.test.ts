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

  it('隔离不同会话中复用 requestId 和 toolUseId 的确认项及响应', () => {
    seedConfirm({ requestId: 'shared-request', sessionId: 'session-a', toolUseId: 'shared-tool', toolName: 'write_file', input: { path: 'a' }, riskLevel: 'medium' })
    seedConfirm({ requestId: 'shared-request', sessionId: 'session-b', toolUseId: 'shared-tool', toolName: 'write_file', input: { path: 'b' }, riskLevel: 'medium' })

    expect(pendingConfirmStore.getItems()).toHaveLength(2)
    expect(pendingConfirmStore.find('session-a', 'shared-tool')?.input).toEqual({ path: 'a' })
    expect(pendingConfirmStore.find('session-b', 'shared-tool')?.input).toEqual({ path: 'b' })

    pendingConfirmStore.respond('shared-request', 'shared-tool', false, undefined, 'session-b')
    expect(window.api.toolConfirmResponse).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'shared-request', toolUseId: 'shared-tool', approved: false, sessionId: 'session-b'
    }))
    expect(pendingConfirmStore.find('session-a', 'shared-tool')?.input).toEqual({ path: 'a' })
    expect(pendingConfirmStore.find('session-b', 'shared-tool')).toBeUndefined()
  })

  it('不把审批 Agent 的 confirming 项暴露为人工待确认', () => {
    pendingConfirmStore.syncFromProjection({
      sessionId: 'sess-agent',
      requestId: 'req-agent',
      message: {
        id: 'assistant-agent',
        sessionId: 'sess-agent',
        role: 'assistant',
        content: '',
        timestamp: 1,
        status: 'streaming',
        schemaVersion: 1,
        toolCalls: [{
          id: 'tool-agent',
          toolName: 'run_shell',
          input: { command: 'make deploy' },
          status: 'confirming',
          riskLevel: 'high',
          autoAnswerer: true
        }]
      }
    })

    expect(pendingConfirmStore.getItems()).toEqual([])
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
      approved: true,
      sessionId: 's1',
      trustCommand: undefined,
      trustDomain: undefined,
      trustActDomain: undefined
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
      approved: false,
      sessionId: 's1'
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

  // ---- 确认卡闪动修复（接替上方 J-04 特征测试，治理方案 §J-04 已知边界 S-02 + 投影重建回退）：
  // 旧实现每次投影 sync 都把 confirmationReady 重置为 false、再靠 chatGetPendingConfirmation IPC 拉回 true，
  // 确认卡因此以投影推送频率在「完整确认卡 ↔ 紧凑行」间翻转（高度数百 px 跳变 = 闪动本体）；
  // 且 createdAt 走 Date.now() 兜底使幂等守卫恒失效，每次推送都重发快照 IPC + 双重 notify。
  // 注意：上方 J-04 幂等测试两次 sync 同步连发、同毫秒执行，侥幸掩盖了 Date.now() 漂移
  // （真机投影间隔 >1ms，守卫必然失效）。以下测试用 fake timers 显式跨毫秒，防止再次假绿。

  const flickerArgs = (overrides?: { turnVersion?: number; input?: unknown; turnId?: string }): Parameters<typeof pendingConfirmStore.syncFromProjection>[0] => ({
    sessionId: 's-flicker',
    requestId: 'r-flicker',
    turnId: overrides?.turnId ?? 't-flicker',
    turnVersion: overrides?.turnVersion ?? 1,
    message: {
      id: 'a-flicker',
      sessionId: 's-flicker',
      role: 'assistant',
      content: '',
      timestamp: 1,
      status: 'streaming',
      schemaVersion: 1,
      toolCalls: [{
        id: 'tool-flicker',
        toolName: 'write_file',
        input: (overrides?.input ?? { path: 'a.ts' }) as Record<string, unknown>,
        riskLevel: 'medium',
        status: 'confirming'
      }]
    }
  })

  const flickerConfirmation = (turnVersion = 1) => ({
    sessionId: 's-flicker',
    turnId: 't-flicker',
    requestId: 'r-flicker',
    turnVersion,
    toolCallId: 'tool-flicker',
    confirmation: { complete: true, riskLevel: 'medium', memoryTiers: [], browser: {} }
  })

  const flushMicrotasks = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }

  it('无 startedAt 的同一 projection 跨毫秒重复 sync 不触发 notify（createdAt 冻结）', () => {
    vi.useFakeTimers()
    try {
      pendingConfirmStore.syncFromProjection(flickerArgs())
      vi.advanceTimersByTime(5)
      let calls = 0
      const unsubscribe = pendingConfirmStore.subscribe(() => {
        calls += 1
      })
      try {
        pendingConfirmStore.syncFromProjection(flickerArgs())
        expect(calls).toBe(0)
      } finally {
        unsubscribe()
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('IPC 快照就绪后，相同 projection 再次 sync 保持就绪：不回退、不重复 notify、不重复拉取', async () => {
    const getConfirmation = vi.fn().mockResolvedValue(flickerConfirmation())
    vi.stubGlobal('window', { api: { chatGetPendingConfirmation: getConfirmation, toolConfirmResponse: vi.fn() } })
    pendingConfirmStore.syncFromProjection(flickerArgs())
    await flushMicrotasks()
    expect(pendingConfirmStore.getItems()[0]?.confirmationReady).toBe(true)
    let calls = 0
    const unsubscribe = pendingConfirmStore.subscribe(() => {
      calls += 1
    })
    try {
      pendingConfirmStore.syncFromProjection(flickerArgs())
      expect(calls).toBe(0)
      expect(pendingConfirmStore.getItems()[0]?.confirmationReady).toBe(true)
      expect(getConfirmation).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
    }
  })

  it('turnVersion 推进而 payload 不变：静默跟踪版本，不 notify、不重拉快照、批准门禁不回退', async () => {
    const getConfirmation = vi.fn().mockResolvedValue(flickerConfirmation())
    vi.stubGlobal('window', { api: { chatGetPendingConfirmation: getConfirmation, toolConfirmResponse: vi.fn() } })
    pendingConfirmStore.syncFromProjection(flickerArgs())
    await flushMicrotasks()
    let calls = 0
    const unsubscribe = pendingConfirmStore.subscribe(() => {
      calls += 1
    })
    try {
      pendingConfirmStore.syncFromProjection(flickerArgs({ turnVersion: 2 }))
      expect(calls).toBe(0)
      expect(pendingConfirmStore.getItems()[0]?.turnVersion).toBe(2)
      expect(pendingConfirmStore.getItems()[0]?.confirmationReady).toBe(true)
      expect(getConfirmation).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
    }
    // 快照版本(1)不超前 item 已知版本(2)：快照未过期，批准门禁放行
    pendingConfirmStore.respond('r-flicker', 'tool-flicker', true)
    expect(window.api.toolConfirmResponse).toHaveBeenCalled()
  })

  it('确认 payload 变化时重置就绪态并重新拉取快照（旧快照不可信）', async () => {
    const getConfirmation = vi.fn().mockResolvedValue(flickerConfirmation())
    vi.stubGlobal('window', { api: { chatGetPendingConfirmation: getConfirmation, toolConfirmResponse: vi.fn() } })
    pendingConfirmStore.syncFromProjection(flickerArgs())
    await flushMicrotasks()
    let calls = 0
    const unsubscribe = pendingConfirmStore.subscribe(() => {
      calls += 1
    })
    try {
      pendingConfirmStore.syncFromProjection(flickerArgs({ input: { path: 'changed.ts' } }))
      expect(pendingConfirmStore.getItems()[0]?.confirmationReady).toBe(false)
      expect(getConfirmation).toHaveBeenCalledTimes(2)
      await flushMicrotasks()
      expect(pendingConfirmStore.getItems()[0]?.confirmationReady).toBe(true)
    } finally {
      unsubscribe()
    }
  })

  it('不变量：随机 sync/快照/移除序列下就绪态单调、键唯一、同 payload 幂等', async () => {
    // 快照版本恒超前（99 > 序列最长 60 步）：模拟响应侧对齐——主进程总返回当前最新快照
    const getConfirmation = vi.fn().mockResolvedValue(flickerConfirmation(99))
    vi.stubGlobal('window', { api: { chatGetPendingConfirmation: getConfirmation, toolConfirmResponse: vi.fn() } })
    vi.useFakeTimers()
    try {
      // mulberry32（AGENTS.md 不变量测试范式）：确定性伪随机操作序列
      let seed = 0x1f2e3d4c
      const rand = (): number => {
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      const payloadPool = [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }]
      let payloadIdx = 0
      let version = 0
      // oracle：每键最近一次 sync 的 payload；everReady 记录「就绪后从未经历 payload 变化/移除」的键
      const oraclePayload = new Map<string, Record<string, unknown>>()
      const everReady = new Set<string>()
      const keyOf = (requestId: string, toolUseId: string): string => `${requestId}:${toolUseId}`
      let calls = 0
      const unsubscribe = pendingConfirmStore.subscribe(() => {
        calls += 1
      })
      try {
        for (let step = 0; step < 60; step++) {
          const itemsBefore = pendingConfirmStore.getItems()
          const roll = rand()
          if (roll < 0.2 && itemsBefore.length > 0) {
            const victim = itemsBefore[Math.floor(rand() * itemsBefore.length)]!
            pendingConfirmStore.remove(victim.requestId, victim.toolUseId)
            oraclePayload.delete(keyOf(victim.requestId, victim.toolUseId))
            everReady.delete(keyOf(victim.requestId, victim.toolUseId))
          } else {
            if (rand() < 0.3) payloadIdx = Math.floor(rand() * payloadPool.length)
            const payload = payloadPool[payloadIdx]!
            const before = calls
            pendingConfirmStore.syncFromProjection(flickerArgs({ turnVersion: ++version, input: payload }))
            const key = keyOf('r-flicker', 'tool-flicker')
            // 不变量 A：payload 未变且快照已就绪 → 重复 sync 同步段不得 notify（幂等守卫）
            if (oraclePayload.get(key) === payload && everReady.has(key)) {
              expect(calls).toBe(before)
            }
            // 不变量 B：就绪单调——payload 未变的重复 sync 不得回退已就绪态
            if (everReady.has(key) && oraclePayload.get(key) === payload) {
              expect(pendingConfirmStore.getItems()[0]?.confirmationReady).toBe(true)
            }
            oraclePayload.set(key, payload)
          }
          // 不变量 C：键唯一
          const items = pendingConfirmStore.getItems()
          expect(new Set(items.map((item) => keyOf(item.requestId, item.toolUseId)).values()).size).toBe(items.length)
          vi.advanceTimersByTime(3)
          await flushMicrotasks()
          for (const item of pendingConfirmStore.getItems()) {
            if (item.confirmationReady === true) everReady.add(keyOf(item.requestId, item.toolUseId))
          }
        }
      } finally {
        unsubscribe()
      }
    } finally {
      vi.useRealTimers()
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

  // ---- 评审竞态修复（docs/review/pending-confirm-sync-jitter-review.md P0-1/P0-2/P1-3/P2-4/P2-5）：
  // 版本对齐移到响应侧（主进程返回当前最新快照+版本），渲染端按响应版本裁决；
  // 幂等早退不得短路快照拉取循环；在飞去重按 (requestId, toolUseId, turnVersion) 隔离。

  const stubManualConfirmation = (): { getConfirmation: ReturnType<typeof vi.fn>; resolvers: Array<(value: unknown) => void> } => {
    const resolvers: Array<(value: unknown) => void> = []
    const getConfirmation = vi.fn().mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve) }))
    vi.stubGlobal('window', { api: { chatGetPendingConfirmation: getConfirmation, toolConfirmResponse: vi.fn() } })
    return { getConfirmation, resolvers }
  }

  it('快照返回 stale 后，后续投影仍以最新版本重新拉取并最终就绪（修 P0-1 活性）', async () => {
    const { getConfirmation, resolvers } = stubManualConfirmation()
    pendingConfirmStore.syncFromProjection(flickerArgs({ turnVersion: 1 }))
    expect(getConfirmation).toHaveBeenCalledTimes(1)
    resolvers[0]({ status: 'stale' })
    await flushMicrotasks()
    expect(pendingConfirmStore.getItems()[0]?.confirmationReady).toBe(false)
    // payload 不变的版本推进投影：幂等静默更新，但拉取循环必须仍执行
    pendingConfirmStore.syncFromProjection(flickerArgs({ turnVersion: 2 }))
    expect(getConfirmation).toHaveBeenCalledTimes(2)
    expect(getConfirmation.mock.calls[1]?.[0]).toMatchObject({ turnVersion: 2 })
    resolvers[1](flickerConfirmation(2))
    await flushMicrotasks()
    expect(pendingConfirmStore.getItems()[0]?.confirmationReady).toBe(true)
  })

  it('快照在飞期间 payload 变化：旧响应被版本裁决丢弃，新版本立即重拉（修 P0-2）', async () => {
    const { getConfirmation, resolvers } = stubManualConfirmation()
    pendingConfirmStore.syncFromProjection(flickerArgs({ turnVersion: 1 }))
    // payload 变化投影：ready 重置，且新版本拉取不被旧在飞请求拦截
    pendingConfirmStore.syncFromProjection(flickerArgs({ turnVersion: 2, input: { path: 'b.ts' } }))
    expect(getConfirmation).toHaveBeenCalledTimes(2)
    expect(getConfirmation.mock.calls[1]?.[0]).toMatchObject({ turnVersion: 2 })
    // 旧响应（v1 快照）先落地：落后于 item 已知版本 → 不得应用
    resolvers[0](flickerConfirmation(1))
    await flushMicrotasks()
    expect(pendingConfirmStore.getItems()[0]?.confirmationReady).toBe(false)
    // 新响应（v2 快照）落地 → 应用
    resolvers[1](flickerConfirmation(2))
    await flushMicrotasks()
    expect(pendingConfirmStore.getItems()[0]?.confirmationReady).toBe(true)
    expect(pendingConfirmStore.getItems()[0]?.turnVersion).toBe(2)
  })

  it('快照 reject 后重试基于最新投影版本发起，而非捕获的旧版本（修 P1-3）', async () => {
    vi.useFakeTimers()
    try {
      const getConfirmation = vi.fn()
        .mockRejectedValueOnce(new Error('ipc down'))
        .mockRejectedValueOnce(new Error('ipc down'))
        .mockResolvedValue(flickerConfirmation(2))
      vi.stubGlobal('window', { api: { chatGetPendingConfirmation: getConfirmation, toolConfirmResponse: vi.fn() } })
      pendingConfirmStore.syncFromProjection(flickerArgs({ turnVersion: 1 }))
      await flushMicrotasks()
      // 退避窗口内版本推进（payload 不变，静默）——此后任何重试都不得回退到 v1
      pendingConfirmStore.syncFromProjection(flickerArgs({ turnVersion: 2 }))
      expect(getConfirmation).toHaveBeenCalledTimes(2)
      await flushMicrotasks()
      await vi.advanceTimersByTimeAsync(500)
      await flushMicrotasks()
      const retriedCalls = getConfirmation.mock.calls.slice(2)
      expect(retriedCalls.length).toBeGreaterThanOrEqual(1)
      for (const call of retriedCalls) {
        expect(call[0].turnVersion).toBe(2)
      }
      await vi.advanceTimersByTimeAsync(0)
      await flushMicrotasks()
      expect(pendingConfirmStore.getItems()[0]?.confirmationReady).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('turnId 变化而 payload 不变：不保留旧快照，按新 turn 重置并重拉（修 P2-4）', async () => {
    const getConfirmation = vi.fn().mockResolvedValue(flickerConfirmation(1))
    vi.stubGlobal('window', { api: { chatGetPendingConfirmation: getConfirmation, toolConfirmResponse: vi.fn() } })
    pendingConfirmStore.syncFromProjection({ ...flickerArgs({ turnVersion: 1 }), turnId: 't-old' })
    await flushMicrotasks()
    expect(pendingConfirmStore.getItems()[0]?.confirmationReady).toBe(true)
    pendingConfirmStore.syncFromProjection({ ...flickerArgs({ turnVersion: 1 }), turnId: 't-new' })
    expect(pendingConfirmStore.getItems()[0]?.confirmationReady).toBe(false)
    expect(getConfirmation).toHaveBeenCalledTimes(2)
    await flushMicrotasks()
    expect(pendingConfirmStore.getItems()[0]?.confirmationReady).toBe(true)
  })

  it('活性不变量：随机失败（stale/reject）× 竞态注入后，持续投影推进最终使全部存活项就绪（修 P2-5）', async () => {
    vi.useFakeTimers()
    try {
      let seed = 0x5eed1234
      const rand = (): number => {
        seed = (seed + 0x6d2b79f5) | 0
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      // 阶段 1：拉取结果恒失败（stale/reject 随机）——验证失败洪流下结构不坏、终局可收敛
      const getConfirmation = vi.fn().mockImplementation(() => {
        const roll = rand()
        if (roll < 0.5) return Promise.reject(new Error('flaky ipc'))
        return Promise.resolve({ status: 'stale' as const })
      })
      vi.stubGlobal('window', { api: { chatGetPendingConfirmation: getConfirmation, toolConfirmResponse: vi.fn() } })
      const payloadPool = [{ path: 'a.ts' }, { path: 'b.ts' }]
      let payloadIdx = 0
      let version = 0
      for (let step = 0; step < 40; step++) {
        if (rand() < 0.3) payloadIdx = Math.floor(rand() * payloadPool.length)
        pendingConfirmStore.syncFromProjection(flickerArgs({ turnVersion: ++version, input: payloadPool[payloadIdx] }))
        await vi.advanceTimersByTimeAsync(120)
        await flushMicrotasks()
      }
      // 活性终局：失败源移除后，有限步「payload 不变的版本推进投影」必须使全部存活项就绪
      vi.stubGlobal('window', { api: { chatGetPendingConfirmation: vi.fn().mockImplementation(() => Promise.resolve(flickerConfirmation(++version))), toolConfirmResponse: vi.fn() } })
      for (let step = 0; step < 15; step++) {
        pendingConfirmStore.syncFromProjection(flickerArgs({ turnVersion: ++version, input: payloadPool[payloadIdx] }))
        await vi.advanceTimersByTimeAsync(300)
        await flushMicrotasks()
        const items = pendingConfirmStore.getItems()
        if (items.length > 0 && items.every((item) => item.confirmationReady === true)) break
      }
      const finalItems = pendingConfirmStore.getItems()
      expect(finalItems.length).toBeGreaterThan(0)
      for (const item of finalItems) {
        expect(item.confirmationReady).toBe(true)
      }
    } finally {
      vi.useRealTimers()
    }
  })
})
