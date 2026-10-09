import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'

export type DurableAuthorizationEpoch = { channel: 'feishu' | 'wechat'; epoch: number }
export type PendingAuthorizationRevocation = DurableAuthorizationEpoch & { reason: string; createdAt: number; sessionId?: string }

function validateEpoch(row: unknown, channel: 'feishu' | 'wechat'): number {
  const epoch = row && typeof row === 'object' ? (row as { epoch?: unknown }).epoch : undefined
  if (!Number.isSafeInteger(epoch) || (epoch as number) <= 0) throw new Error(`REMOTE_AUTHORIZATION_EPOCH_INVALID:${channel}`)
  return epoch as number
}

/** Durable monotonic authority epoch and revocation journal. Missing/corrupt state is never reset. */
export function createRemoteAuthorizationEpochStore(db: AppDatabase) {
  const conn = getDbConnection(db)

  function current(channel: 'feishu' | 'wechat'): number {
    const row = conn.prepare('SELECT epoch FROM remote_authorization_epochs WHERE channel=?').get(channel)
    if (!row) throw new Error(`REMOTE_AUTHORIZATION_EPOCH_MISSING:${channel}`)
    return validateEpoch(row, channel)
  }

  return {
    initialize(): Record<'feishu' | 'wechat', number> {
      const epochs = { feishu: current('feishu'), wechat: current('wechat') }
      return epochs
    },
    current,
    advance(channel: 'feishu' | 'wechat', reason: string, now = Date.now(), sessionId?: string): number {
      if (!reason.trim()) throw new TypeError('REMOTE_AUTHORIZATION_REVOCATION_REASON_REQUIRED')
      const next = runInTransaction(conn, () => {
        const epoch = current(channel) + 1
        if (!Number.isSafeInteger(epoch)) throw new Error(`REMOTE_AUTHORIZATION_EPOCH_EXHAUSTED:${channel}`)
        conn.prepare('UPDATE remote_authorization_epochs SET epoch=?,updated_at=? WHERE channel=?').run(epoch, now, channel)
        conn.prepare(`INSERT INTO remote_authorization_revocations(channel,epoch,reason,state,created_at,updated_at,session_id)
          VALUES(?,?,?,'pending',?,?,?)`).run(channel, epoch, reason, now, now, sessionId ?? null)
        return epoch
      })
      db.save()
      return next
    },
    completeRevocation(channel: 'feishu' | 'wechat', epoch: number, now = Date.now()): boolean {
      const result = conn.prepare(`UPDATE remote_authorization_revocations SET state='completed',updated_at=?
        WHERE channel=? AND epoch=? AND state='pending'`).run(now, channel, epoch)
      if (Number(result.changes) === 1) db.save()
      return Number(result.changes) === 1
    },
    pendingRevocations(): PendingAuthorizationRevocation[] {
      return (conn.prepare(`SELECT channel,epoch,reason,created_at AS createdAt,session_id AS sessionId FROM remote_authorization_revocations
        WHERE state='pending' ORDER BY created_at,channel,epoch`).all() as Array<PendingAuthorizationRevocation & { createdAt: number }>)
        .map((row) => ({ ...row, ...(row.sessionId ? { sessionId: row.sessionId } : {}), epoch: validateEpoch({ epoch: row.epoch }, row.channel) }))
    },
    assertReady(): void {
      const pending = this.pendingRevocations()
      if (pending.length > 0) throw new Error('REMOTE_AUTHORIZATION_REVOCATION_RECOVERY_REQUIRED')
    }
  }
}
