export type InvocationTerminalStatus = 'completed' | 'cancelled' | 'failed' | 'denied' | 'interrupted'
export type InvocationStatus = 'running' | InvocationTerminalStatus
export type InvocationSnapshot = Readonly<{ invocationId: string; status: InvocationStatus }>
export type AgentInvocationIdentity = Readonly<{ requestId: string; turnId: string; invocationId: string }>

/** Minimal host-neutral lifecycle ledger for one invocation. */
export class InvocationLifecycle {
  private status: InvocationStatus = 'running'

  constructor(readonly invocationId: string) {
    if (!invocationId.trim()) throw new Error('invocationId is required')
  }

  snapshot(): InvocationSnapshot {
    return { invocationId: this.invocationId, status: this.status }
  }

  settle(status: InvocationTerminalStatus): InvocationSnapshot | undefined {
    if (this.status !== 'running') return undefined
    this.status = status
    return this.snapshot()
  }
}
