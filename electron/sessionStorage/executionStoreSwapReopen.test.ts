import { describe, expect, it } from 'vitest'
import { createTempDatabase } from '../database/testHelpers'
import { getDbConnection, reopenDatabaseConnection, type AppDatabase } from '../database/sqliteStore'
import { appendMessagesAtomically, createSession } from '../database/operations'
import { createSessionExecutionStore } from './execution'
import { createTurnCoordinatorStorage } from './coordinator'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import { createDeferredExecutionResultStore } from '../confirmation/deferredExecutionResultStore'
import { createDeferredTodoCapacityController } from '../confirmation/deferredTodoCapacity'
import { createRemoteAuthorizationEpochStore } from '../remote/remoteAuthorizationEpochStore'
import { createDeferredApprovalNotificationDelivery } from '../remote/deferredApprovalNotificationDelivery'
import { createDeferredApprovalIngress } from '../remote/deferredApprovalIngress'

/**
 * 压缩换入缺陷回归（评审 B1 红验证）：
 * 生产压缩换入序列为 db.close() → reopenDatabaseConnection(db)（sessionStorageMaintenance）。
 * 长寿命单例（execution store / coordinator / IM·remote 各 store）在工厂期捕获了底层 DatabaseSync，
 * 换入后闭包连接永久死亡，复用同一实例的调用抛 `database is not open` 且不可自愈。
 * 既有测试全部是「reopen 后重建 store」，恰好回避本缺陷——本文件核心场景是「复用 store 跨 reopen」。
 */
function swapConnection(db: AppDatabase): void {
  db.close()
  reopenDatabaseConnection(db)
}

const todoAuth = {
  channel: 'feishu' as const,
  identityKey: 'identity-1',
  ownerId: 'owner-1',
  authorizationEpoch: 8,
  originSessionId: 'origin-session-1',
  rule: { ruleId: 'rule-write', factsHash: 'a'.repeat(64) }
}

const trustedTodo = {
  todoId: 'todo-swap-1',
  channel: 'feishu' as const,
  identityKey: 'identity-1',
  ownerId: 'owner-1',
  authorizationEpoch: 8,
  rule: { ruleId: 'rule-write', factsHash: 'a'.repeat(64) },
  invocationId: 'swap-invocation-1',
  workflowId: 'workflow-1',
  taskId: 'task-1',
  stepId: 'step-1',
  planRevision: 2,
  originSessionId: 'origin-session-1',
  status: 'pending' as const,
  createdAt: 0,
  expiresAt: 0
}

