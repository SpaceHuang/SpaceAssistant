import { describe, expect, it, vi } from 'vitest'
import { executeRemoteTurn } from './turnExecutionAdapter'

describe('executeRemoteTurn', () => {
  it.each(['desktop', 'wechat', 'feishu'] as const)('%s 入口共享同一 prepare/execute/terminal 契约', async (entry) => {
    const consumeForRequest = vi.fn()
    const runtime = {
      executeWithSource: vi.fn(async (_turnId, _token, source) => source({} as never, 'token')),
      consumeForRequest
    } as never
    const requestId = `matrix-${entry}`
    const prepared = {
      turnId: `turn-${entry}`,
      requestId,
      sessionId: 's1',
      assistantMessage: {} as never,
      version: 0,
      startToken: 'token'
    }
    const result = await executeRemoteTurn({
      runtime,
      prepared,
      requestId,
      run: vi.fn().mockResolvedValue({ ok: true, summary: entry })
    })
    expect(result).toMatchObject({ ok: true, summary: entry })
    expect(runtime.executeWithSource).toHaveBeenCalledOnce()
    expect(consumeForRequest).toHaveBeenCalledWith(requestId, { type: 'source-completed' })
  })

  it.each(['desktop', 'wechat', 'feishu'] as const)('%s 入口重试复用 terminal，不重复调用 provider', async (entry) => {
    const consumeForRequest = vi.fn()
    let executionCount = 0
    const runtime = {
      executeWithSource: vi.fn(async (_turnId, _token, source) => {
        if (executionCount++ === 0) return source({} as never, 'token')
        return { outcome: 'completed' as const, usage: { output_tokens: 2 } }
      }),
      consumeForRequest
    } as never
    const run = vi.fn().mockResolvedValue({ ok: true, summary: entry })
    const prepared = {
      turnId: `retry-turn-${entry}`,
      requestId: `retry-request-${entry}`,
      sessionId: 's1',
      assistantMessage: {} as never,
      version: 0,
      startToken: 'token'
    }

    const first = await executeRemoteTurn({ runtime, prepared, requestId: prepared.requestId, run })
    const retry = await executeRemoteTurn({ runtime, prepared, requestId: prepared.requestId, run })

    expect(first).toEqual(retry)
    expect(run).toHaveBeenCalledOnce()
    expect(runtime.executeWithSource).toHaveBeenCalledTimes(2)
    expect(consumeForRequest).toHaveBeenCalledOnce()
  })

  it.each(['desktop', 'wechat', 'feishu'] as const)('%s 入口跨进程恢复 terminal 时不要求重新执行 provider', async (entry) => {
    const consumeForRequest = vi.fn()
    const run = vi.fn()
    const runtime = {
      executeWithSource: vi.fn().mockResolvedValue({ outcome: 'completed' as const, usage: { output_tokens: 4 } }),
      consumeForRequest
    } as never

    const result = await executeRemoteTurn({
      runtime,
      prepared: { turnId: `recovered-${entry}`, requestId: `recovered-${entry}`, sessionId: 's1', assistantMessage: {} as never, version: 6, startToken: 'recovered-token' },
      requestId: `recovered-${entry}`,
      run
    })

    expect(result).toMatchObject({ ok: true })
    expect(run).not.toHaveBeenCalled()
    expect(consumeForRequest).not.toHaveBeenCalled()
  })

  it.each([
    ['cancelled', false],
    ['timed-out', false]
  ] as const)('跨进程恢复 %s outcome 返回稳定失败契约且不重新执行 provider', async (outcome, ok) => {
    const runtime = {
      executeWithSource: vi.fn().mockResolvedValue({ outcome } as const),
      consumeForRequest: vi.fn()
    } as never
    const run = vi.fn()

    const result = await executeRemoteTurn({
      runtime,
      prepared: { turnId: `recovered-${outcome}`, requestId: `recovered-${outcome}`, sessionId: 's1', assistantMessage: {} as never, version: 9, startToken: 'token' },
      requestId: `recovered-${outcome}`,
      run
    })

    expect(result).toMatchObject({ ok })
    expect(run).not.toHaveBeenCalled()
    expect(runtime.consumeForRequest).not.toHaveBeenCalled()
  })

  it.each([
    [true, 'source-completed'],
    [false, 'source-failed']
  ] as const)('统一映射 remote %s 结果到 terminal fact %s', async (ok, eventType) => {
    const consumeForRequest = vi.fn()
    const runtime = {
      executeWithSource: vi.fn(async (_turnId, _token, source) => source({} as never, 'token')),
      consumeForRequest
    } as never
    const result = await executeRemoteTurn({
      runtime,
      prepared: { turnId: `t-${ok}`, requestId: `r-${ok}`, sessionId: 's1', assistantMessage: {} as never, version: 0, startToken: 'token' },
      requestId: `r-${ok}`,
      run: vi.fn().mockResolvedValue({ ok, summary: ok ? 'done' : 'failed' })
    })
    expect(result.ok).toBe(ok)
    expect(consumeForRequest).toHaveBeenCalledWith(`r-${ok}`, { type: eventType })
  })

  it('remote cancelled 结果映射为 source-cancelled，而不是 source-failed', async () => {
    const consumeForRequest = vi.fn()
    const runtime = {
      executeWithSource: vi.fn(async (_turnId, _token, source) => source({} as never, 'token')),
      consumeForRequest
    } as never
    const result = await executeRemoteTurn({
      runtime,
      prepared: { turnId: 'cancel-turn', requestId: 'cancel-request', sessionId: 's1', assistantMessage: {} as never, version: 0, startToken: 'token' },
      requestId: 'cancel-request',
      run: vi.fn().mockResolvedValue({ ok: false, outcome: 'cancelled' as const, summary: 'cancelled' })
    })
    expect(result).toMatchObject({ ok: false, outcome: 'cancelled' })
    expect(consumeForRequest).toHaveBeenCalledWith('cancel-request', { type: 'source-cancelled' })
  })

  it('有 prepared turn 时只通过 runtime execute 并消费一次 terminal', async () => {
    const consumeForRequest = vi.fn()
    const runtime = {
      executeWithSource: vi.fn(async (_turnId, _token, source) => source({} as never, 'token')),
      consumeForRequest
    } as never
    const result = await executeRemoteTurn({
      runtime,
      prepared: { turnId: 't1', requestId: 'r1', sessionId: 's1', assistantMessage: {} as never, version: 0, startToken: 'token' },
      requestId: 'r1',
      run: vi.fn().mockResolvedValue({ ok: true, summary: 'done' })
    })
    expect(result).toMatchObject({ ok: true, summary: 'done' })
    expect(runtime.executeWithSource).toHaveBeenCalledOnce()
    expect(consumeForRequest).toHaveBeenCalledTimes(1)
    expect(consumeForRequest).toHaveBeenCalledWith('r1', { type: 'source-completed' })
  })

  it('无 prepared turn 时拒绝执行，不回退到独立事实写入路径', async () => {
    const run = vi.fn().mockResolvedValue({ ok: false, summary: 'failed' })
    await expect(executeRemoteTurn({ requestId: 'r2', run })).rejects.toThrow('REMOTE_TURN_REQUIRES_RUNTIME')
    expect(run).not.toHaveBeenCalled()
  })

  it('remote source 抛错时先通过 Core 消费 source-failed，再向调用方传播异常', async () => {
    const consumeForRequest = vi.fn()
    const runtime = {
      executeWithSource: vi.fn(async (_turnId, _token, source) => source({} as never, 'token')),
      consumeForRequest
    } as never
    const error = new Error('remote provider failed')
    await expect(executeRemoteTurn({
      runtime,
      prepared: { turnId: 't3', requestId: 'r3', sessionId: 's1', assistantMessage: {} as never, version: 0, startToken: 'token' },
      requestId: 'r3',
      run: vi.fn().mockRejectedValue(error)
    })).rejects.toBe(error)
    expect(consumeForRequest).toHaveBeenCalledWith('r3', { type: 'source-failed' })
  })
})
