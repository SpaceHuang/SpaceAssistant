import { describe, expect, it, vi } from 'vitest'
import {
  ConfirmationCommit,
  ConfirmationCommitStateMachine,
  type CommitPlan,
  type ConfirmationCommitState
} from '../src/confirmationCommit'

const plan: CommitPlan = {
  submissionId: 'submission-1', confirmId: 'confirm-1', sessionId: 'session-1', ownerId: 'user-1', generation: 3, revision: 2,
  action: 'approved', memory: 'written'
}

describe('ConfirmationCommitStateMachine', () => {
  const initial: ConfirmationCommitState = {
    submissionId: 'submission-1',
    confirmId: 'confirm-1',
    sessionId: 'session-1',
    ownerId: 'user-1',
    generation: 3,
    revision: 2,
    status: 'pending'
  }

  it('只允许 pending → committing → committed 的正向提交链路', () => {
    const machine = new ConfirmationCommitStateMachine(initial)
    expect(machine.transition({ type: 'reserve' }).status).toBe('committing')
    expect(machine.transition({ type: 'commit' }).status).toBe('committed')
    expect(() => machine.transition({ type: 'rollback' })).toThrow(/invalid confirmation commit transition/i)
  })

  it('回滚、对账和取消是互斥终态，不能被再次批准或回滚覆盖', () => {
    for (const event of [{ type: 'rollback' } as const, { type: 'reconcile' } as const]) {
      const machine = new ConfirmationCommitStateMachine(initial)
      machine.transition({ type: 'reserve' })
      const terminal = machine.transition(event)
      expect(['rolled_back', 'reconciling']).toContain(terminal.status)
      expect(() => machine.transition({ type: 'commit' })).toThrow(/invalid confirmation commit transition/i)
    }

    const cancelled = new ConfirmationCommitStateMachine(initial).transition({ type: 'cancel' })
    expect(cancelled.status).toBe('cancelled')
  })

  it('提交计划身份必须包含 session、owner、generation 和 revision', async () => {
    const commit = new ConfirmationCommit({ commit: async () => ({ historyVersion: 1, eventId: 'event-1' }) })
    await expect(commit.submit({ ...plan, sessionId: '' })).resolves.toMatchObject({ kind: 'not-committed', code: 'invalid-plan' })
    await expect(commit.submit({ ...plan, ownerId: '' })).resolves.toMatchObject({ kind: 'not-committed', code: 'invalid-plan' })
    await expect(commit.submit({ ...plan, generation: 0 })).resolves.toMatchObject({ kind: 'not-committed', code: 'invalid-plan' })
    await expect(commit.submit({ ...plan, revision: 0 })).resolves.toMatchObject({ kind: 'not-committed', code: 'invalid-plan' })
  })

  it('不同 generation 或 revision 的重放不能共享同一已提交 receipt', async () => {
    const commit = new ConfirmationCommit({ commit: async () => ({ historyVersion: 1, eventId: 'event-1' }) })
    await expect(commit.submit(plan)).resolves.toMatchObject({ kind: 'committed' })
    expect(commit.state(plan.submissionId)?.status).toBe('committed')
    await expect(commit.submit({ ...plan, generation: 4 })).resolves.toMatchObject({ kind: 'not-committed', code: 'protocol-conflict' })
    await expect(commit.submit({ ...plan, revision: 3 })).resolves.toMatchObject({ kind: 'not-committed', code: 'protocol-conflict' })
  })

  it('存储失败进入 rolled_back，允许明确重试并转为 committed', async () => {
    let shouldFail = true
    const commit = new ConfirmationCommit({ commit: async () => {
      if (shouldFail) { shouldFail = false; throw new Error('disk') }
      return { historyVersion: 2, eventId: 'event-2' }
    } })
    await expect(commit.submit(plan)).resolves.toMatchObject({ kind: 'not-committed', canResubmit: true })
    expect(commit.state(plan.submissionId)?.status).toBe('rolled_back')
    await expect(commit.submit({ ...plan, revision: 3 })).resolves.toMatchObject({ kind: 'committed' })
    expect(commit.state(plan.submissionId)?.status).toBe('committed')
  })

  it('回滚后的新 revision 可以改变 action，但跨 owner 或复用 revision 会被拒绝', async () => {
    let shouldFail = true
    const commit = new ConfirmationCommit({ commit: async () => {
      if (shouldFail) { shouldFail = false; throw new Error('disk') }
      return { historyVersion: 2, eventId: 'event-2' }
    } })
    await expect(commit.submit(plan)).resolves.toMatchObject({ kind: 'not-committed', canResubmit: true })
    await expect(commit.submit({ ...plan, revision: 3, action: 'denied', memory: 'none' })).resolves.toMatchObject({ kind: 'committed' })
    await expect(commit.submit({ ...plan, revision: 4, sessionId: 'other-session' })).resolves.toMatchObject({ kind: 'not-committed', code: 'protocol-conflict' })
  })
})

describe('confirmation commit protocol', () => {
  it('commits once and returns the same receipt for duplicate submission', async () => {
    const commit = new ConfirmationCommit({ commit: async () => ({ historyVersion: 3, eventId: 'event-1' }) })
    await expect(commit.submit(plan)).resolves.toMatchObject({ kind: 'committed', historyVersion: 3 })
    await expect(commit.submit(plan)).resolves.toEqual(await commit.query('submission-1'))
  })

  it('does not report committed when storage fails', async () => {
    const commit = new ConfirmationCommit({ commit: async () => { throw new Error('disk') } })
    await expect(commit.submit(plan)).resolves.toMatchObject({ kind: 'not-committed', code: 'storage-failed', canResubmit: true })
  })

  it('exposes unknown after a linearized commit with lost response', async () => {
    const commit = new ConfirmationCommit({ commit: async () => { throw new UnknownCommitError() } })
    await expect(commit.submit(plan)).resolves.toMatchObject({ kind: 'unknown' })
    await expect(commit.query('submission-1')).resolves.toMatchObject({ kind: 'unknown' })
  })

  it('rejects a protocol conflict when the same submission id changes action or memory', async () => {
    const commit = new ConfirmationCommit({ commit: async () => ({ historyVersion: 1, eventId: 'event-1' }) })
    await commit.submit(plan)
    await expect(commit.submit({ ...plan, action: 'denied' })).resolves.toMatchObject({ kind: 'not-committed', code: 'protocol-conflict', canResubmit: false })
  })

  it('linearizes concurrent duplicate submissions', async () => {
    let calls = 0
    let release!: () => void
    const storage = new Promise<{ historyVersion: number; eventId: string }>((resolve) => { release = () => resolve({ historyVersion: 1, eventId: 'event-1' }) })
    const commit = new ConfirmationCommit({ commit: async () => { calls += 1; return storage } })
    const first = commit.submit(plan)
    const second = commit.submit(plan)
    expect(calls).toBe(1)
    release()
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'committed', submissionId: 'submission-1', historyVersion: 1, eventId: 'event-1' },
      { kind: 'committed', submissionId: 'submission-1', historyVersion: 1, eventId: 'event-1' }
    ])
  })

  it('rejects malformed plans before invoking storage', async () => {
    const storage = vi.fn(async () => ({ historyVersion: 1, eventId: 'event-1' }))
    const commit = new ConfirmationCommit({ commit: storage })
    await expect(commit.submit({ ...plan, ownerId: '', revision: 0 })).resolves.toMatchObject({ kind: 'not-committed', code: 'invalid-plan', canResubmit: false })
    expect(storage).not.toHaveBeenCalled()
  })
})

class UnknownCommitError extends Error {}
