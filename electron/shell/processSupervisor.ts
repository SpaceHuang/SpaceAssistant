import type { ChildProcess } from 'child_process'

export type ProcessTerminationState = 'running' | 'terminating' | 'terminated' | 'termination_failed'

export interface ProcessTerminationResult {
  state: Exclude<ProcessTerminationState, 'running' | 'terminating'>
  signal: string | null
  treeKillVerified: boolean
}

export interface ProcessKiller {
  terminate(proc: ChildProcess, deadlineMs: number): Promise<{ signal: string | null; verified: boolean }>
}

export class ProcessSupervisor {
  private currentState: ProcessTerminationState = 'running'
  private result: ProcessTerminationResult | undefined
  private pending: Promise<ProcessTerminationResult> | undefined

  constructor(private readonly proc: ChildProcess, private readonly killer: ProcessKiller) {}

  get state(): ProcessTerminationState { return this.currentState }

  terminate(deadlineMs = 3000): Promise<ProcessTerminationResult> {
    if (this.result) return Promise.resolve(this.result)
    if (this.pending) return this.pending
    this.currentState = 'terminating'
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<{ signal: string | null; verified: boolean }>((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ signal: null, verified: false }), Math.max(0, deadlineMs))
    })
    const termination = this.killer.terminate(this.proc, deadlineMs).then(
      ({ signal, verified }) => ({ signal, verified }),
      () => ({ signal: null, verified: false })
    )
    this.pending = Promise.race([termination, timeout]).then(({ signal, verified }) => {
      this.result = { state: verified ? 'terminated' : 'termination_failed', signal, treeKillVerified: verified }
      this.currentState = this.result.state
      return this.result
    }, () => {
      this.result = { state: 'termination_failed', signal: null, treeKillVerified: false }
      this.currentState = 'termination_failed'
      return this.result
    }).finally(() => {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
    })
    return this.pending
  }
}
