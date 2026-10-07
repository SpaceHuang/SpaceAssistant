import { describe, expect, it, vi } from 'vitest'
import { executeRemoteTurn } from './turnExecutionAdapter'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession, getPersistedTurn } from '../database'
import { createTurnCoordinatorStorage } from '../sessionStorage/coordinator'
import { TurnRuntime } from '../turnRuntime'
import { HostedTurnFinalizedError } from '../runtime/hostedTurnFinalization'

describe('executeRemoteTurn', () => {
  it('binds prepared request to its turn before consuming the remote terminal fact', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'remote-terminal-binding' })
    let sequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `remote-binding-id-${++sequence}` } })
    const prepared = runtime.prepare({ mode: 'create-user', requestId: 'remote-binding-request', sessionId: session.id, input: { text: 'run' }, config: {} })
    const run = vi.fn().mockResolvedValue({ ok: true, summary: 'completed' })

    await expect(executeRemoteTurn({ runtime, prepared, requestId: prepared.requestId, run })).resolves.toMatchObject({ ok: true, summary: 'completed' })

    expect(run).toHaveBeenCalledOnce()
    expect(getPersistedTurn(db, prepared.turnId)).toMatchObject({ state: 'terminal', outcome: 'completed' })
    expect(() => runtime.consumeForRequest(prepared.requestId, { type: 'raw-delta', text: 'late' })).toThrow('unknown turn request')
    db.close()
  })

  it('does not reuse a completed result for the same requestId in another runtime database', async () => {
    const firstDb = createMemoryAppDb()
    const firstSession = createSession(firstDb, { name: 'remote-result-cache-first' })
    let firstSequence = 0
    const firstRuntime = new TurnRuntime({ storage: createTurnCoordinatorStorage(firstDb), deps: { now: () => 1, id: () => `remote-cache-first-${++firstSequence}` } })
    const firstPrepared = firstRuntime.prepare({ mode: 'create-user', requestId: 'shared-remote-request', sessionId: firstSession.id, input: { text: 'first' }, config: {} })
    await executeRemoteTurn({
      runtime: firstRuntime, prepared: firstPrepared, requestId: firstPrepared.requestId,
      run: vi.fn().mockResolvedValue({ ok: true, summary: 'first database result' })
    })

    const secondDb = createMemoryAppDb()
    const secondSession = createSession(secondDb, { name: 'remote-result-cache-second' })
    let secondSequence = 0
    const secondRuntime = new TurnRuntime({ storage: createTurnCoordinatorStorage(secondDb), deps: { now: () => 2, id: () => `remote-cache-second-${++secondSequence}` } })
    const secondPrepared = secondRuntime.prepare({ mode: 'create-user', requestId: 'shared-remote-request', sessionId: secondSession.id, input: { text: 'second' }, config: {} })
    await secondRuntime.executeWithSource(secondPrepared.turnId, secondPrepared.startToken, async () => ({ outcome: 'failed' as const }))

    const run = vi.fn()
    const recovered = await executeRemoteTurn({ runtime: secondRuntime, prepared: secondPrepared, requestId: secondPrepared.requestId, run })

    expect(recovered).toMatchObject({ ok: false, outcome: 'failed' })
    expect(recovered).not.toMatchObject({ summary: 'first database result' })
    expect(run).not.toHaveBeenCalled()
    expect(getPersistedTurn(secondDb, secondPrepared.turnId)).toMatchObject({ state: 'terminal', outcome: 'failed' })
    firstDb.close()
    secondDb.close()
  })

  it('keeps completed remote retry results isolated by turn when sessions share a requestId', async () => {
    const db = createMemoryAppDb()
    const sessionA = createSession(db, { name: 'remote-result-same-runtime-a' })
    const sessionB = createSession(db, { name: 'remote-result-same-runtime-b' })
    let sequence = 0
    const projections: Array<{ turnId: string; sessionId: string; text: string }> = []
    const runtime = new TurnRuntime({
      storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `remote-cache-shared-${++sequence}` },
      onEvent: (turn, event) => { if (event.type === 'content-delta') projections.push({ turnId: turn.turnId, sessionId: turn.sessionId, text: event.text }) }
    })
    const preparedA = runtime.prepare({ mode: 'create-user', requestId: 'shared-request', sessionId: sessionA.id, input: { text: 'A' }, config: {} })
    const preparedB = runtime.prepare({ mode: 'create-user', requestId: 'shared-request', sessionId: sessionB.id, input: { text: 'B' }, config: {} })

    await Promise.all([
      executeRemoteTurn({ runtime, prepared: preparedA, requestId: preparedA.requestId, run: async () => {
        runtime.consumeForRequest('shared-request', { type: 'content-delta', text: 'A-fact' }, preparedA.turnId)
        await Promise.resolve()
        return { ok: true, summary: 'A-result' }
      } }),
      executeRemoteTurn({ runtime, prepared: preparedB, requestId: preparedB.requestId, run: async () => {
        runtime.consumeForRequest('shared-request', { type: 'content-delta', text: 'B-fact' }, preparedB.turnId)
        await Promise.resolve()
        return { ok: true, summary: 'B-result' }
      } })
    ])
    const retryRun = vi.fn()
    const retriedA = await executeRemoteTurn({ runtime, prepared: preparedA, requestId: preparedA.requestId, run: retryRun })

    expect(retriedA).toMatchObject({ ok: true, summary: 'A-result' })
    expect(projections).toEqual([
      { turnId: preparedA.turnId, sessionId: sessionA.id, text: 'A-fact' },
      { turnId: preparedB.turnId, sessionId: sessionB.id, text: 'B-fact' }
    ])
    expect(retryRun).not.toHaveBeenCalled()
    db.close()
  })

  it.each([
    { outcome: 'completed' as const, ok: true, state: 'completed' as const },
    { outcome: 'failed' as const, ok: false, state: 'failed' as const },
    { outcome: 'cancelled' as const, ok: false, state: 'cancelled' as const },
    { outcome: 'timed-out' as const, ok: false, state: 'timed-out' as const }
  ])('persists the $outcome terminal outcome through real SQLite TurnRuntime', async ({ outcome, ok, state }) => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: `remote-terminal-${outcome}` })
    let sequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `remote-${outcome}-${++sequence}` } })
    const prepared = runtime.prepare({ mode: 'create-user', requestId: `remote-${outcome}-request`, sessionId: session.id, input: { text: 'run' }, config: {} })

    const result = await executeRemoteTurn({
      runtime, prepared, requestId: prepared.requestId,
      run: vi.fn().mockResolvedValue({ ok, ...(outcome === 'completed' ? {} : { outcome }), summary: outcome })
    })

    expect(result).toMatchObject({ ok, ...(outcome === 'completed' ? {} : { outcome }) })
    expect(getPersistedTurn(db, prepared.turnId)).toMatchObject({ state: 'terminal', outcome: state })
    db.close()
  })

  it('persists timed-out as a distinct outcome through a real SQLite TurnRuntime', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'remote-timeout-recovery' })
    let sequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `remote-timeout-id-${++sequence}` } })
    const prepared = runtime.prepare({ mode: 'create-user', requestId: 'remote-timeout-request', sessionId: session.id, input: { text: 'run' }, config: {} })
    runtime.bindRequest(prepared.requestId, prepared.turnId)

    await executeRemoteTurn({
      runtime, prepared, requestId: prepared.requestId,
      run: vi.fn().mockResolvedValue({ ok: false, outcome: 'timed-out' as const, summary: 'timed out' })
    })

    expect(getPersistedTurn(db, prepared.turnId)).toMatchObject({ state: 'terminal', outcome: 'timed-out' })
  })

  it.each([
    { outcome: 'failed' as const, expected: 'failed' as const },
    { outcome: 'cancelled' as const, expected: 'cancelled' as const },
    { outcome: 'timed-out' as const, expected: 'timed-out' as const }
  ])('新进程从 SQLite 恢复 $outcome terminal 时不重跑远端执行', async ({ outcome, expected }) => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: `remote-recovered-${outcome}` })
    const intent = { mode: 'create-user' as const, requestId: `remote-recovered-${outcome}-request`, sessionId: session.id, input: { text: 'run' }, config: {} }
    let sequence = 0
    const firstRuntime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `remote-first-${++sequence}` } })
    const firstPrepared = firstRuntime.prepare(intent)
    const firstRun = vi.fn().mockResolvedValue({ ok: false, outcome, summary: outcome })
    const firstResult = await executeRemoteTurn({ runtime: firstRuntime, prepared: firstPrepared, requestId: firstPrepared.requestId, run: firstRun })

    const restartedRuntime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 2, id: () => `remote-restart-${++sequence}` } })
    const recovered = restartedRuntime.prepare(intent)
    const retryRun = vi.fn()
    const retryResult = await executeRemoteTurn({ runtime: restartedRuntime, prepared: recovered, requestId: recovered.requestId, run: retryRun })

    expect(firstResult).toMatchObject({ ok: false, outcome: expected })
    expect(retryResult).toMatchObject({ ok: false, outcome: expected })
    expect(firstRun).toHaveBeenCalledOnce()
    expect(retryRun).not.toHaveBeenCalled()
    expect(getPersistedTurn(db, recovered.turnId)).toMatchObject({ state: 'terminal', outcome: expected })
    db.close()
  })

  it.each([
    ['cancelled', 'source-cancelled'],
    ['timed-out', 'source-timeout']
  ] as const)('preserves Hosted %s through real SQLite TurnRuntime when remote run throws', async (outcome, factType) => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: `remote-hosted-${outcome}` })
    let sequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `remote-hosted-${outcome}-${++sequence}` } })
    const prepared = runtime.prepare({ mode: 'create-user', requestId: `remote-hosted-${outcome}-request`, sessionId: session.id, input: { text: 'run' }, config: {} })
    const run = vi.fn().mockRejectedValue(new HostedTurnFinalizedError(new Error(`hosted ${outcome}`), outcome))

    const result = await executeRemoteTurn({ runtime, prepared, requestId: prepared.requestId, run })

    expect(result).toMatchObject({ ok: false, outcome, summary: `hosted ${outcome}` })
    expect(getPersistedTurn(db, prepared.turnId)).toMatchObject({ state: 'terminal', outcome })
    expect(run).toHaveBeenCalledOnce()
    expect(() => runtime.consumeForRequest(prepared.requestId, { type: 'raw-delta', text: 'late' })).toThrow('unknown turn request')
    db.close()
  })

  it('preserves canonical interrupted outcome as recovered in TurnRuntime', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'remote-hosted-interrupted' })
    let sequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `remote-interrupted-${++sequence}` } })
    const prepared = runtime.prepare({ mode: 'create-user', requestId: 'remote-interrupted-request', sessionId: session.id, input: { text: 'run' }, config: {} })
    const run = vi.fn().mockRejectedValue(new HostedTurnFinalizedError(new Error('host interrupted'), 'interrupted'))

    const result = await executeRemoteTurn({
      runtime,
      prepared,
      requestId: prepared.requestId,
      run
    })
    const retryRun = vi.fn()
    const retry = await executeRemoteTurn({ runtime, prepared, requestId: prepared.requestId, run: retryRun })

    expect(result).toMatchObject({ ok: false, outcome: 'interrupted', error: 'host interrupted' })
    expect(retry).toEqual(result)
    expect(run).toHaveBeenCalledOnce()
    expect(retryRun).not.toHaveBeenCalled()
    expect(getPersistedTurn(db, prepared.turnId)).toMatchObject({ state: 'terminal', outcome: 'recovered' })
    db.close()
  })

  it('preserves Hosted commit-uncertain instead of projecting it as an ordinary source failure', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'remote-hosted-commit-uncertain' })
    let sequence = 0
    const runtime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `remote-uncertain-${++sequence}` } })
    const intent = { mode: 'create-user' as const, requestId: 'remote-uncertain-request', sessionId: session.id, input: { text: 'run' }, config: {} }
    const prepared = runtime.prepare(intent)
    const cause = new Error('SESSION_TRANSCRIPT_COMMIT_UNCERTAIN:checkpoint-write-failed')
    const run = vi.fn().mockRejectedValue(new HostedTurnFinalizedError(cause, 'commit-uncertain'))
    const projections: Array<{ event: { type: string }; turn: { assistantMessage: { status: string } } }> = []
    runtime.subscribe((turn, event) => projections.push({ turn, event }))

    const result = await executeRemoteTurn({ runtime, prepared, requestId: prepared.requestId, run })

    expect(result).toMatchObject({ ok: false, outcome: 'commit-uncertain', error: cause.message })
    expect(getPersistedTurn(db, prepared.turnId)).toMatchObject({ state: 'terminal', outcome: 'commit-uncertain' })
    expect(projections).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ type: 'source-uncertain', message: cause.message }), turn: expect.objectContaining({ assistantMessage: expect.objectContaining({ status: 'failed' }) }) }))
    expect(run).toHaveBeenCalledOnce()

    const restartedRuntime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 2, id: () => `remote-uncertain-restart-${++sequence}` } })
    const restartedPrepared = restartedRuntime.prepare(intent)
    const retryRun = vi.fn()
    await expect(executeRemoteTurn({ runtime: restartedRuntime, prepared: restartedPrepared, requestId: prepared.requestId, run: retryRun }))
      .resolves.toMatchObject({ ok: false, outcome: 'commit-uncertain', error: cause.message })
    expect(retryRun).not.toHaveBeenCalled()
    db.close()
  })

  it('新进程从 SQLite 恢复 recovered interrupted 时返回稳定失败且不重跑 provider', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'remote-interrupted-restart' })
    const intent = { mode: 'create-user' as const, requestId: 'remote-interrupted-restart-request', sessionId: session.id, input: { text: 'run' }, config: {} }
    let sequence = 0
    const firstRuntime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 1, id: () => `remote-interrupted-first-${++sequence}` } })
    const firstPrepared = firstRuntime.prepare(intent)
    await firstRuntime.executeWithSource(firstPrepared.turnId, firstPrepared.startToken, async () => ({
      outcome: 'recovered', error: { code: 'HOSTED_TURN_INTERRUPTED', message: 'process restart' }
    }))

    const restartedRuntime = new TurnRuntime({ storage: createTurnCoordinatorStorage(db), deps: { now: () => 2, id: () => `remote-interrupted-restart-${++sequence}` } })
    const recovered = restartedRuntime.prepare(intent)
    const run = vi.fn()
    const result = await executeRemoteTurn({ runtime: restartedRuntime, prepared: recovered, requestId: recovered.requestId, run })

    expect(getPersistedTurn(db, recovered.turnId)).toMatchObject({ state: 'terminal', outcome: 'recovered' })
    expect(result).toMatchObject({ ok: false, outcome: 'interrupted', error: 'process restart' })
    expect(run).not.toHaveBeenCalled()
    db.close()
  })

  it('preserves timed-out outcome in the TurnRuntime terminal result', async () => {
    const consumeForRequest = vi.fn()
    const runtime = {
      bindRequest: vi.fn(),
      unbindRequest: vi.fn(),
      executeWithSource: vi.fn(async (_turnId, _token, source) => source({} as never, 'token')),
      consumeForRequest
    } as never

    await executeRemoteTurn({
      runtime,
      prepared: { turnId: 'timeout-turn', requestId: 'timeout-request', sessionId: 's1', assistantMessage: {} as never, version: 0, startToken: 'token' },
      requestId: 'timeout-request',
      run: vi.fn().mockResolvedValue({ ok: false, outcome: 'timed-out' as const, summary: 'timed out' })
    })

    await expect(runtime.executeWithSource.mock.results[0]?.value).resolves.toMatchObject({ outcome: 'timed-out' })
    expect(consumeForRequest).toHaveBeenCalledWith('timeout-request', { type: 'source-timeout' }, 'timeout-turn')
  })

  it('persists automation usageJson through the TurnRuntime terminal result', async () => {
    const runtime = {
      bindRequest: vi.fn(),
      unbindRequest: vi.fn(),
      executeWithSource: vi.fn(async (_turnId, _token, source) => source({} as never, 'token')),
      consumeForRequest: vi.fn()
    } as never
    const usageJson = JSON.stringify({ input_tokens: 10, output_tokens: 4 })

    await executeRemoteTurn({
      runtime,
      prepared: { turnId: 'usage-turn', requestId: 'usage-request', sessionId: 's1', assistantMessage: {} as never, version: 0, startToken: 'token' },
      requestId: 'usage-request',
      run: vi.fn().mockResolvedValue({ ok: true, summary: 'done', usageJson })
    })

    await expect(runtime.executeWithSource.mock.results[0]?.value).resolves.toMatchObject({
      outcome: 'completed', usage: { input_tokens: 10, output_tokens: 4 }
    })
  })

  it.each(['desktop', 'wechat', 'feishu'] as const)('%s 入口共享同一 prepare/execute/terminal 契约', async (entry) => {
    const consumeForRequest = vi.fn()
    const runtime = {
      bindRequest: vi.fn(),
      unbindRequest: vi.fn(),
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
    expect(consumeForRequest).toHaveBeenCalledWith(requestId, { type: 'source-completed' }, prepared.turnId)
  })

  it.each(['desktop', 'wechat', 'feishu'] as const)('%s 入口重试复用 terminal，不重复调用 provider', async (entry) => {
    const consumeForRequest = vi.fn()
    let executionCount = 0
    const runtime = {
      bindRequest: vi.fn(),
      unbindRequest: vi.fn(),
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

  it('终态持久化失败后重试不返回尚未提交的成功缓存', async () => {
    const persistenceFailure = new Error('terminal persistence failed')
    let executionCount = 0
    const runtime = {
      bindRequest: vi.fn(),
      unbindRequest: vi.fn(),
      executeWithSource: vi.fn(async (_turnId, _token, source) => {
        if (executionCount++ === 0) return source({} as never, 'token')
        return { outcome: 'failed' as const }
      }),
      consumeForRequest: vi.fn(() => { throw persistenceFailure })
    } as never
    const prepared = {
      turnId: 'terminal-persistence-turn', requestId: 'terminal-persistence-request', sessionId: 's1',
      assistantMessage: {} as never, version: 0, startToken: 'token'
    }

    await expect(executeRemoteTurn({
      runtime, prepared, requestId: prepared.requestId, run: vi.fn().mockResolvedValue({ ok: true, summary: 'not committed' })
    })).rejects.toBe(persistenceFailure)

    await expect(executeRemoteTurn({ runtime, prepared, requestId: prepared.requestId, run: vi.fn() }))
      .resolves.toMatchObject({ ok: false })
  })

  it.each(['desktop', 'wechat', 'feishu'] as const)('%s 入口跨进程恢复 terminal 时不要求重新执行 provider', async (entry) => {
    const consumeForRequest = vi.fn()
    const run = vi.fn()
    const runtime = {
      bindRequest: vi.fn(),
      unbindRequest: vi.fn(),
      executeWithSource: vi.fn().mockResolvedValue({ outcome: 'completed' as const, usage: { modelTurns: 1, initialMessageCount: 1, messages: 2 } }),
      consumeForRequest
    } as never

    const result = await executeRemoteTurn({
      runtime,
      prepared: { turnId: `recovered-${entry}`, requestId: `recovered-${entry}`, sessionId: 's1', assistantMessage: { content: 'persisted answer' } as never, version: 6, startToken: 'recovered-token' },
      requestId: `recovered-${entry}`,
      run
    })

    expect(result).toMatchObject({ ok: true, summary: 'persisted answer', usageJson: JSON.stringify({ modelTurns: 1, initialMessageCount: 1, messages: 2 }) })
    expect(run).not.toHaveBeenCalled()
    expect(consumeForRequest).not.toHaveBeenCalled()
  })

  it.each([
    ['cancelled', false],
    ['timed-out', false]
  ] as const)('跨进程恢复 %s outcome 返回稳定失败契约且不重新执行 provider', async (outcome, ok) => {
    const runtime = {
      bindRequest: vi.fn(),
      unbindRequest: vi.fn(),
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

    expect(result).toMatchObject({ ok, outcome })
    expect(run).not.toHaveBeenCalled()
    expect(runtime.consumeForRequest).not.toHaveBeenCalled()
  })

  it.each([
    [true, 'source-completed'],
    [false, 'source-failed']
  ] as const)('统一映射 remote %s 结果到 terminal fact %s', async (ok, eventType) => {
    const consumeForRequest = vi.fn()
    const runtime = {
      bindRequest: vi.fn(),
      unbindRequest: vi.fn(),
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
    expect(consumeForRequest).toHaveBeenCalledWith(`r-${ok}`, { type: eventType }, `t-${ok}`)
  })

  it('remote cancelled 结果映射为 source-cancelled，而不是 source-failed', async () => {
    const consumeForRequest = vi.fn()
    const runtime = {
      bindRequest: vi.fn(),
      unbindRequest: vi.fn(),
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
    expect(consumeForRequest).toHaveBeenCalledWith('cancel-request', { type: 'source-cancelled' }, 'cancel-turn')
  })

  it('有 prepared turn 时只通过 runtime execute 并消费一次 terminal', async () => {
    const consumeForRequest = vi.fn()
    const runtime = {
      bindRequest: vi.fn(),
      unbindRequest: vi.fn(),
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
    expect(consumeForRequest).toHaveBeenCalledWith('r1', { type: 'source-completed' }, 't1')
  })

  it('无 prepared turn 时拒绝执行，不回退到独立事实写入路径', async () => {
    const run = vi.fn().mockResolvedValue({ ok: false, summary: 'failed' })
    await expect(executeRemoteTurn({ requestId: 'r2', run })).rejects.toThrow('REMOTE_TURN_REQUIRES_RUNTIME')
    expect(run).not.toHaveBeenCalled()
  })

  it('remote source 抛错时先通过 Core 消费 source-failed，再向调用方传播异常', async () => {
    const consumeForRequest = vi.fn()
    const runtime = {
      bindRequest: vi.fn(),
      unbindRequest: vi.fn(),
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
    expect(consumeForRequest).toHaveBeenCalledWith('r3', { type: 'source-failed' }, 't3')
  })
})
