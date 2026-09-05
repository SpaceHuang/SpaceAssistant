export type ExecutionTerminationReason = 'user_cancel' | 'timeout' | 'output_limit' | 'process_exit' | 'transport_error'

const PRIORITY: Record<ExecutionTerminationReason, number> = {
  user_cancel: 5,
  timeout: 4,
  output_limit: 3,
  process_exit: 2,
  transport_error: 1
}

export interface ExecutionFinalState<T> {
  reason: ExecutionTerminationReason
  value: T
}

/** 将多个异步退出信号归并为单一终态；高优先级信号可替换尚未结算的低优先级信号。 */
export class ExecutionLifecycle<T> {
  private finalState: ExecutionFinalState<T> | undefined

  get settled(): boolean {
    return this.finalState !== undefined
  }

  get state(): ExecutionFinalState<T> | undefined {
    return this.finalState
  }

  finalize(reason: ExecutionTerminationReason, value: T): boolean {
    if (this.finalState && PRIORITY[reason] <= PRIORITY[this.finalState.reason]) return false
    this.finalState = { reason, value }
    return true
  }
}
