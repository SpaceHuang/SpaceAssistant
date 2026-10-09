import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'

export type DeferredResumeRequest = {
  requestId: string
  reasonKey: string
  todoId: string
  invocationId: string
  sessionId: string
  channel: 'feishu' | 'wechat'
  identityKey: string
  ownerId: string
  authorizationEpoch: number
  rule: { ruleId: string; factsHash: string }
  notificationVersion: number
  messageId: string
  state: 'pending' | 'dispatching' | 'completed' | 'invalidated' | 'outcome_unknown'
  createdAt: number
  updatedAt: number
}

type RequestInput = Omit<DeferredResumeRequest, 'state' | 'createdAt' | 'updatedAt'> & { now?: number }
type RequestRow = {
  request_id: string; reason_key: string; todo_id: string; invocation_id: string; session_id: string
  channel: 'feishu' | 'wechat'; identity_key: string; owner_id: string; authorization_epoch: number
  rule_id: string; facts_hash: string; notification_version: number; message_id: string
  state: DeferredResumeRequest['state']; created_at: number; updated_at: number
}

const COLUMNS = `request_id,reason_key,todo_id,invocation_id,session_id,channel,identity_key,owner_id,authorization_epoch,
  rule_id,facts_hash,notification_version,message_id,state,created_at,updated_at`

function mapRow(row: RequestRow): DeferredResumeRequest {
  return {
    requestId: row.request_id, reasonKey: row.reason_key, todoId: row.todo_id, invocationId: row.invocation_id,
    sessionId: row.session_id, channel: row.channel, identityKey: row.identity_key, ownerId: row.owner_id,
    authorizationEpoch: row.authorization_epoch, rule: { ruleId: row.rule_id, factsHash: row.facts_hash },
    notificationVersion: row.notification_version, messageId: row.message_id, state: row.state,
    createdAt: row.created_at, updatedAt: row.updated_at
  }
}

