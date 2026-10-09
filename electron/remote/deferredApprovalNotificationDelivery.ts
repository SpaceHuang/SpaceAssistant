import type { AppDatabase } from '../database/sqliteStore'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import type { createDeferredTodoStore } from '../confirmation/deferredTodoStore'
import type { createSecurityActionIntentStore } from '../confirmation/securityActionIntentStore'
import { allocateDeferredApprovalShortCode } from './deferredApprovalIngress'
import { buildDeferredApprovalNotification, type DeferredApprovalNotificationDto } from './deferredApprovalNotification'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'
import { buildDeferredApprovalAuditEvent } from '../confirmation/deferredApprovalAudit'

type TodoStore = ReturnType<typeof createDeferredTodoStore>
type IntentStore = ReturnType<typeof createSecurityActionIntentStore>
type Scope = { channel: 'feishu' | 'wechat'; identityKey: string; ownerId: string; authorizationEpoch: number }
type NotificationRow = {
  todo_id: string; notification_version: number; invocation_id: string; channel: Scope['channel']; identity_key: string; owner_id: string
  authorization_epoch: number; rule_id: string; facts_hash: string; short_code: string; trusted_message_id: string | null
  expires_at: number; dto_json: string; state: 'undelivered' | 'delivered' | 'superseded' | 'invalidated'; created_at: number; updated_at: number
}

function mapRow(row: NotificationRow) {
  return {
    todoId: row.todo_id, notificationVersion: row.notification_version, invocationId: row.invocation_id,
    channel: row.channel, identityKey: row.identity_key, ownerId: row.owner_id, authorizationEpoch: row.authorization_epoch,
    rule: { ruleId: row.rule_id, factsHash: row.facts_hash }, shortCode: row.short_code,
    trustedMessageId: row.trusted_message_id, expiresAt: row.expires_at,
    dto: JSON.parse(row.dto_json) as DeferredApprovalNotificationDto, state: row.state,
    createdAt: row.created_at, updatedAt: row.updated_at
  }
}

const COLUMNS = `todo_id,notification_version,invocation_id,channel,identity_key,owner_id,authorization_epoch,rule_id,facts_hash,
  short_code,trusted_message_id,expires_at,dto_json,state,created_at,updated_at`

