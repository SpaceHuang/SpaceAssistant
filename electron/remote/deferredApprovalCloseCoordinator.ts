import { randomUUID } from 'node:crypto'
import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import { createRemoteAuthorizationEpochStore } from './remoteAuthorizationEpochStore'

type Scope = { channel: 'feishu' | 'wechat'; identityKey: string; ownerId: string; sessionId: string }
type ClosePort = {
  blockNewDispatch(scope: Scope & { authorizationEpoch: number; tombstone: string }): Promise<unknown>
  persistClosureFacts(scope: Scope & { authorizationEpoch: number; tombstone: string }): Promise<unknown>
  invalidatePendingTodos(scope: Scope): Promise<unknown>
  cancelResumeRequests(scope: Scope): Promise<unknown>
  revokeConsumedPermits(scope: Scope): Promise<unknown>
  reconcile(scope: Scope): Promise<unknown>
  rollbackToUser(scope: Scope): Promise<unknown>
}

type CloseRow = {
  authorization_epoch: number; tombstone: string; state: 'closing' | 'reconciliation_required' | 'closed'
}

export function createDeferredApprovalCloseCoordinator(input: { db: AppDatabase; port: ClosePort; advanceAuthorizationEpoch?: (channel: Scope['channel'], reason: string) => number }) {
  const conn = getDbConnection(input.db)
  const epochStore = createRemoteAuthorizationEpochStore(input.db)
  function get(scope: Scope): CloseRow | null {
    return (conn.prepare(`SELECT authorization_epoch,tombstone,state FROM deferred_approval_closures
      WHERE channel=? AND identity_key=? AND owner_id=? AND session_id=?`)
      .get(scope.channel, scope.identityKey, scope.ownerId, scope.sessionId) as CloseRow | undefined) ?? null
  }
  function nextAuthorizationEpoch(scope: Scope, reason: string): number {
    if (input.advanceAuthorizationEpoch) return input.advanceAuthorizationEpoch(scope.channel, reason)
    return epochStore.advance(scope.channel, reason)
  }
  function persist(scope: Scope, row: CloseRow, now: number): void {
    conn.prepare(`INSERT INTO deferred_approval_closures(channel,identity_key,owner_id,session_id,authorization_epoch,tombstone,state,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(channel,identity_key,owner_id,session_id) DO UPDATE SET
        authorization_epoch=excluded.authorization_epoch,tombstone=excluded.tombstone,state=excluded.state,updated_at=excluded.updated_at`)
      .run(scope.channel, scope.identityKey, scope.ownerId, scope.sessionId, row.authorization_epoch, row.tombstone, row.state, now)
    input.db.save()
  }

  async function close(scope: Scope): Promise<{ status: 'closed' } | { status: 'reconciliation_required'; failedAt: string }> {
    if (![scope.identityKey, scope.ownerId, scope.sessionId].every((value) => value.trim())) throw new TypeError('DEFERRED_APPROVAL_CLOSE_SCOPE_REQUIRED')
    const current = get(scope)
    const reopening = current && current.state !== 'closed'
    let closure: CloseRow
    try {
      const epoch = reopening ? current!.authorization_epoch
        : nextAuthorizationEpoch(scope, `deferred-approval-close:${scope.identityKey}:${scope.ownerId}:${scope.sessionId}`)
      closure = { authorization_epoch: epoch, tombstone: randomUUID(), state: 'closing' }
      persist(scope, closure, Date.now())
    } catch {
      return { status: 'reconciliation_required', failedAt: 'advanceAuthorizationEpoch' }
    }
    const now = Date.now()
    try {
      await input.port.blockNewDispatch({ ...scope, authorizationEpoch: closure.authorization_epoch, tombstone: closure.tombstone })
    } catch {
      return { status: 'reconciliation_required', failedAt: 'blockNewDispatch' }
    }
    const stages: Array<[string, () => Promise<unknown>]> = [
      ['persistClosureFacts', () => input.port.persistClosureFacts({ ...scope, authorizationEpoch: closure.authorization_epoch, tombstone: closure.tombstone })],
      ['invalidatePendingTodos', () => input.port.invalidatePendingTodos(scope)],
      ['cancelResumeRequests', () => input.port.cancelResumeRequests(scope)],
      ['revokeConsumedPermits', () => input.port.revokeConsumedPermits(scope)],
      ['reconcile', () => input.port.reconcile(scope)],
      ['rollbackToUser', () => input.port.rollbackToUser(scope)]
    ]
    for (const [stage, run] of stages) {
      try {
        await run()
        if (stage === 'reconcile') persist(scope, { ...closure, state: 'reconciliation_required' }, Date.now())
        if (stage === 'rollbackToUser') persist(scope, { ...closure, state: 'closed' }, Date.now())
      } catch {
        persist(scope, { ...closure, state: 'reconciliation_required' }, Date.now())
        return { status: 'reconciliation_required', failedAt: stage }
      }
    }
    return { status: 'closed' }
  }

  return {
    close,
    getClosure(scope: Scope) {
      const row = get(scope)
      return row ? { authorizationEpoch: row.authorization_epoch, tombstone: row.tombstone, state: row.state } : null
    },
    async reconcilePending(): Promise<Array<{ scope: Scope; result: Awaited<ReturnType<typeof close>> }>> {
      const rows = conn.prepare(`SELECT channel,identity_key,owner_id,session_id FROM deferred_approval_closures
        WHERE state!='closed' ORDER BY updated_at`).all() as Array<{ channel: Scope['channel']; identity_key: string; owner_id: string; session_id: string }>
      const results = []
      for (const row of rows) {
        const scope = { channel: row.channel, identityKey: row.identity_key, ownerId: row.owner_id, sessionId: row.session_id }
        results.push({ scope, result: await close(scope) })
      }
      return results
    }
  }
}
