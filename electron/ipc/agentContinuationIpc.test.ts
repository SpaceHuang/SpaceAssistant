import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { appendMessage, createPersistedTurn, createSession, getDbConnection, getPersistedTurn } from '../database'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { createTurnCoordinatorStorage } from '../turnCoordinatorStorage'
import { TurnRuntime } from '../turnRuntime'
import { continueAgentFromCheckpoint, registerAgentContinuationIpc } from './agentProtocolIpc'
import type { AppIpcContext } from '../appIpc'

const safetySnapshot = {
  workDirProfileId: 'profile-a', workDirSha256: 'a'.repeat(64),
  authorizationVersion: 'b'.repeat(64), toolSetSha256: 'c'.repeat(64)
}

describe('chat:continue-from-checkpoint IPC orchestration', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined
  afterEach(() => { db?.close(); db = undefined; vi.restoreAllMocks() })

  async function setup() {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'continuation-ipc' })
    const user = appendMessage(db, { id: 'ipc-user', sessionId: session.id, role: 'user', content: 'continue the task', timestamp: 1, status: 'sent' })
    const assistant = appendMessage(db, { id: 'ipc-assistant', sessionId: session.id, role: 'assistant', content: 'provider failed', timestamp: 2, status: 'failed' })
    createPersistedTurn(db, {
      turnId: 'source-turn', requestId: 'source-invocation', sessionId: session.id,
      userMessageId: user.message.id, assistantMessageId: assistant.message.id,
      contextBoundarySequence: user.sequence - 1, state: 'terminal', outcome: 'failed', startToken: 'source-start',
      executionConfig: { lane: 'desktop', model: 'test-model', continuationSafetySnapshot: safetySnapshot }
    })
    const history = new SqliteAgentHistory(getDbConnection(db), 1, () => 10, session.id)
    const requiredUser = { id: user.message.id, message: { role: 'user' as const, content: 'continue the task' } }
    await history.appendBatch([
      { invocationId: 'source-invocation', turnId: 'source-turn', sequence: 1, schemaVersion: 1, eventId: 'source-context', idempotencyKey: 'source-context', kind: 'invocation-context-committed', payload: { messages: [requiredUser.message], requiredUserMessage: requiredUser } },
      { invocationId: 'source-invocation', turnId: 'source-turn', sequence: 2, schemaVersion: 1, eventId: 'source-response', idempotencyKey: 'source-response', kind: 'model-response-committed', payload: { message: { role: 'assistant', content: 'provider failed' } } },
      { invocationId: 'source-invocation', turnId: 'source-turn', sequence: 3, schemaVersion: 1, eventId: 'source-failed', idempotencyKey: 'source-failed', kind: 'invocation-failed', payload: { status: 'failed' } }
    ], 0)
    const runtime = new TurnRuntime({
      storage: createTurnCoordinatorStorage(db),
      deps: { now: () => 20, id: (() => { let id = 0; return () => `ipc-target-${++id}` })() }
    })
    const ctx = { db, executeTurn: vi.fn(async () => undefined) } as unknown as AppIpcContext
    return { session, user, history, runtime, ctx }
  }

  it('uses the frozen safety snapshot, prepares one fixed target Turn, and dispatches it only once per idempotency key', async () => {
    const { session, user, runtime, ctx } = await setup()
    const dispatch = vi.fn()
    const payload = { sessionId: session.id, sourceInvocationId: 'source-invocation', requestIdempotencyKey: 'ipc-idempotency' }
    const options = { ctx, turnRuntime: runtime, payload, dispatch, resolveCurrentSafetySnapshot: () => safetySnapshot }

    const accepted = await continueAgentFromCheckpoint(options)
    if (!accepted.accepted) throw new Error(accepted.reason)
    expect(accepted).toMatchObject({ accepted: true, status: 'running' })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledWith(null, {
      requestId: accepted.targetInvocationId,
      turnId: accepted.targetTurnId,
      turnStartToken: getPersistedTurn(db!, accepted.targetTurnId)?.startToken,
      sessionId: session.id
    }, accepted.continuationId)
    expect(getPersistedTurn(db!, accepted.targetTurnId)).toMatchObject({
      requestId: accepted.targetInvocationId, userMessageId: user.message.id, state: 'prepared',
      executionConfig: { lane: 'desktop', continuationSource: { continuationId: accepted.continuationId, invocationId: 'source-invocation', sourceTurnId: 'source-turn' } }
    })

    const duplicate = await continueAgentFromCheckpoint(options)
    expect(duplicate).toMatchObject({ accepted: true, continuationId: accepted.continuationId, targetTurnId: accepted.targetTurnId })
    expect(dispatch).toHaveBeenCalledOnce()
  })

  it('拒绝当前安全快照已变化的源 Turn，且不创建 continuation 或调度目标执行', async () => {
    const { session, runtime, ctx } = await setup()
    const dispatch = vi.fn()
    const result = await continueAgentFromCheckpoint({
      ctx, turnRuntime: runtime,
      payload: { sessionId: session.id, sourceInvocationId: 'source-invocation', requestIdempotencyKey: 'changed-safety' },
      dispatch,
      resolveCurrentSafetySnapshot: () => ({ ...safetySnapshot, authorizationVersion: 'd'.repeat(64) })
    })

    expect(result).toEqual({ accepted: false, reason: 'CONTINUATION_SAFETY_SNAPSHOT_CHANGED' })
    expect(dispatch).not.toHaveBeenCalled()
    expect(getDbConnection(db!).prepare('SELECT COUNT(*) AS count FROM agent_continuations').get()).toEqual({ count: 0 })
  })

  it('注册的 chat:continue-from-checkpoint handler 真实落到 admission 编排并返回 IPC response', async () => {
    const { session, runtime, ctx } = await setup()
    const dispatch = vi.fn()
    let handler: ((event: unknown, payload: { sessionId: string; sourceInvocationId: string; requestIdempotencyKey: string }) => unknown) | undefined
    const ipc = {
      handle: vi.fn((channel: string, callback: typeof handler) => {
        if (channel === 'chat:continue-from-checkpoint') handler = callback
      })
    }
    registerAgentContinuationIpc(ipc as never, {
      ctx, turnRuntime: runtime, dispatch,
      resolveCurrentSafetySnapshot: () => safetySnapshot
    })

    expect(ipc.handle).toHaveBeenCalledWith('chat:continue-from-checkpoint', expect.any(Function))
    const response = await handler?.({}, {
      sessionId: session.id, sourceInvocationId: 'source-invocation', requestIdempotencyKey: 'registered-channel'
    })
    expect(response).toMatchObject({ accepted: true, status: 'running' })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch).toHaveBeenCalledWith(null, expect.objectContaining({
      requestId: expect.any(String), turnId: expect.any(String), turnStartToken: expect.any(String), sessionId: session.id
    }), expect.any(String))
  })
})