describe('压缩换入后复用 store 跨 reopen（闭包连接现取化回归）', () => {
  it('execution store：复用同一实例跨换入后 continuation 意图读写不抛 database is not open', () => {
    const { db, cleanup } = createTempDatabase('exec-swap-reopen-')
    try {
      const session = createSession(db, { name: 'swap reopen', model: 'test' })
      const execution = createSessionExecutionStore(db)
      const enqueue = (requestId: string, payloadSha: string, text: string) => execution.enqueueContinuation({
        enqueue: { sessionId: session.id, requestId, content: text },
        intent: { payloadSha256: payloadSha, rawText: text, intentKind: 'follow-up', route: 'context-queue' }
      })
      enqueue('swap-req-1', 'a'.repeat(64), '继续找 wiki')
      expect(execution.readContinuationIntent({ requestId: 'swap-req-1', sessionId: session.id })).toMatchObject({ status: 'queued' })

      swapConnection(db)

      expect(execution.readContinuationIntent({ requestId: 'swap-req-1', sessionId: session.id })).toMatchObject({ status: 'queued' })
      enqueue('swap-req-2', 'b'.repeat(64), '接着做刚才的事')
      expect(execution.readContinuationIntent({ requestId: 'swap-req-2', sessionId: session.id })).toMatchObject({ status: 'queued' })
    } finally {
      cleanup()
    }
  })

  it('execution store：复用同一实例跨换入后 continuations createOrGet/claim/settle 正常', async () => {
    const { db, cleanup } = createTempDatabase('exec-swap-cont-')
    try {
      const session = createSession(db, { name: 'swap continuation', model: 'test' })
      const invocationId = 'swap-source-invocation'
      const turnId = 'swap-source-turn'
      const history = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id)
      await history.appendBatch([
        {
          invocationId, turnId, sequence: 1, schemaVersion: 1, eventId: `${invocationId}-ctx`, idempotencyKey: `${invocationId}-ctx`,
          kind: 'invocation-context-committed',
          payload: {
            messages: [{ id: 'swap-user-1', role: 'user', content: '原始任务' }],
            requiredUserMessage: { id: 'swap-user-1', message: { role: 'user', content: '原始任务' } }
          }
        },
        {
          invocationId, turnId, sequence: 2, schemaVersion: 1, eventId: `${invocationId}-resp`, idempotencyKey: `${invocationId}-resp`,
          kind: 'model-response-committed', payload: { message: { role: 'assistant', content: '进行中' } }
        },
        {
          invocationId, turnId, sequence: 3, schemaVersion: 1, eventId: `${invocationId}-end`, idempotencyKey: `${invocationId}-end`,
          kind: 'invocation-failed', payload: { status: 'failed', message: 'boom' }
        }
      ], 0)
      const execution = createSessionExecutionStore(db)
      const created = execution.continuations.createOrGet({
        sessionId: session.id, sourceInvocationId: invocationId, requestIdempotencyKey: 'swap-cont-key-1', createdBy: 'test', frozenConfig: {}
      })
      expect(created.status).toBe('pending')

      swapConnection(db)

      expect(execution.continuations.claim({ continuationId: created.continuationId, revalidatedFrozenConfig: {} })).toBe(true)
      expect(execution.continuations.settle({ continuationId: created.continuationId, status: 'cancelled' })).toBe(true)
      expect(execution.continuations.claim({ continuationId: 'missing-continuation', revalidatedFrozenConfig: {} })).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('coordinator：复用同一 storage 跨换入后 recoverTurn 正常收尾执行中回合', () => {
    const { db, cleanup } = createTempDatabase('coord-swap-reopen-')
    try {
      const session = createSession(db, { name: 'coordinator swap', model: 'test' })
      appendMessagesAtomically(db, [
        { id: 'coord-assistant', sessionId: session.id, role: 'assistant', content: 'partial', timestamp: 1, status: 'streaming' }
      ])
      getDbConnection(db).prepare('INSERT INTO turns(turn_id,request_id,session_id,assistant_message_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run('coord-turn', 'coord-request', session.id, 'coord-assistant', 'executing', 1, 1)
      const storage = createTurnCoordinatorStorage(db)

      swapConnection(db)

      expect(storage.recoverTurn('coord-turn', 'coord-assistant')).toBe(true)
      expect(getDbConnection(db).prepare('SELECT outcome FROM turns WHERE turn_id=?').get('coord-turn'))
        .toEqual({ outcome: 'recovered' })
    } finally {
      cleanup()
    }
  })

  it('deferredTodoStore：复用同一实例跨换入后延期审批读写正常', () => {
    const { db, cleanup } = createTempDatabase('todo-swap-reopen-')
    try {
      const store = createDeferredTodoStore(db)
      store.create({ ...trustedTodo, createdAt: Date.now(), expiresAt: Date.now() + 60_000 })
      expect(store.get('todo-swap-1', todoAuth)?.status).toBe('pending')

      swapConnection(db)

      expect(store.get('todo-swap-1', todoAuth)?.status).toBe('pending')
      const again = store.create({ ...trustedTodo, createdAt: Date.now(), expiresAt: Date.now() + 60_000 })
      expect(again.duplicate).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('remoteAuthorizationEpochStore：复用同一实例跨换入后 epoch 推进正常', () => {
    const { db, cleanup } = createTempDatabase('epoch-swap-reopen-')
    try {
      const store = createRemoteAuthorizationEpochStore(db)
      expect(store.current('feishu')).toBe(1)

      swapConnection(db)

      expect(store.current('feishu')).toBe(1)
      expect(store.advance('feishu', 'swap-reopen-revoke')).toBe(2)
      expect(store.completeRevocation('feishu', 2)).toBe(true)
      expect(store.pendingRevocations()).toEqual([])
    } finally {
      cleanup()
    }
  })

  it('deferredExecutionResultStore：复用同一实例跨换入后延期执行结果读写正常', () => {
    const { db, cleanup } = createTempDatabase('exec-result-swap-')
    try {
      const store = createDeferredExecutionResultStore(db)
      expect(store.listRecoverableSessionIds('feishu')).toEqual([])

      swapConnection(db)

      expect(store.listRecoverableSessionIds('feishu')).toEqual([])
      expect(store.listCompletionOutbox('missing-todo')).toEqual([])
    } finally {
      cleanup()
    }
  })

  it('deferredTodoCapacityController：复用同一实例跨换入后预留/释放正常（deferredTodoStore 的 capacity 回调面）', () => {
    const { db, cleanup } = createTempDatabase('capacity-swap-')
    try {
      const capacity = createDeferredTodoCapacityController(db)
      expect(capacity.reserve({
        reservationId: 'cap-1', invocationId: 'cap-inv-1', sessionId: 'cap-session-1', identityKey: 'cap-identity-1', state: 'pending'
      })).toMatchObject({ ok: true, duplicate: false })

      swapConnection(db)

      expect(capacity.releaseByInvocation('cap-inv-1')).toBe(true)
      expect(capacity.reserve({
        reservationId: 'cap-2', invocationId: 'cap-inv-2', sessionId: 'cap-session-1', identityKey: 'cap-identity-1', state: 'pending'
      })).toMatchObject({ ok: true, duplicate: false })
    } finally {
      cleanup()
    }
  })

  it('deferredApprovalNotificationDelivery：复用同一实例跨换入后通知读写正常', () => {
    const { db, cleanup } = createTempDatabase('delivery-swap-')
    try {
      const delivery = createDeferredApprovalNotificationDelivery({
        db,
        todoStore: { get: () => null },
        intentStore: { authorizeResume: () => false },
        adapter: { send: async () => undefined },
        audit: () => {}
      } as unknown as Parameters<typeof createDeferredApprovalNotificationDelivery>[0])
      expect(delivery.list('missing-todo')).toEqual([])

      swapConnection(db)

      expect(delivery.list('missing-todo')).toEqual([])
      expect(delivery.resolveCurrent({ channel: 'feishu', identityKey: 'i', ownerId: 'o', authorizationEpoch: 3, shortCode: '07', now: Date.now() })).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('deferredApprovalIngress：复用同一实例跨换入后幂等回执查询正常', async () => {
    const { db, cleanup } = createTempDatabase('ingress-swap-')
    try {
      const binding = {
        channel: 'feishu' as const, identityKey: 'i', ownerId: 'o', todoId: 'todo-1', notificationVersion: 1,
        currentNotificationVersion: 1, trustedMessageId: 'msg-1', shortCode: '07', expiresAt: Date.now() + 60_000,
        authorizationEpoch: 3, rule: { ruleId: 'r', factsHash: 'a'.repeat(64) }
      }
      const ingress = createDeferredApprovalIngress({
        db,
        isEnabled: () => true,
        resolveNotification: () => [binding],
        requestResume: async () => ({ status: 'resume_requested' as const, duplicate: false }),
        audit: () => {}
      } as unknown as Parameters<typeof createDeferredApprovalIngress>[0])
      const request = { channel: 'feishu' as const, identityKey: 'i', ownerId: 'o', messageId: 'im-1', replyToMessageId: 'msg-1', text: '批准 07', now: Date.now() }
      // 无 getTodo 时 handle 走到幂等回执 SELECT 后按 rejected 收尾（注入依赖最小化）
      expect((await ingress.handle(request)).status).toBe('rejected')

      swapConnection(db)

      expect((await ingress.handle({ ...request, messageId: 'im-2' })).status).toBe('rejected')
    } finally {
      cleanup()
    }
  })
})
