import type { AppDatabase } from '../database'
import { getDbConnection } from '../database'
import { runInTransaction, TransactionCommitUnknownError } from '../database/transaction'
import type { CommitPlan, CommitReceipt, ConfirmationCommitStatus } from '../../packages/agent-core/src/confirmationCommit'

type SubmissionRow = {
  submission_id: string
  confirm_id: string
  session_id: string
  owner_id: string
  expected_revision: number
  generation: number
  revision: number
  action: string
  memory: string
  status: ConfirmationCommitStatus
  event_id?: string
  history_version?: number
}

/** 授权 work 明确抛错且尚未进入 COMMIT；调用方可安全恢复原确认项重试。 */
export class ConfirmationCommitRolledBackError extends Error {
  readonly cause: unknown
  constructor(cause: unknown) {
    super('confirmation work rolled back')
    this.name = 'ConfirmationCommitRolledBackError'
    this.cause = cause
  }
}

/** SQLite COMMIT 结果未知；不得补偿删除授权或把 waiter 当作普通失败。 */
export class ConfirmationCommitUnknownError extends Error {
  readonly cause: unknown
  constructor(cause: unknown) {
    super('confirmation commit outcome is unknown')
    this.name = 'ConfirmationCommitUnknownError'
    this.cause = cause
  }
}

/** SQLite-backed idempotency record for confirmation authorization commits. */
export function reserveConfirmationSubmission(db: AppDatabase, plan: CommitPlan): CommitReceipt | undefined {
  const conn = getDbConnection(db)
  if (typeof conn.exec !== 'function') return undefined
  const now = Date.now()
  try {
    return runInTransaction(conn, () => {
    const existing = conn.prepare('SELECT * FROM confirmation_submissions WHERE submission_id = ?').get(plan.submissionId) as SubmissionRow | undefined
    if (existing) {
      const sameOwner = existing.confirm_id === plan.confirmId && existing.session_id === plan.sessionId && existing.owner_id === plan.ownerId && existing.generation === plan.generation
      if (!sameOwner || existing.revision !== plan.revision || existing.action !== plan.action || existing.memory !== plan.memory) {
        if (existing.status === 'rolled_back' && sameOwner && plan.revision > existing.revision) {
          conn.prepare(`UPDATE confirmation_submissions SET confirm_id = ?, session_id = ?, owner_id = ?, expected_revision = ?, generation = ?, revision = ?, action = ?, memory = ?, status = 'committing', updated_at = ? WHERE submission_id = ? AND status = 'rolled_back'`)
            .run(plan.confirmId, plan.sessionId, plan.ownerId, plan.revision, plan.generation, plan.revision, plan.action, plan.memory, now, plan.submissionId)
          return undefined
        }
        if (existing.status === 'committing') return { kind: 'not-committed', submissionId: plan.submissionId, code: 'protocol-conflict', canResubmit: false }
        return { kind: 'not-committed', submissionId: plan.submissionId, code: 'protocol-conflict', canResubmit: false }
      }
      if (existing.status === 'committed') return { kind: 'committed', submissionId: plan.submissionId, historyVersion: existing.history_version ?? 0, eventId: existing.event_id ?? '' }
      if (existing.status === 'rolled_back') {
        return { kind: 'not-committed', submissionId: plan.submissionId, code: 'protocol-conflict', canResubmit: false }
      }
      return undefined
    }
    conn.prepare(`INSERT INTO confirmation_submissions
      (submission_id, confirm_id, session_id, owner_id, expected_revision, generation, revision, action, memory, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'committing', ?, ?)`)
      .run(plan.submissionId, plan.confirmId, plan.sessionId, plan.ownerId, plan.revision, plan.generation, plan.revision, plan.action, plan.memory, now, now)
    return undefined
    })
  } catch (error) {
    if (error instanceof TransactionCommitUnknownError) throw new ConfirmationCommitUnknownError(error)
    throw new ConfirmationCommitRolledBackError(error)
  }
}

