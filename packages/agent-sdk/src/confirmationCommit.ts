export type CommitPlan = {
  submissionId: string
  confirmId: string
  sessionId: string
  ownerId: string
  generation: number
  revision: number
  action: 'approved' | 'denied'; memory: 'written' | 'none'
}

export type ConfirmationCommitStatus =
  | 'pending'
  | 'committing'
  | 'committed'
  | 'rolled_back'
  | 'reconciling'
  | 'cancelled'

export type ConfirmationCommitState = Pick<CommitPlan, 'submissionId' | 'confirmId' | 'sessionId' | 'ownerId' | 'generation' | 'revision'> & {
  status: ConfirmationCommitStatus
}

export type ConfirmationCommitEvent =
  | { type: 'reserve' }
  | { type: 'commit' }
  | { type: 'rollback' }
  | { type: 'reconcile' }
  | { type: 'cancel' }

/**
 * 提交状态的唯一共享转换表。
 *
 * `committing` 之后不允许直接进入 `cancelled`：写入已经开始时，取消方
 * 无法证明授权没有落库，必须进入 `rolled_back` 或 `reconciling`。
 */
export class ConfirmationCommitStateMachine {
  private current: ConfirmationCommitState

  constructor(initial: ConfirmationCommitState) {
    this.current = structuredClone(initial)
  }

  get state(): ConfirmationCommitState {
    return structuredClone(this.current)
  }

  transition(event: ConfirmationCommitEvent): ConfirmationCommitState {
    const next = this.nextStatus(this.current.status, event.type)
    if (!next) throw new Error(`invalid confirmation commit transition: ${this.current.status} -> ${event.type}`)
    this.current = { ...this.current, status: next }
    return this.state
  }

  private nextStatus(status: ConfirmationCommitStatus, event: ConfirmationCommitEvent['type']): ConfirmationCommitStatus | undefined {
    if (status === 'pending' && event === 'reserve') return 'committing'
    if (status === 'pending' && event === 'cancel') return 'cancelled'
    if (status === 'committing' && event === 'commit') return 'committed'
    if (status === 'committing' && event === 'rollback') return 'rolled_back'
    if (status === 'committing' && event === 'reconcile') return 'reconciling'
    return undefined
  }
}

export type CommitReceipt =
  | { kind: 'committed'; submissionId: string; historyVersion: number; eventId: string }
  | { kind: 'not-committed'; submissionId: string; code: 'storage-failed' | 'stale' | 'wrong-owner' | 'protocol-conflict' | 'invalid-plan'; canResubmit: boolean }
  | { kind: 'unknown'; submissionId: string }

type Committer = { commit(plan: CommitPlan): Promise<{ historyVersion: number; eventId: string }> }

export class ConfirmationCommit {
  private readonly receipts = new Map<string, CommitReceipt>()
  private readonly plans = new Map<string, CommitPlan>()
  private readonly inflight = new Map<string, Promise<CommitReceipt>>()
  private readonly states = new Map<string, ConfirmationCommitStateMachine>()
  constructor(private readonly committer: Committer) {}

  async submit(plan: CommitPlan): Promise<CommitReceipt> {
    const existing = this.receipts.get(plan.submissionId)
    if (existing) {
      const original = this.plans.get(plan.submissionId)
      const retryable = existing.kind === 'not-committed' && existing.canResubmit
      const sameOwner = !!original && original.confirmId === plan.confirmId && original.sessionId === plan.sessionId && original.ownerId === plan.ownerId && original.generation === plan.generation
      const newRevision = !!original && plan.revision > original.revision
      const samePlan = !!original && original.revision === plan.revision && original.action === plan.action && original.memory === plan.memory
      if (!original || !sameOwner || (!retryable && !samePlan) || (retryable && !newRevision)) {
        return { kind: 'not-committed', submissionId: plan.submissionId, code: 'protocol-conflict', canResubmit: false }
      }
      if (!retryable) return existing
      this.receipts.delete(plan.submissionId)
      this.states.set(plan.submissionId, new ConfirmationCommitStateMachine({
        submissionId: plan.submissionId,
        confirmId: plan.confirmId,
        sessionId: plan.sessionId,
        ownerId: plan.ownerId,
        generation: plan.generation,
        revision: plan.revision,
        status: 'pending'
      }))
    }
    if (!plan.submissionId || !plan.confirmId || !plan.sessionId || !plan.ownerId || !Number.isInteger(plan.generation) || plan.generation < 1 || !Number.isInteger(plan.revision) || plan.revision < 1) {
      return { kind: 'not-committed', submissionId: plan.submissionId, code: 'invalid-plan', canResubmit: false }
    }
    const pending = this.inflight.get(plan.submissionId)
    if (pending) return pending
    this.plans.set(plan.submissionId, structuredClone(plan))
    const machine = this.states.get(plan.submissionId) ?? new ConfirmationCommitStateMachine({
      submissionId: plan.submissionId,
      confirmId: plan.confirmId,
      sessionId: plan.sessionId,
      ownerId: plan.ownerId,
      generation: plan.generation,
      revision: plan.revision,
      status: 'pending'
    })
    machine.transition({ type: 'reserve' })
    this.states.set(plan.submissionId, machine)
    const operation = this.commitPlan(plan, machine)
    this.inflight.set(plan.submissionId, operation)
    try {
      return await operation
    } finally {
      this.inflight.delete(plan.submissionId)
    }
  }

  private async commitPlan(plan: CommitPlan, machine: ConfirmationCommitStateMachine): Promise<CommitReceipt> {
    let receipt: CommitReceipt
    try {
      const result = await this.committer.commit(plan)
      machine.transition({ type: 'commit' })
      receipt = { kind: 'committed', submissionId: plan.submissionId, ...result }
    } catch (error) {
      if (error instanceof Error && error.constructor.name === 'UnknownCommitError') {
        machine.transition({ type: 'reconcile' })
        receipt = { kind: 'unknown', submissionId: plan.submissionId }
      } else {
        machine.transition({ type: 'rollback' })
        receipt = { kind: 'not-committed', submissionId: plan.submissionId, code: 'storage-failed', canResubmit: true }
      }
    }
    this.receipts.set(plan.submissionId, receipt)
    return receipt
  }

  async query(submissionId: string): Promise<CommitReceipt | undefined> { return this.receipts.get(submissionId) }

  state(submissionId: string): ConfirmationCommitState | undefined {
    return this.states.get(submissionId)?.state
  }
}
