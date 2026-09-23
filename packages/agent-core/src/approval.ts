export type ApprovalStatus =
  | 'requested' | 'queued' | 'evaluating' | 'awaiting-user' | 'submitting'
  | 'approved' | 'denied' | 'unavailable' | 'timed-out' | 'cancelled'

export type ApprovalCause =
  | 'agent-approved' | 'agent-deny' | 'policy-denied' | 'user-denied'
  | 'approval-queue-full' | 'approval-queue-timeout' | 'provider-rate-limit'
  | 'provider-unavailable' | 'config-error' | 'unparsable' | 'evaluation-timeout'
  | 'cancelled' | 'interrupted' | 'recursion-blocked' | 'facts-changed' | 'authorization-revoked'

export interface ApprovalRecord {
  schemaVersion: 1
  approvalId: string
  attemptId: string
  toolUseId: string
  answerer: 'agent' | 'user' | 'policy'
  status: ApprovalStatus
  cause?: ApprovalCause
  reason?: { summary: string; nextStep?: string }
  requestedAt: number
  queuedAt?: number
  startedAt?: number
  settledAt?: number
  deadlineAt?: number
  retryAfterAt?: number
  revision: number
}

const terminal = new Set<ApprovalStatus>(['approved', 'denied', 'unavailable', 'timed-out', 'cancelled'])

/** In-memory canonical fact store; persistence is supplied by the host History port. */
export class ApprovalFactStore {
  private readonly records = new Map<string, ApprovalRecord>()

  apply(next: ApprovalRecord): boolean {
    const current = this.records.get(next.approvalId)
    if (current && (current.attemptId !== next.attemptId || next.revision <= current.revision || terminal.has(current.status))) return false
    this.records.set(next.approvalId, structuredClone(next))
    return true
  }

  get(approvalId: string): ApprovalRecord | undefined {
    const value = this.records.get(approvalId)
    return value && structuredClone(value)
  }
}

export type ApprovalRequest = { requestId: string; parentTaskId: string; deadlineAt?: number }
export type ApprovalLease = { kind: 'granted'; release: () => void }
export type ApprovalAcquireResult = ApprovalLease | { kind: 'rejected'; cause: 'queue-full' | 'cancelled' | 'parent-limit' | 'timeout' }

type Waiter = { request: ApprovalRequest; resolve: (result: ApprovalAcquireResult) => void; cancelled: boolean; timer?: ReturnType<typeof setTimeout> }

/** Runtime-owned approval capacity. It never consumes the application's turn admission counter. */
export class ApprovalAdmission {
  private active = 0
  private readonly waiters: Waiter[] = []
  private readonly parentActive = new Map<string, number>()
  constructor(private readonly options: { concurrency: number; queueLimit: number; maxInFlightPerParent?: number }) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error('concurrency must be positive')
    if (!Number.isInteger(options.queueLimit) || options.queueLimit < 0) throw new Error('queueLimit must be non-negative')
  }

  snapshot() { return { active: this.active, queued: this.waiters.length } }

  acquire(request: ApprovalRequest): Promise<ApprovalAcquireResult> {
    if (request.deadlineAt !== undefined && request.deadlineAt <= Date.now()) {
      return Promise.resolve({ kind: 'rejected', cause: 'timeout' })
    }
    const parentActive = this.parentActive.get(request.parentTaskId) ?? 0
    if (this.options.maxInFlightPerParent !== undefined && parentActive >= this.options.maxInFlightPerParent) {
      return Promise.resolve({ kind: 'rejected', cause: 'parent-limit' })
    }
    if (this.active < this.options.concurrency) return Promise.resolve(this.grant(request.parentTaskId))
    if (this.waiters.length >= this.options.queueLimit) return Promise.resolve({ kind: 'rejected', cause: 'queue-full' })
    return new Promise((resolve) => {
      const waiter: Waiter = { request, resolve, cancelled: false }
      this.parentActive.set(request.parentTaskId, parentActive + 1)
      if (request.deadlineAt !== undefined) {
        const remaining = request.deadlineAt - Date.now()
        if (remaining <= 0) {
          this.releaseParentReservation(waiter.request.parentTaskId)
          resolve({ kind: 'rejected', cause: 'timeout' })
          return
        }
        waiter.timer = setTimeout(() => {
          if (waiter.cancelled) return
          const index = this.waiters.indexOf(waiter)
          if (index < 0) return
          waiter.cancelled = true
          this.waiters.splice(index, 1)
          this.releaseParentReservation(waiter.request.parentTaskId)
          waiter.resolve({ kind: 'rejected', cause: 'timeout' })
        }, remaining)
      }
      this.waiters.push(waiter)
    })
  }

  cancel(requestId: string): boolean {
    const waiter = this.waiters.find((item) => item.request.requestId === requestId && !item.cancelled)
    if (!waiter) return false
    waiter.cancelled = true
    this.waiters.splice(this.waiters.indexOf(waiter), 1)
    if (waiter.timer) clearTimeout(waiter.timer)
    this.releaseParentReservation(waiter.request.parentTaskId)
    waiter.resolve({ kind: 'rejected', cause: 'cancelled' })
    return true
  }

  private grant(parentTaskId: string, reserved = false): ApprovalLease {
    this.active += 1
    if (!reserved) this.parentActive.set(parentTaskId, (this.parentActive.get(parentTaskId) ?? 0) + 1)
    let released = false
    return { kind: 'granted', release: () => {
      if (released) return
      released = true
      this.active -= 1
      const remaining = (this.parentActive.get(parentTaskId) ?? 1) - 1
      if (remaining > 0) this.parentActive.set(parentTaskId, remaining)
      else this.parentActive.delete(parentTaskId)
      while (this.waiters.length > 0 && this.active < this.options.concurrency) {
        const waiter = this.waiters.shift()!
        if (waiter.timer) clearTimeout(waiter.timer)
        if (!waiter.cancelled) {
          if (waiter.request.deadlineAt !== undefined && waiter.request.deadlineAt <= Date.now()) {
            waiter.cancelled = true
            this.releaseParentReservation(waiter.request.parentTaskId)
            waiter.resolve({ kind: 'rejected', cause: 'timeout' })
            continue
          }
          const count = this.parentActive.get(waiter.request.parentTaskId) ?? 0
          if (this.options.maxInFlightPerParent !== undefined && count > this.options.maxInFlightPerParent) {
            // count 已包含当前 waiter 的预留名额；出队不会再次占用名额。
            waiter.resolve({ kind: 'rejected', cause: 'parent-limit' })
          } else {
            waiter.resolve(this.grant(waiter.request.parentTaskId, true))
          }
        }
      }
    } }
  }

  private releaseParentReservation(parentTaskId: string): void {
    const count = (this.parentActive.get(parentTaskId) ?? 1) - 1
    if (count > 0) this.parentActive.set(parentTaskId, count)
    else this.parentActive.delete(parentTaskId)
  }
}