export function createDeferredResumeRequestStore(db: AppDatabase) {
  const conn = getDbConnection(db)
  const get = (requestId: string): DeferredResumeRequest | null => {
    const row = conn.prepare(`SELECT ${COLUMNS} FROM deferred_resume_requests WHERE request_id=?`).get(requestId) as RequestRow | undefined
    return row ? mapRow(row) : null
  }
  return {
    create(input: RequestInput): { request: DeferredResumeRequest; duplicate: boolean } {
      if (![input.requestId, input.reasonKey, input.todoId, input.invocationId, input.sessionId, input.identityKey,
        input.ownerId, input.rule.ruleId, input.rule.factsHash, input.messageId].every((value) => typeof value === 'string' && value.trim())) {
        throw new TypeError('DEFERRED_RESUME_IDENTITY_REQUIRED')
      }
      if (!Number.isSafeInteger(input.authorizationEpoch) || input.authorizationEpoch <= 0 ||
        !Number.isInteger(input.notificationVersion) || input.notificationVersion <= 0) throw new TypeError('DEFERRED_RESUME_VERSION_INVALID')
      const now = input.now ?? Date.now()
      return runInTransaction(conn, () => {
        const consumed = conn.prepare(`SELECT request_id FROM deferred_resume_requests WHERE todo_id=? AND notification_version=?
          AND state IN ('pending','dispatching','completed','outcome_unknown')`).get(input.todoId, input.notificationVersion) as { request_id: string } | undefined
        if (consumed && consumed.request_id !== input.requestId) throw new Error('DEFERRED_NOTIFICATION_VERSION_ALREADY_CONSUMED')
        const prior = conn.prepare(`SELECT ${COLUMNS} FROM deferred_resume_requests WHERE reason_key=?`).get(input.reasonKey) as RequestRow | undefined
        if (prior) {
          const existing = mapRow(prior)
          const same = existing.requestId === input.requestId && existing.todoId === input.todoId && existing.invocationId === input.invocationId &&
            existing.sessionId === input.sessionId && existing.channel === input.channel && existing.identityKey === input.identityKey &&
            existing.ownerId === input.ownerId && existing.authorizationEpoch === input.authorizationEpoch &&
            existing.rule.ruleId === input.rule.ruleId && existing.rule.factsHash === input.rule.factsHash &&
            existing.notificationVersion === input.notificationVersion && existing.messageId === input.messageId
          if (!same) throw new Error('DEFERRED_RESUME_REASON_BINDING_CONFLICT')
          return { request: existing, duplicate: true }
        }
        conn.prepare(`INSERT INTO deferred_resume_requests(${COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`).run(
          input.requestId, input.reasonKey, input.todoId, input.invocationId, input.sessionId, input.channel,
          input.identityKey, input.ownerId, input.authorizationEpoch, input.rule.ruleId, input.rule.factsHash,
          input.notificationVersion, input.messageId, now, now
        )
        db.save()
        return { request: get(input.requestId)!, duplicate: false }
      })
    },
    get,
    listPending(sessionId: string, channel?: 'feishu' | 'wechat'): DeferredResumeRequest[] {
      return (conn.prepare(`SELECT ${COLUMNS} FROM deferred_resume_requests WHERE session_id=? AND state='pending'
        AND (? IS NULL OR channel=?) ORDER BY created_at,request_id`).all(sessionId, channel ?? null, channel ?? null) as RequestRow[]).map(mapRow)
    },
    listPendingSessionIds(channel?: 'feishu' | 'wechat'): string[] {
      return (conn.prepare(`SELECT DISTINCT session_id FROM deferred_resume_requests WHERE state='pending'
        AND (? IS NULL OR channel=?) ORDER BY session_id`).all(channel ?? null, channel ?? null) as Array<{ session_id: string }>).map(({ session_id }) => session_id)
    },
    list(sessionId: string): DeferredResumeRequest[] {
      return (conn.prepare(`SELECT ${COLUMNS} FROM deferred_resume_requests WHERE session_id=? ORDER BY created_at,request_id`).all(sessionId) as RequestRow[]).map(mapRow)
    },
    setState(requestId: string, from: DeferredResumeRequest['state'], to: DeferredResumeRequest['state'], now = Date.now()): boolean {
      const changed = conn.prepare('UPDATE deferred_resume_requests SET state=?,updated_at=? WHERE request_id=? AND state=?')
        .run(to, now, requestId, from)
      if (Number(changed.changes) === 1) db.save()
      return Number(changed.changes) === 1
    },
    invalidateByTodo(todoId: string, now = Date.now()): number {
      const changed = conn.prepare(`UPDATE deferred_resume_requests SET state='invalidated',updated_at=?
        WHERE todo_id=? AND state='pending'`).run(now, todoId)
      if (Number(changed.changes) > 0) db.save()
      return Number(changed.changes)
    },
    invalidateByScope(scope: { channel: 'feishu' | 'wechat'; identityKey: string; ownerId: string; sessionId: string }, now = Date.now()): { invalidated: number; dispatching: number } {
      const dispatching = conn.prepare(`SELECT count(*) AS count FROM deferred_resume_requests WHERE channel=? AND identity_key=? AND owner_id=? AND session_id=? AND state='dispatching'`)
        .get(scope.channel, scope.identityKey, scope.ownerId, scope.sessionId) as { count: number }
      const changed = conn.prepare(`UPDATE deferred_resume_requests SET state='invalidated',updated_at=?
        WHERE channel=? AND identity_key=? AND owner_id=? AND session_id=? AND state='pending'`)
        .run(now, scope.channel, scope.identityKey, scope.ownerId, scope.sessionId)
      if (Number(changed.changes) > 0) db.save()
      return { invalidated: Number(changed.changes), dispatching: Number(dispatching.count) }
    },
    invalidateOlderAuthorizationEpochs(channel: 'feishu' | 'wechat', currentEpoch: number, now = Date.now()): { invalidated: number; dispatching: number } {
      if (!Number.isSafeInteger(currentEpoch) || currentEpoch <= 0) throw new TypeError('REMOTE_AUTHORIZATION_EPOCH_INVALID')
      const dispatching = conn.prepare(`SELECT count(*) AS count FROM deferred_resume_requests WHERE channel=? AND authorization_epoch<? AND state='dispatching'`)
        .get(channel, currentEpoch) as { count: number }
      const changed = conn.prepare(`UPDATE deferred_resume_requests SET state='invalidated',updated_at=?
        WHERE channel=? AND authorization_epoch<? AND state='pending'`).run(now, channel, currentEpoch)
      if (Number(changed.changes) > 0) db.save()
      return { invalidated: Number(changed.changes), dispatching: Number(dispatching.count) }
    }
  }
}
