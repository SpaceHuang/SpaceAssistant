import { afterEach, describe, expect, it } from 'vitest'
import { getDbConnection, openSqliteDatabase, type AppDatabase } from '../database'
import { commitConfirmationSubmission, commitConfirmationSubmissionWithWork, ConfirmationCommitRolledBackError, failConfirmationSubmission, markConfirmationSubmissionReconciling, queryConfirmationSubmission, reconcileConfirmationSubmission, reconcileConfirmationSubmissions, reserveConfirmationSubmission } from './persistentConfirmationCommit'
import type { CommitPlan } from '../../packages/agent-core/src/confirmationCommit'

const dbs: AppDatabase[] = []
afterEach(() => dbs.splice(0).forEach((db) => db.close()))

const plan: CommitPlan = { submissionId: 's-1', confirmId: 'c-1', sessionId: 'session-1', ownerId: 'o-1', generation: 1, revision: 1, action: 'approved', memory: 'written' }

describe('persistent confirmation submission receipt', () => {
  it('reserves idempotently and supports restart query after commit', () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    expect(reserveConfirmationSubmission(db, plan)).toBeUndefined()
    expect(reserveConfirmationSubmission(db, plan)).toBeUndefined()
    expect(commitConfirmationSubmission(db, 's-1', 'event-1', 2)).toMatchObject({ kind: 'committed' })
    expect(queryConfirmationSubmission(db, 's-1')).toMatchObject({ kind: 'committed', eventId: 'event-1' })
  })

  it('rejects a conflicting replay without changing the receipt', () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    reserveConfirmationSubmission(db, plan)
    expect(reserveConfirmationSubmission(db, { ...plan, action: 'denied' })).toMatchObject({ kind: 'not-committed', code: 'protocol-conflict' })
    expect(getDbConnection(db).prepare('SELECT status FROM confirmation_submissions WHERE submission_id = ?').get('s-1')).toMatchObject({ status: 'committing' })
  })

  it('rolled_back 只允许同一绑定的新提交重新 reserve', () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    reserveConfirmationSubmission(db, plan)
    failConfirmationSubmission(db, plan.submissionId)
    expect(reserveConfirmationSubmission(db, { ...plan, revision: 2 })).toBeUndefined()
    expect(getDbConnection(db).prepare('SELECT status, revision FROM confirmation_submissions WHERE submission_id = ?').get('s-1'))
      .toMatchObject({ status: 'committing', revision: 2 })
    expect(reserveConfirmationSubmission(db, { ...plan, revision: 1 })).toMatchObject({ kind: 'not-committed', code: 'protocol-conflict' })
    expect(reserveConfirmationSubmission(db, { ...plan, revision: 3, sessionId: 'other-session' })).toMatchObject({ kind: 'not-committed', code: 'protocol-conflict' })
  })

  it('业务写入失败时 receipt 与业务事务一起回滚', () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    expect(() => commitConfirmationSubmissionWithWork(db, plan, () => { throw new Error('write-failed') })).toThrow(ConfirmationCommitRolledBackError)
    expect(queryConfirmationSubmission(db, plan.submissionId)).toMatchObject({ kind: 'not-committed', code: 'storage-failed', canResubmit: true })
    expect(getDbConnection(db).prepare('SELECT * FROM confirmation_commit_audits WHERE submission_id = ?').get(plan.submissionId)).toBeUndefined()
  })

  it('最终 deadline 复核失败时也明确结算 rolled_back，不进入未知状态', () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    expect(() => commitConfirmationSubmissionWithWork(db, plan, () => undefined, 'event-deadline', 1, () => {
      throw new Error('confirmation-expired')
    })).toThrow(ConfirmationCommitRolledBackError)
    expect(queryConfirmationSubmission(db, plan.submissionId)).toMatchObject({ kind: 'not-committed', code: 'storage-failed', canResubmit: true })
  })

  it('成功提交时确认审计与 receipt 同事务持久化', () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    expect(commitConfirmationSubmissionWithWork(db, plan, () => undefined)).toMatchObject({ kind: 'committed' })
    expect(getDbConnection(db).prepare('SELECT action, memory FROM confirmation_commit_audits WHERE submission_id = ?').get(plan.submissionId))
      .toMatchObject({ action: 'approved', memory: 'written' })
  })

  it('failed receipt 不得被重试伪装成 committed 或写入授权', () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    reserveConfirmationSubmission(db, plan)
    // 模拟异步写入失败后的终态。
    failConfirmationSubmission(db, plan.submissionId)
    let writes = 0
    expect(commitConfirmationSubmissionWithWork(db, plan, () => { writes++ })).toMatchObject({ kind: 'not-committed', code: 'storage-failed', canResubmit: true })
    expect(writes).toBe(0)
    expect(queryConfirmationSubmission(db, plan.submissionId)).toMatchObject({ kind: 'not-committed', code: 'storage-failed', canResubmit: true })
  })

  it('rolled_back 后同一确认项使用新 revision 可以重新执行 work 并提交', () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    expect(() => commitConfirmationSubmissionWithWork(db, plan, () => { throw new Error('first-write-failed') })).toThrow(ConfirmationCommitRolledBackError)
    let writes = 0
    expect(commitConfirmationSubmissionWithWork(db, { ...plan, revision: 2 }, () => { writes++ })).toMatchObject({ kind: 'committed' })
    expect(writes).toBe(1)
    expect(queryConfirmationSubmission(db, plan.submissionId)).toMatchObject({ kind: 'committed' })
    expect(getDbConnection(db).prepare('SELECT revision, status FROM confirmation_submissions WHERE submission_id = ?').get(plan.submissionId))
      .toMatchObject({ revision: 2, status: 'committed' })
  })

  it('对账发现提交审计时将 committing 收敛为 committed', () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    reserveConfirmationSubmission(db, plan)
    const conn = getDbConnection(db)
    conn.prepare(`INSERT INTO confirmation_commit_audits
      (submission_id, confirm_id, session_id, owner_id, generation, revision, action, memory, committed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(plan.submissionId, plan.confirmId, plan.sessionId, plan.ownerId, plan.generation, plan.revision, plan.action, plan.memory, Date.now())
    const settled = reconcileConfirmationSubmissions(db)
    expect(settled).toEqual([{ submissionId: plan.submissionId, outcome: 'committed' }])
    expect(queryConfirmationSubmission(db, plan.submissionId)).toMatchObject({ kind: 'committed' })
  })

  it('当前请求对账也能识别 COMMIT 已成功但调用方收到异常后的 committed receipt', () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    expect(commitConfirmationSubmissionWithWork(db, plan, () => undefined)).toMatchObject({ kind: 'committed' })
    expect(reconcileConfirmationSubmission(db, plan.submissionId)).toEqual({ submissionId: plan.submissionId, outcome: 'committed' })
  })

  it('对账找不到提交审计时将 committing 收敛为 rolled_back 并允许重试', () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    reserveConfirmationSubmission(db, plan)
    const settled = reconcileConfirmationSubmissions(db)
    expect(settled).toEqual([{ submissionId: plan.submissionId, outcome: 'rolled_back' }])
    expect(queryConfirmationSubmission(db, plan.submissionId)).toMatchObject({ kind: 'not-committed', code: 'storage-failed', canResubmit: true })
  })

  it('未知提交没有预先落 receipt 时先创建 reconciling，再由对账收敛', () => {
    const db = openSqliteDatabase(':memory:'); dbs.push(db)
    markConfirmationSubmissionReconciling(db, plan.submissionId, plan)
    expect(getDbConnection(db).prepare('SELECT status FROM confirmation_submissions WHERE submission_id = ?').get(plan.submissionId))
      .toMatchObject({ status: 'reconciling' })
    expect(reconcileConfirmationSubmissions(db)).toEqual([{ submissionId: plan.submissionId, outcome: 'rolled_back' }])
    expect(queryConfirmationSubmission(db, plan.submissionId)).toMatchObject({ kind: 'not-committed', canResubmit: true })
  })
})