export function createDeferredApprovalNotificationDelivery(input: {
  db: AppDatabase
  todoStore: TodoStore
  intentStore: IntentStore
  adapter: { send(dto: DeferredApprovalNotificationDto, recipient: Pick<Scope, 'channel' | 'identityKey' | 'ownerId'>): Promise<{ messageId: string } | string | void> }
  allocateShortCode?: (scope: Pick<Scope, 'channel' | 'identityKey' | 'ownerId'>) => string | null
  audit(event: SecurityAuditEvent): void
}) {
  const conn = getDbConnection(input.db)
  const allocate = input.allocateShortCode ?? ((scope: Pick<Scope, 'channel' | 'identityKey' | 'ownerId'>) => allocateDeferredApprovalShortCode(input.db, scope))
  const rowFor = (todoId: string, version: number) => conn.prepare(`SELECT ${COLUMNS} FROM deferred_approval_notifications
    WHERE todo_id=? AND notification_version=?`).get(todoId, version) as NotificationRow | undefined
  const list = (todoId: string) => (conn.prepare(`SELECT ${COLUMNS} FROM deferred_approval_notifications WHERE todo_id=? ORDER BY notification_version`)
    .all(todoId) as NotificationRow[]).map(mapRow)
  const sessionForTodo = (todoId: string): string => {
    const row = conn.prepare('SELECT origin_session_id FROM deferred_todos WHERE todo_id=?').get(todoId) as { origin_session_id: string } | undefined
    return row?.origin_session_id ?? 'unknown'
  }

  function persist(todo: ReturnType<TodoStore['get']> & {}, dto: DeferredApprovalNotificationDto, state: 'undelivered', now: number, messageId: null): void {
    conn.prepare(`INSERT INTO deferred_approval_notifications(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      todo.todoId, dto.notificationVersion, todo.invocationId, todo.channel, todo.identityKey, todo.ownerId,
      todo.authorizationEpoch, todo.rule.ruleId, todo.rule.factsHash, dto.shortCode, messageId, todo.expiresAt,
      JSON.stringify(dto), state, now, now
    )
    input.db.save()
  }

  function buildDto(todo: NonNullable<ReturnType<TodoStore['get']>>, version: number, code: string, safeContent: {
    safeActionSummary: string; userDelegation: string; untrustedMaterial: string
  }): DeferredApprovalNotificationDto {
    return buildDeferredApprovalNotification({
      channel: todo.channel, todoId: todo.todoId, notificationVersion: version, shortCode: code,
      expiresAt: todo.expiresAt, toolName: 'deferred-action', ...safeContent
    })
  }

  async function deliver(todoId: string, version: number): Promise<'delivered' | 'undelivered'> {
    const row = rowFor(todoId, version)
    if (!row || row.state !== 'undelivered') return 'undelivered'
    try {
      const mapped = mapRow(row)
      const result = await input.adapter.send(mapped.dto, { channel: mapped.channel, identityKey: mapped.identityKey, ownerId: mapped.ownerId })
      const messageId = typeof result === 'string' ? result : result?.messageId
      if (!messageId?.trim()) throw new Error('DEFERRED_NOTIFICATION_MESSAGE_ID_MISSING')
      const changed = conn.prepare(`UPDATE deferred_approval_notifications SET state='delivered',trusted_message_id=?,updated_at=?
        WHERE todo_id=? AND notification_version=? AND state='undelivered'`).run(messageId, Date.now(), todoId, version)
      if (Number(changed.changes) !== 1) return 'undelivered'
      input.db.save()
      input.audit(buildDeferredApprovalAuditEvent({ kind: 'notification', lane: row.channel, sessionId: sessionForTodo(todoId),
        todoId, invocationId: row.invocation_id, notificationState: 'delivered' }))
      return 'delivered'
    } catch {
      input.audit(buildDeferredApprovalAuditEvent({ kind: 'notification', lane: row.channel, sessionId: sessionForTodo(todoId),
        todoId, invocationId: row.invocation_id, notificationState: 'undelivered' }))
      return 'undelivered'
    }
  }

  function createAuthorizedRecord(request: {
    todoId: string; invocationId: string; channel: Scope['channel']; identityKey: string; ownerId: string; authorizationEpoch: number
    rule: { ruleId: string; factsHash: string }; safeActionSummary: string; userDelegation: string; untrustedMaterial: string; now: number
  }): { todo: NonNullable<ReturnType<TodoStore['get']>>; dto: DeferredApprovalNotificationDto } | null {
    const intent = input.intentStore.get(request.invocationId)
    if (!intent || intent.todoId !== request.todoId || !input.intentStore.authorizeResume(request.invocationId)) return null
    const todo = input.todoStore.get(request.todoId, {
      channel: request.channel, identityKey: request.identityKey, ownerId: request.ownerId,
      authorizationEpoch: request.authorizationEpoch, rule: request.rule
    }, request.now)
    if (!todo || todo.invocationId !== request.invocationId || todo.status !== 'pending') return null
    const latest = list(todo.todoId).at(-1)
    if (latest?.state === 'delivered') return { todo, dto: latest.dto }
    const version = (latest?.notificationVersion ?? 0) + 1
    const code = allocate({ channel: todo.channel, identityKey: todo.identityKey, ownerId: todo.ownerId })
    if (!code) return null
    const dto = buildDto(todo, version, code, request)
    runInTransaction(conn, () => {
      if (latest?.state === 'undelivered') conn.prepare(`UPDATE deferred_approval_notifications SET state='superseded',updated_at=?
        WHERE todo_id=? AND notification_version=? AND state='undelivered'`).run(request.now, todo.todoId, latest.notificationVersion)
      persist(todo, dto, 'undelivered', request.now, null)
    })
    return { todo, dto }
  }

  async function sendCreated(todo: NonNullable<ReturnType<TodoStore['get']>>, dto: DeferredApprovalNotificationDto) {
    return deliver(todo.todoId, dto.notificationVersion)
  }

  return {
    async createAndSend(request: {
      todoId: string; invocationId: string; channel: Scope['channel']; identityKey: string; ownerId: string; authorizationEpoch: number
      rule: { ruleId: string; factsHash: string }; safeActionSummary: string; userDelegation: string; untrustedMaterial: string; now?: number
    }): Promise<{ state: 'not_ready' | 'undelivered' | 'delivered'; notificationVersion?: number }> {
      const now = request.now ?? Date.now()
      const latest = list(request.todoId).at(-1)
      if (latest) return { state: latest.state === 'delivered' ? 'delivered' : 'undelivered', notificationVersion: latest.notificationVersion }
      const created = createAuthorizedRecord({ ...request, now })
      if (!created) return { state: 'not_ready' }
      input.audit(buildDeferredApprovalAuditEvent({ kind: 'pending', lane: created.todo.channel, sessionId: created.todo.originSessionId,
        todoId: created.todo.todoId, invocationId: created.todo.invocationId, ts: now }))
      const state = await sendCreated(created.todo, created.dto)
      return { state, notificationVersion: created.dto.notificationVersion }
    },

    async retryForAuthenticatedInbound(request: Scope & { now?: number }): Promise<Array<{ todoId: string; state: 'delivered' | 'undelivered'; notificationVersion: number; messageId?: string }>> {
      const now = request.now ?? Date.now()
      const rows = conn.prepare(`SELECT ${COLUMNS} FROM deferred_approval_notifications
        WHERE channel=? AND identity_key=? AND owner_id=? AND authorization_epoch=? AND state='undelivered'
        ORDER BY created_at,todo_id,notification_version`).all(request.channel, request.identityKey, request.ownerId, request.authorizationEpoch) as NotificationRow[]
      const results = []
      for (const row of rows) {
        const mapped = mapRow(row)
        const todo = input.todoStore.get(mapped.todoId, {
          channel: request.channel, identityKey: request.identityKey, ownerId: request.ownerId,
          authorizationEpoch: request.authorizationEpoch, rule: mapped.rule
        }, now)
        if (!todo || todo.status !== 'pending' || todo.expiresAt <= now || !input.intentStore.authorizeResume(mapped.invocationId)) {
          conn.prepare(`UPDATE deferred_approval_notifications SET state='invalidated',updated_at=?
            WHERE todo_id=? AND notification_version=? AND state='undelivered'`).run(now, mapped.todoId, mapped.notificationVersion)
          input.db.save()
          continue
        }
        const prior = list(todo.todoId).at(-1)
        const content = {
          safeActionSummary: prior?.dto.sections.find(({ kind }) => kind === 'action-summary')?.text ?? '（动作摘要不可用，请拒绝）',
          userDelegation: prior?.dto.sections.find(({ kind }) => kind === 'user-delegation')?.text ?? '（未提供安全摘要）',
          untrustedMaterial: ''
        }
        const created = createAuthorizedRecord({
          todoId: todo.todoId, invocationId: todo.invocationId, channel: todo.channel, identityKey: todo.identityKey,
          ownerId: todo.ownerId, authorizationEpoch: todo.authorizationEpoch, rule: todo.rule,
          ...content, now
        })
        if (!created) continue
        input.audit(buildDeferredApprovalAuditEvent({ kind: 'pending', lane: created.todo.channel, sessionId: created.todo.originSessionId,
          todoId: created.todo.todoId, invocationId: created.todo.invocationId, ts: now }))
        const state = await sendCreated(created.todo, created.dto)
        const deliveredRow = rowFor(todo.todoId, created.dto.notificationVersion)
        results.push({ todoId: todo.todoId, state, notificationVersion: created.dto.notificationVersion,
          ...(state === 'delivered' && deliveredRow?.trusted_message_id ? { messageId: deliveredRow.trusted_message_id } : {}) })
      }
      return results
    },

    list,
    resolveCurrent(request: Scope & { shortCode: string; now?: number }) {
      const now = request.now ?? Date.now()
      const row = conn.prepare(`SELECT ${COLUMNS} FROM deferred_approval_notifications WHERE channel=? AND identity_key=? AND owner_id=?
        AND short_code=? AND authorization_epoch=? AND state='delivered' ORDER BY notification_version DESC LIMIT 1`)
        .get(request.channel, request.identityKey, request.ownerId, request.shortCode, request.authorizationEpoch) as NotificationRow | undefined
      if (!row || row.expires_at <= now) return null
      const todo = input.todoStore.get(row.todo_id, { channel: row.channel, identityKey: row.identity_key, ownerId: row.owner_id,
        authorizationEpoch: row.authorization_epoch, rule: { ruleId: row.rule_id, factsHash: row.facts_hash } }, now)
      if (!todo || todo.status !== 'pending') return null
      return mapRow(row)
    }
  }
}
