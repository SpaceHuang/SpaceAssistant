/**
 * Remote task damage budget (§2.5 / WP5).
 * Pure state machine checked before confirm/execute. Pause (do not drop) when exceeded.
 * "Continue" grants one same-size top-up bound to the task id; stop invalidates tokens.
 */
import {
  DEFAULT_REMOTE_TASK_BUDGET,
  type RemoteTaskBudget
} from '../../src/shared/imTypes'

export type { RemoteTaskBudget }
export { DEFAULT_REMOTE_TASK_BUDGET }

export type BudgetPauseReason =
  | 'tool_calls'
  | 'execution_wall'
  | 'concurrent'
  | 'consecutive_outbound_writes'

export type BudgetCheckResult =
  | { ok: true }
  | { ok: false; reason: BudgetPauseReason; message: string }

export type RemoteTaskBudgetState = {
  taskId: string
  limits: RemoteTaskBudget
  toolCalls: number
  executionWallMs: number
  concurrentExecutions: number
  consecutiveOutboundWrites: number
  continueToken: string | null
  continueGrantsRemaining: number
  stopped: boolean
}

let continueSeq = 0

export function createRemoteTaskBudgetState(
  taskId: string,
  limits: RemoteTaskBudget = DEFAULT_REMOTE_TASK_BUDGET
): RemoteTaskBudgetState {
  return {
    taskId,
    limits: { ...limits },
    toolCalls: 0,
    executionWallMs: 0,
    concurrentExecutions: 0,
    consecutiveOutboundWrites: 0,
    continueToken: null,
    continueGrantsRemaining: 0,
    stopped: false
  }
}

function effectiveLimit(state: RemoteTaskBudgetState, key: keyof RemoteTaskBudget): number {
  const base = state.limits[key]
  if (state.continueGrantsRemaining > 0) return base * 2
  return base
}

export function checkRemoteTaskBudget(
  state: RemoteTaskBudgetState,
  kind: 'tool_call' | 'start_execution' | 'outbound_write'
): BudgetCheckResult {
  if (state.stopped) {
    return { ok: false, reason: 'tool_calls', message: '远程任务已停止，继续额度已失效。' }
  }
  if (kind === 'tool_call') {
    const max = effectiveLimit(state, 'maxToolCalls')
    if (state.toolCalls >= max) {
      return {
        ok: false,
        reason: 'tool_calls',
        message: `已达工具调用预算（${max} 次），请回复继续、回桌面或停止。`
      }
    }
  }
  if (kind === 'start_execution') {
    const max = effectiveLimit(state, 'maxConcurrentExecutions')
    if (state.concurrentExecutions >= max) {
      return {
        ok: false,
        reason: 'concurrent',
        message: `同一远程会话最多并行 ${max} 个脚本/Shell 执行。`
      }
    }
    const wallSec = effectiveLimit(state, 'maxExecutionWallSec')
    if (state.executionWallMs / 1000 >= wallSec) {
      return {
        ok: false,
        reason: 'execution_wall',
        message: `已达累计执行时长预算（${wallSec} 秒）。`
      }
    }
  }
  if (kind === 'outbound_write') {
    const max = effectiveLimit(state, 'maxConsecutiveOutboundWrites')
    // Ask on the (max+1)th — i.e. when count already reached max before this write
    if (state.consecutiveOutboundWrites >= max) {
      return {
        ok: false,
        reason: 'consecutive_outbound_writes',
        message: `连续外部写已达 ${max} 次，需确认后继续。`
      }
    }
  }
  return { ok: true }
}

export function recordToolCall(state: RemoteTaskBudgetState): void {
  state.toolCalls += 1
}

export function beginExecution(state: RemoteTaskBudgetState): void {
  state.concurrentExecutions += 1
}

export function endExecution(state: RemoteTaskBudgetState, durationMs: number): void {
  state.concurrentExecutions = Math.max(0, state.concurrentExecutions - 1)
  state.executionWallMs += Math.max(0, durationMs)
}

export function recordOutboundWrite(state: RemoteTaskBudgetState): void {
  state.consecutiveOutboundWrites += 1
}

/** After user approves the write-budget ask, reset consecutive counter. */
export function resetConsecutiveOutboundWrites(state: RemoteTaskBudgetState): void {
  state.consecutiveOutboundWrites = 0
}

/**
 * Issue a one-shot continue token for this task. Applying it doubles effective limits once.
 * Bound to taskId — cannot be reused across tasks.
 */
export function issueContinueToken(state: RemoteTaskBudgetState): string {
  if (state.stopped) throw new Error('task stopped')
  continueSeq += 1
  const token = `${state.taskId}:cont:${continueSeq}`
  state.continueToken = token
  return token
}

export function applyContinueToken(state: RemoteTaskBudgetState, token: string): boolean {
  if (state.stopped) return false
  if (!token || token !== state.continueToken) return false
  if (!token.startsWith(`${state.taskId}:`)) return false
  state.continueToken = null
  state.continueGrantsRemaining = 1
  return true
}

/** Consume one continue grant after a successful boundary cross is recorded. */
export function consumeContinueGrant(state: RemoteTaskBudgetState): void {
  if (state.continueGrantsRemaining > 0) state.continueGrantsRemaining -= 1
}

export function stopRemoteTaskBudget(state: RemoteTaskBudgetState): void {
  state.stopped = true
  state.continueToken = null
  state.continueGrantsRemaining = 0
}
