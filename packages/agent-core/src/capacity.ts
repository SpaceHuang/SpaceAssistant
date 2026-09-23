export type CapacityQueueKind = 'normal' | 'resume'

export type CapacitySnapshot = {
  applicationLeases: number
  approvalCandidates: number
  parentApprovalCounts: Record<string, number>
  queuedNormal: number
  queuedResume: number
  queuedTotal: number
}

export type CapacityReservation = { release: () => void }

/**
 * 运行时容量的共享账本。
 *
 * application lease、approval candidate 和 resume/normal queue 是不同维度，
 * 但都必须从同一个状态快照观察和释放；这样 parent 限额、审批预留位与恢复
 * 队列不会各自维护一套“看起来空闲”的计数。
 */
export class CapacityLedger {
  private applicationLeases = 0
  private approvalCandidates = 0
  private readonly parentApprovalCounts = new Map<string, number>()
  private readonly queued = new Map<string, CapacityQueueKind>()

  constructor(private readonly limits: {
    applicationSlots: number
    approvalCandidateSlots: number
    queueLimit: number
    maxApprovalsPerParent: number
  }) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isInteger(value) || value < 0 || (name !== 'queueLimit' && value < 1)) throw new Error(`invalid capacity limit: ${name}`)
    }
  }

  snapshot(): CapacitySnapshot {
    const parentApprovalCounts: Record<string, number> = {}
    for (const [parent, count] of this.parentApprovalCounts) parentApprovalCounts[parent] = count
    let queuedNormal = 0
    let queuedResume = 0
    for (const kind of this.queued.values()) {
      if (kind === 'normal') queuedNormal += 1
      else queuedResume += 1
    }
    return {
      applicationLeases: this.applicationLeases,
      approvalCandidates: this.approvalCandidates,
      parentApprovalCounts,
      queuedNormal,
      queuedResume,
      queuedTotal: this.queued.size
    }
  }

  reserveApplicationLease(_ownerId: string): CapacityReservation | undefined {
    if (this.applicationLeases >= this.limits.applicationSlots) return undefined
    this.applicationLeases += 1
    let released = false
    return { release: () => {
      if (released) return
      released = true
      this.applicationLeases = Math.max(0, this.applicationLeases - 1)
    } }
  }

  reserveApprovalCandidate(parentTaskId: string): CapacityReservation | undefined {
    const parentCount = this.parentApprovalCounts.get(parentTaskId) ?? 0
    if (this.approvalCandidates >= this.limits.approvalCandidateSlots || parentCount >= this.limits.maxApprovalsPerParent) return undefined
    this.approvalCandidates += 1
    this.parentApprovalCounts.set(parentTaskId, parentCount + 1)
    let released = false
    return { release: () => {
      if (released) return
      released = true
      this.approvalCandidates = Math.max(0, this.approvalCandidates - 1)
      const next = (this.parentApprovalCounts.get(parentTaskId) ?? 1) - 1
      if (next > 0) this.parentApprovalCounts.set(parentTaskId, next)
      else this.parentApprovalCounts.delete(parentTaskId)
    } }
  }

  enqueue(kind: CapacityQueueKind, id: string): boolean {
    if (this.queued.has(id) || this.queued.size >= this.limits.queueLimit) return false
    this.queued.set(id, kind)
    return true
  }

  dequeue(id: string): { kind: CapacityQueueKind; id: string } | undefined {
    const kind = this.queued.get(id)
    if (!kind) return undefined
    this.queued.delete(id)
    return { kind, id }
  }
}
