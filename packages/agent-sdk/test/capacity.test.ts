import { describe, expect, it } from 'vitest'
import { CapacityLedger } from '../src/capacity'

describe('CapacityLedger 统一容量模型', () => {
  it('应用 lease 与审批 candidate 使用独立上限，但共享可观测快照', () => {
    const ledger = new CapacityLedger({ applicationSlots: 1, approvalCandidateSlots: 2, queueLimit: 2, maxApprovalsPerParent: 2 })
    const app = ledger.reserveApplicationLease('task-a')
    expect(app).toBeDefined()
    expect(ledger.reserveApplicationLease('task-b')).toBeUndefined()
    const candidateA = ledger.reserveApprovalCandidate('parent-a')
    const candidateB = ledger.reserveApprovalCandidate('parent-a')
    expect(candidateA).toBeDefined()
    expect(candidateB).toBeDefined()
    expect(ledger.reserveApprovalCandidate('parent-a')).toBeUndefined()
    expect(ledger.snapshot()).toMatchObject({ applicationLeases: 1, approvalCandidates: 2, parentApprovalCounts: { 'parent-a': 2 } })
    app?.release()
    candidateA?.release()
    expect(ledger.snapshot()).toMatchObject({ applicationLeases: 0, approvalCandidates: 1, parentApprovalCounts: { 'parent-a': 1 } })
  })

  it('普通队列和恢复队列共享总容量，释放后可再次入队', () => {
    const ledger = new CapacityLedger({ applicationSlots: 1, approvalCandidateSlots: 1, queueLimit: 2, maxApprovalsPerParent: 1 })
    expect(ledger.enqueue('normal', 'normal-1')).toBe(true)
    expect(ledger.enqueue('resume', 'resume-1')).toBe(true)
    expect(ledger.enqueue('normal', 'normal-2')).toBe(false)
    expect(ledger.snapshot()).toMatchObject({ queuedNormal: 1, queuedResume: 1, queuedTotal: 2 })
    expect(ledger.dequeue('resume-1')).toEqual({ kind: 'resume', id: 'resume-1' })
    expect(ledger.enqueue('normal', 'normal-2')).toBe(true)
    expect(ledger.dequeue('missing')).toBeUndefined()
  })

  it('重复释放旧 application lease 不会释放后来获得的 lease', () => {
    const ledger = new CapacityLedger({ applicationSlots: 1, approvalCandidateSlots: 1, queueLimit: 1, maxApprovalsPerParent: 1 })
    const first = ledger.reserveApplicationLease('first')!
    first.release()
    const second = ledger.reserveApplicationLease('second')!
    first.release()
    expect(ledger.snapshot().applicationLeases).toBe(1)
    expect(ledger.reserveApplicationLease('third')).toBeUndefined()
    second.release()
    expect(ledger.snapshot().applicationLeases).toBe(0)
  })

  it('重复释放同一父任务的旧审批预留不污染新预留计数', () => {
    const ledger = new CapacityLedger({ applicationSlots: 1, approvalCandidateSlots: 2, queueLimit: 1, maxApprovalsPerParent: 1 })
    const first = ledger.reserveApprovalCandidate('parent')!
    first.release()
    const second = ledger.reserveApprovalCandidate('parent')!
    first.release()
    expect(ledger.snapshot()).toMatchObject({ approvalCandidates: 1, parentApprovalCounts: { parent: 1 } })
    expect(ledger.reserveApprovalCandidate('parent')).toBeUndefined()
    second.release()
    expect(ledger.snapshot()).toMatchObject({ approvalCandidates: 0, parentApprovalCounts: {} })
  })
})