/** 在同一 SQLite 事务中完成 receipt reserve、授权写入和 committed 标记。 */
export function commitConfirmationSubmissionWithWork(
  db: AppDatabase,
  plan: CommitPlan,
  work: () => void,
  eventId = `confirm:${plan.submissionId}`,
  historyVersion = 1,
  beforeCommit?: () => void
): CommitReceipt {
  const conn = getDbConnection(db)
  if (typeof conn.exec !== 'function') {
    try {
      work()
    } catch (error) {
      throw new ConfirmationCommitRolledBackError(error)
    }
    // 授权工作可能跨过确认 deadline；在写入 committed 前必须再次由调用方复核。
    try {
      beforeCommit?.()
    } catch (error) {
      throw new ConfirmationCommitRolledBackError(error)
    }
    return { kind: 'committed', submissionId: plan.submissionId, eventId, historyVersion }
  }
  try {
    return runInTransaction(conn, () => {
    let existing = conn.prepare('SELECT * FROM confirmation_submissions WHERE submission_id = ?').get(plan.submissionId) as SubmissionRow | undefined
    const sameIdentity = existing?.confirm_id === plan.confirmId && existing.session_id === plan.sessionId && existing.owner_id === plan.ownerId && existing.generation === plan.generation
    if (existing?.status === 'rolled_back' && sameIdentity && plan.revision > existing.revision) {
      const resumed = conn.prepare(`UPDATE confirmation_submissions
        SET expected_revision = ?, generation = ?, revision = ?, action = ?, memory = ?, status = 'committing', updated_at = ?
        WHERE submission_id = ? AND status = 'rolled_back' AND revision < ?`).run(
        plan.revision, plan.generation, plan.revision, plan.action, plan.memory, Date.now(), plan.submissionId, plan.revision
      )
      if (Number(resumed.changes) === 1) existing = { ...existing, expected_revision: plan.revision, revision: plan.revision, action: plan.action, memory: plan.memory, status: 'committing' }
    }
    if (existing && (existing.confirm_id !== plan.confirmId || existing.session_id !== plan.sessionId || existing.owner_id !== plan.ownerId || existing.generation !== plan.generation || existing.revision !== plan.revision || existing.action !== plan.action || existing.memory !== plan.memory)) {
      return { kind: 'not-committed', submissionId: plan.submissionId, code: 'protocol-conflict', canResubmit: false }
    }
    if (existing?.status === 'committed') return { kind: 'committed', submissionId: plan.submissionId, historyVersion: existing.history_version ?? 0, eventId: existing.event_id ?? '' }
    if (existing?.status === 'rolled_back') return { kind: 'not-committed', submissionId: plan.submissionId, code: 'storage-failed', canResubmit: true }
    if (existing?.status === 'cancelled') return { kind: 'not-committed', submissionId: plan.submissionId, code: 'stale', canResubmit: false }
    if (existing?.status === 'reconciling') return { kind: 'unknown', submissionId: plan.submissionId }
    const now = Date.now()
    if (!existing) conn.prepare(`INSERT INTO confirmation_submissions
      (submission_id, confirm_id, session_id, owner_id, expected_revision, generation, revision, action, memory, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'committing', ?, ?)`)
      .run(plan.submissionId, plan.confirmId, plan.sessionId, plan.ownerId, plan.revision, plan.generation, plan.revision, plan.action, plan.memory, now, now)
    conn.prepare(`INSERT OR IGNORE INTO confirmation_commit_audits
      (submission_id, confirm_id, session_id, owner_id, generation, revision, action, memory, committed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(plan.submissionId, plan.confirmId, plan.sessionId, plan.ownerId, plan.generation, plan.revision, plan.action, plan.memory, now)
    work()
    const result = conn.prepare("UPDATE confirmation_submissions SET status = 'committed', event_id = ?, history_version = ?, updated_at = ? WHERE submission_id = ? AND status = 'committing'")
      .run(eventId, historyVersion, Date.now(), plan.submissionId)
    if (Number(result.changes) !== 1) return { kind: 'not-committed', submissionId: plan.submissionId, code: 'stale', canResubmit: false }
    beforeCommit?.()
    return { kind: 'committed', submissionId: plan.submissionId, eventId, historyVersion }
    })
  } catch (error) {
    if (error instanceof TransactionCommitUnknownError) throw new ConfirmationCommitUnknownError(error)
    // SQLite 已回滚业务写入；receipt 本身在独立事务中落为 rolled_back，
    // 让调用方可以安全恢复确认项并用新的 revision 重试，而不是留下 committing 幽灵。
    let rollbackReceiptPersisted = true
    try {
      runInTransaction(conn, () => {
        const now = Date.now()
        const existing = conn.prepare('SELECT status FROM confirmation_submissions WHERE submission_id = ?').get(plan.submissionId) as Pick<SubmissionRow, 'status'> | undefined
        if (!existing) {
          conn.prepare(`INSERT INTO confirmation_submissions
            (submission_id, confirm_id, session_id, owner_id, expected_revision, generation, revision, action, memory, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'rolled_back', ?, ?)`)
            .run(plan.submissionId, plan.confirmId, plan.sessionId, plan.ownerId, plan.revision, plan.generation, plan.revision, plan.action, plan.memory, now, now)
        } else if (existing.status === 'committing') {
          conn.prepare("UPDATE confirmation_submissions SET status = 'rolled_back', updated_at = ? WHERE submission_id = ? AND status = 'committing'")
            .run(now, plan.submissionId)
        }
      })
    } catch {
      // 无法写入 rolled_back 时，调用方必须按 COMMIT 未知处理并进入对账。
      rollbackReceiptPersisted = false
    }
    if (!rollbackReceiptPersisted) throw new ConfirmationCommitUnknownError(error)
    throw new ConfirmationCommitRolledBackError(error)
  }
}

export function commitConfirmationSubmission(db: AppDatabase, submissionId: string, eventId: string, historyVersion: number): CommitReceipt {
  const conn = getDbConnection(db)
  if (typeof conn.exec !== 'function') return { kind: 'committed', submissionId, historyVersion, eventId }
  return runInTransaction(conn, () => {
    const result = conn.prepare(`UPDATE confirmation_submissions SET status = 'committed', event_id = ?, history_version = ?, updated_at = ?
      WHERE submission_id = ? AND status = 'committing'`).run(eventId, historyVersion, Date.now(), submissionId)
    if (Number(result.changes) !== 1) {
      const row = conn.prepare('SELECT status, event_id, history_version FROM confirmation_submissions WHERE submission_id = ?').get(submissionId) as SubmissionRow | undefined
      if (row?.status === 'committed') return { kind: 'committed', submissionId, historyVersion: row.history_version ?? 0, eventId: row.event_id ?? '' }
      return { kind: 'not-committed', submissionId, code: 'stale', canResubmit: false }
    }
    return { kind: 'committed', submissionId, historyVersion, eventId }
  })
}

export function failConfirmationSubmission(db: AppDatabase, submissionId: string): void {
  const conn = getDbConnection(db)
  if (typeof conn.exec !== 'function') return
  conn.prepare("UPDATE confirmation_submissions SET status = 'rolled_back', updated_at = ? WHERE submission_id = ? AND status = 'committing'").run(Date.now(), submissionId)
}

/** COMMIT 结果未知时保留对账状态，禁止把它当作普通用户拒绝或可安全重试。 */
export function markConfirmationSubmissionReconciling(db: AppDatabase, submissionId: string, plan?: CommitPlan): void {
  const conn = getDbConnection(db)
  if (typeof conn.exec !== 'function') return
  runInTransaction(conn, () => {
    const now = Date.now()
    const result = conn.prepare("UPDATE confirmation_submissions SET status = 'reconciling', updated_at = ? WHERE submission_id = ? AND status = 'committing'").run(now, submissionId)
    if (Number(result.changes) === 0 && plan) {
      const existing = conn.prepare('SELECT submission_id FROM confirmation_submissions WHERE submission_id = ?').get(submissionId)
      if (!existing) {
        conn.prepare(`INSERT INTO confirmation_submissions
          (submission_id, confirm_id, session_id, owner_id, expected_revision, generation, revision, action, memory, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reconciling', ?, ?)`)
          .run(plan.submissionId, plan.confirmId, plan.sessionId, plan.ownerId, plan.revision, plan.generation, plan.revision, plan.action, plan.memory, now, now)
      }
    }
  })
}

export function queryConfirmationSubmission(db: AppDatabase, submissionId: string): CommitReceipt | undefined {
  const conn = getDbConnection(db)
  if (typeof conn.exec !== 'function') return undefined
  const row = conn.prepare('SELECT status, event_id, history_version FROM confirmation_submissions WHERE submission_id = ?').get(submissionId) as SubmissionRow | undefined
  if (!row) return undefined
  if (row.status === 'committed') return { kind: 'committed', submissionId, historyVersion: row.history_version ?? 0, eventId: row.event_id ?? '' }
  if (row.status === 'rolled_back') return { kind: 'not-committed', submissionId, code: 'storage-failed', canResubmit: true }
  if (row.status === 'cancelled') return { kind: 'not-committed', submissionId, code: 'stale', canResubmit: false }
  return { kind: 'unknown', submissionId }
}

export type ConfirmationReconciliationResult = {
  submissionId: string
  outcome: 'committed' | 'rolled_back'
}

/**
 * 启动/运行时对账消费者：收敛 COMMIT 结果未知的 receipt。
 * confirmation_commit_audits 与提交状态在同一 SQLite 事务中写入，因此审计存在
 * 是“授权事务已提交”的证据；审计不存在则把未决 receipt 安全结算为 rolled_back。
 * 每条记录独立事务处理，单条数据库故障不会阻塞其余 receipt 的对账。
 */
export function reconcileConfirmationSubmissions(
  db: AppDatabase,
  onSettled?: (result: ConfirmationReconciliationResult) => void
): ConfirmationReconciliationResult[] {
  const conn = getDbConnection(db)
  if (typeof conn.exec !== 'function') return []
  const rows = conn.prepare(`SELECT submission_id, status FROM confirmation_submissions
    WHERE status IN ('committing', 'reconciling') ORDER BY updated_at, submission_id`).all() as Array<{ submission_id: string; status: ConfirmationCommitStatus }>
  const settled: ConfirmationReconciliationResult[] = []
  for (const row of rows) {
    try {
      const result = runInTransaction(conn, () => {
        const current = conn.prepare('SELECT status FROM confirmation_submissions WHERE submission_id = ?').get(row.submission_id) as { status: ConfirmationCommitStatus } | undefined
        if (!current || (current.status !== 'committing' && current.status !== 'reconciling')) return undefined
        const audit = conn.prepare('SELECT submission_id FROM confirmation_commit_audits WHERE submission_id = ?').get(row.submission_id)
        const committed = audit !== undefined
        conn.prepare(`UPDATE confirmation_submissions
          SET status = ?, event_id = CASE WHEN ? = 'committed' THEN COALESCE(event_id, ?) ELSE event_id END,
              history_version = CASE WHEN ? = 'committed' THEN COALESCE(history_version, 1) ELSE history_version END,
              updated_at = ? WHERE submission_id = ? AND status IN ('committing', 'reconciling')`)
          .run(committed ? 'committed' : 'rolled_back', committed ? 'committed' : 'rolled_back', `confirm:${row.submission_id}`,
            committed ? 'committed' : 'rolled_back', Date.now(), row.submission_id)
        return { submissionId: row.submission_id, outcome: committed ? 'committed' as const : 'rolled_back' as const }
      })
      if (!result) continue
      settled.push(result)
      onSettled?.(result)
    } catch {
      // 保留原状态，下一次启动/运行时对账继续处理。
    }
  }
  return settled
}

/** 对单个当前请求对账；即使 COMMIT 已经成功并把状态写成 committed，也返回终态，
 * 这样抛出 TransactionCommitUnknownError 的当前调用可以立即结算原 waiter。 */
export function reconcileConfirmationSubmission(
  db: AppDatabase,
  submissionId: string
): ConfirmationReconciliationResult | undefined {
  const settled = reconcileConfirmationSubmissions(db).find((result) => result.submissionId === submissionId)
  if (settled) return settled
  const conn = getDbConnection(db)
  if (typeof conn.exec !== 'function') return undefined
  const row = conn.prepare('SELECT status FROM confirmation_submissions WHERE submission_id = ?').get(submissionId) as { status: ConfirmationCommitStatus } | undefined
  if (row?.status === 'committed') return { submissionId, outcome: 'committed' }
  if (row?.status === 'rolled_back') return { submissionId, outcome: 'rolled_back' }
  return undefined
}
