import { describe, expect, it } from 'vitest'
import {
  ApprovalAdmission,
  ApprovalFactStore,
  type ApprovalRecord
} from '../src/approval'

const record = (overrides: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  schemaVersion: 1,
  approvalId: 'approval-1',
  attemptId: 'attempt-1',
  toolUseId: 'tool-1',
  answerer: 'agent',
  status: 'requested',
  requestedAt: 1,
  revision: 1,
  ...overrides
})

describe('SDK approval facts', () => {
  it('keeps approval and execution axes separate and preserves deny reason', () => {
    const store = new ApprovalFactStore()
    store.apply(record({ status: 'evaluating', revision: 2 }))
    store.apply(record({ status: 'denied', cause: 'agent-deny', reason: { summary: '扩大写入范围' }, settledAt: 3, revision: 3 }))
    expect(store.get('approval-1')?.status).toBe('denied')
    expect(store.get('approval-1')?.reason?.summary).toBe('扩大写入范围')

    store.apply(record({ status: 'approved', revision: 4 }))
    expect(store.get('approval-1')?.status).toBe('denied')
  })

  it('does not let a late old attempt overwrite a newer attempt', () => {
    const store = new ApprovalFactStore()
    store.apply(record({ attemptId: 'attempt-2', status: 'approved', revision: 2 }))
    store.apply(record({ attemptId: 'attempt-1', status: 'denied', revision: 9 }))
    expect(store.get('approval-1')?.attemptId).toBe('attempt-2')
    expect(store.get('approval-1')?.status).toBe('approved')
  })
})

describe('isolated approval admission', () => {
  it('uses a separate bounded pool and supports cancellation', async () => {
    const gate = new ApprovalAdmission({ concurrency: 1, queueLimit: 1 })
    const first = await gate.acquire({ requestId: 'r1', parentTaskId: 'p1' })
    expect(first.kind).toBe('granted')
    const queued = gate.acquire({ requestId: 'r2', parentTaskId: 'p2' })
    const cancelled = gate.acquire({ requestId: 'r3', parentTaskId: 'p3' })
    expect(gate.snapshot().active).toBe(1)
    expect(gate.snapshot().queued).toBe(1)
    expect((await cancelled).kind).toBe('rejected')
    if (first.kind === 'granted') first.release()
    expect((await queued).kind).toBe('granted')
  })

  it('does not share queues between runtime instances', async () => {
    const a = new ApprovalAdmission({ concurrency: 1, queueLimit: 0 })
    const b = new ApprovalAdmission({ concurrency: 1, queueLimit: 0 })
    const lease = await a.acquire({ requestId: 'same', parentTaskId: 'a' })
    expect((await b.acquire({ requestId: 'same', parentTaskId: 'b' })).kind).toBe('granted')
    if (lease.kind === 'granted') lease.release()
  })

  it('limits in-flight approvals per parent task', async () => {
    const gate = new ApprovalAdmission({ concurrency: 2, queueLimit: 1, maxInFlightPerParent: 1 })
    const first = await gate.acquire({ requestId: 'p1-a', parentTaskId: 'p1' })
    const second = await gate.acquire({ requestId: 'p1-b', parentTaskId: 'p1' })
    expect(second).toEqual({ kind: 'rejected', cause: 'parent-limit' })
    if (first.kind === 'granted') first.release()
  })

  it('累计同一父任务的直接发放票据，不允许第三个审批绕过上限', async () => {
    const gate = new ApprovalAdmission({ concurrency: 4, queueLimit: 2, maxInFlightPerParent: 2 })
    const first = await gate.acquire({ requestId: 'direct-1', parentTaskId: 'parent' })
    const second = await gate.acquire({ requestId: 'direct-2', parentTaskId: 'parent' })
    const third = await gate.acquire({ requestId: 'direct-3', parentTaskId: 'parent' })
    expect(first.kind).toBe('granted')
    expect(second.kind).toBe('granted')
    expect(third).toEqual({ kind: 'rejected', cause: 'parent-limit' })
    if (first.kind === 'granted') first.release()
    if (second.kind === 'granted') second.release()
  })

  it('释放容量时再次检查已过期的排队审批', async () => {
    const gate = new ApprovalAdmission({ concurrency: 1, queueLimit: 1 })
    const first = await gate.acquire({ requestId: 'blocker', parentTaskId: 'p' })
    const queued = gate.acquire({ requestId: 'expired-queued', parentTaskId: 'p', deadlineAt: Date.now() + 2 })
    await new Promise((resolve) => setTimeout(resolve, 8))
    if (first.kind === 'granted') first.release()
    await expect(queued).resolves.toEqual({ kind: 'rejected', cause: 'timeout' })
  })

  it('expires queued approvals at their deadline without waiting for a release', async () => {
    const gate = new ApprovalAdmission({ concurrency: 1, queueLimit: 2 })
    const first = await gate.acquire({ requestId: 'first', parentTaskId: 'parent' })
    const queued = gate.acquire({ requestId: 'queued', parentTaskId: 'parent', deadlineAt: Date.now() + 10 })
    await new Promise((resolve) => setTimeout(resolve, 25))
    await expect(queued).resolves.toMatchObject({ kind: 'rejected', cause: 'timeout' })
    expect(gate.snapshot()).toMatchObject({ active: 1, queued: 0 })
    if (first.kind === 'granted') first.release()
  })

  it('同一父任务的两个排队审批按预留名额依次获准', async () => {
    const gate = new ApprovalAdmission({ concurrency: 1, queueLimit: 2, maxInFlightPerParent: 2 })
    const first = await gate.acquire({ requestId: 'other', parentTaskId: 'other' })
    const q1 = gate.acquire({ requestId: 'p-q1', parentTaskId: 'p' })
    const q2 = gate.acquire({ requestId: 'p-q2', parentTaskId: 'p' })
    if (first.kind === 'granted') first.release()
    await expect(q1).resolves.toMatchObject({ kind: 'granted' })
    const q1Lease = await q1
    if (q1Lease.kind === 'granted') q1Lease.release()
    await expect(q2).resolves.toMatchObject({ kind: 'granted' })
    const q2Lease = await q2
    if (q2Lease.kind === 'granted') q2Lease.release()
  })

  it('rejects an already expired request even when capacity is available', async () => {
    const gate = new ApprovalAdmission({ concurrency: 1, queueLimit: 1 })
    await expect(gate.acquire({ requestId: 'expired', parentTaskId: 'parent', deadlineAt: Date.now() - 1 }))
      .resolves.toEqual({ kind: 'rejected', cause: 'timeout' })
    expect(gate.snapshot()).toEqual({ active: 0, queued: 0 })
  })
})
