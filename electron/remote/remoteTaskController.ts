/**
 * Remote task execution controller (WP4).
 *
 * Owns the per-remote-task execution boundaries the tool loop cannot express on its own:
 *   - at most one concurrent script/shell execution per remote task (others queue);
 *   - an attributable "kill" for each in-flight execution (process tree termination);
 *   - a single stop entry point usable from the desktop or the IM owner;
 *   - emergency-close ordering: cancel executions + queued work + pending confirms
 *     BEFORE the channel stops listening.
 *
 * This module is intentionally free of Electron / child_process imports so it can be unit
 * tested with a fake clock and fake kill callbacks. The tool loop injects the real
 * `killProcessTree` wrapper and pending-confirm cancellation.
 */

export type RemoteTaskStopReason =
  | 'user-desktop'
  | 'user-im'
  | 'emergency-close'
  | 'budget'
  | 'app-quit'

export type RemoteExecutionKind = 'script' | 'shell'

export interface RemoteTaskClock {
  now(): number
}

const REAL_CLOCK: RemoteTaskClock = { now: () => Date.now() }

interface RunningExecution {
  execId: string
  kind: RemoteExecutionKind
  startedAt: number
  kill: () => void
}

interface QueuedExecution {
  execId: string
  kind: RemoteExecutionKind
  onGranted: () => void
  onCancelled: (reason: RemoteTaskStopReason) => void
}

interface RemoteTaskState {
  taskId: string
  sessionId?: string
  maxConcurrent: number
  cancelled: boolean
  cancelReason?: RemoteTaskStopReason
  running: RunningExecution[]
  queue: QueuedExecution[]
  /** Extra cancellation hooks (pending confirm, queued inbound) fired on stop. */
  onStopHooks: Array<(reason: RemoteTaskStopReason) => void>
}

export class RemoteTaskCancelledError extends Error {
  constructor(readonly reason: RemoteTaskStopReason) {
    super('远程任务已停止')
    this.name = 'RemoteTaskCancelledError'
  }
}

export class RemoteTaskController {
  private readonly tasks = new Map<string, RemoteTaskState>()

  constructor(private readonly clock: RemoteTaskClock = REAL_CLOCK) {}

  /** Register (or fetch) a task. Idempotent; concurrency defaults to 1. */
  ensureTask(taskId: string, opts?: { sessionId?: string; maxConcurrent?: number }): void {
    let t = this.tasks.get(taskId)
    if (!t) {
      t = {
        taskId,
        sessionId: opts?.sessionId,
        maxConcurrent: Math.max(1, opts?.maxConcurrent ?? 1),
        cancelled: false,
        running: [],
        queue: [],
        onStopHooks: []
      }
      this.tasks.set(taskId, t)
    } else {
      if (opts?.sessionId) t.sessionId = opts.sessionId
      if (opts?.maxConcurrent) t.maxConcurrent = Math.max(1, opts.maxConcurrent)
    }
  }

  isCancelled(taskId: string): boolean {
    return this.tasks.get(taskId)?.cancelled ?? false
  }

  cancelReason(taskId: string): RemoteTaskStopReason | undefined {
    return this.tasks.get(taskId)?.cancelReason
  }

  runningCount(taskId: string): number {
    return this.tasks.get(taskId)?.running.length ?? 0
  }

  queuedCount(taskId: string): number {
    return this.tasks.get(taskId)?.queue.length ?? 0
  }

  /** Register a hook fired (once) when the task is stopped, e.g. cancel pending confirm. */
  onStop(taskId: string, hook: (reason: RemoteTaskStopReason) => void): void {
    this.ensureTask(taskId)
    this.tasks.get(taskId)!.onStopHooks.push(hook)
  }

  /**
   * Acquire the single execution slot for a script/shell run. Resolves once a slot is free.
   * Rejects with RemoteTaskCancelledError if the task is (or becomes) cancelled while waiting.
   *
   * Returns a handle whose `release()` frees the slot and drains the queue, and whose
   * `kill` is replaced by the caller once the child process exists.
   */
  acquireExecutionSlot(
    taskId: string,
    execId: string,
    kind: RemoteExecutionKind
  ): Promise<RemoteExecutionHandle> {
    this.ensureTask(taskId)
    const t = this.tasks.get(taskId)!
    if (t.cancelled) {
      return Promise.reject(new RemoteTaskCancelledError(t.cancelReason ?? 'user-desktop'))
    }

    if (t.running.length < t.maxConcurrent) {
      return Promise.resolve(this.grantSlot(t, execId, kind))
    }

    return new Promise<RemoteExecutionHandle>((resolve, reject) => {
      t.queue.push({
        execId,
        kind,
        onGranted: () => resolve(this.grantSlot(t, execId, kind)),
        onCancelled: (reason) => reject(new RemoteTaskCancelledError(reason))
      })
    })
  }

  private grantSlot(
    t: RemoteTaskState,
    execId: string,
    kind: RemoteExecutionKind
  ): RemoteExecutionHandle {
    const running: RunningExecution = {
      execId,
      kind,
      startedAt: this.clock.now(),
      kill: () => {}
    }
    t.running.push(running)
    let released = false
    return {
      execId,
      setKill: (kill: () => void) => {
        running.kill = kill
      },
      release: () => {
        if (released) return
        released = true
        t.running = t.running.filter((r) => r !== running)
        this.drainQueue(t)
      }
    }
  }

  private drainQueue(t: RemoteTaskState): void {
    while (!t.cancelled && t.running.length < t.maxConcurrent && t.queue.length > 0) {
      const next = t.queue.shift()!
      // onGranted synchronously pushes to running via grantSlot.
      next.onGranted()
    }
  }

  /**
   * Stop a single remote task: mark cancelled, kill running executions, reject queued
   * executions, and fire stop hooks. Safe to call repeatedly (first reason wins).
   */
  stopTask(taskId: string, reason: RemoteTaskStopReason): void {
    const t = this.tasks.get(taskId)
    if (!t) return
    if (!t.cancelled) {
      t.cancelled = true
      t.cancelReason = reason
    }
    const running = [...t.running]
    t.running = []
    for (const r of running) {
      try {
        r.kill()
      } catch {
        /* ignore kill errors */
      }
    }
    const queued = [...t.queue]
    t.queue = []
    for (const q of queued) {
      try {
        q.onCancelled(reason)
      } catch {
        /* ignore */
      }
    }
    const hooks = [...t.onStopHooks]
    t.onStopHooks = []
    for (const h of hooks) {
      try {
        h(reason)
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Emergency close for a remote channel/session: stop every task bound to `sessionId`
   * (or all tasks when omitted). Callers must invoke this BEFORE tearing down the listener
   * so executions, queued work and pending confirms are cancelled first.
   */
  emergencyClose(opts?: { sessionId?: string; reason?: RemoteTaskStopReason }): number {
    const reason = opts?.reason ?? 'emergency-close'
    let stopped = 0
    for (const t of [...this.tasks.values()]) {
      if (opts?.sessionId && t.sessionId !== opts.sessionId) continue
      if (!t.cancelled) stopped++
      this.stopTask(t.taskId, reason)
    }
    return stopped
  }

  /** Remove finished/cancelled task bookkeeping. */
  clearTask(taskId: string): void {
    this.tasks.delete(taskId)
  }
}

export interface RemoteExecutionHandle {
  execId: string
  /** Attach the real process-tree kill once the child exists. */
  setKill(kill: () => void): void
  /** Free the slot and let queued executions proceed. Idempotent. */
  release(): void
}

/** Process-wide controller used by the tool loop / channel routers. */
let sharedController: RemoteTaskController | null = null

export function getRemoteTaskController(): RemoteTaskController {
  if (!sharedController) sharedController = new RemoteTaskController()
  return sharedController
}

/** Test-only: reset the shared controller. */
export function __resetRemoteTaskControllerForTests(clock?: RemoteTaskClock): void {
  sharedController = new RemoteTaskController(clock)
}

/** @deprecated alias — prefer __resetRemoteTaskControllerForTests */
export function resetRemoteTaskControllerForTests(clock?: RemoteTaskClock): void {
  __resetRemoteTaskControllerForTests(clock)
}

/** User-facing deny copy: no A/B pattern codes; always offer desktop path. */
export function formatScriptDenyUserMessage(reason?: string): string {
  const cleaned = (reason ?? '')
    .replace(/\b[AB]\d+\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 120)
  const detail = cleaned ? `：${cleaned}` : ''
  return `脚本未通过内容安全检查，已拒绝执行${detail}。请回桌面查看详情后再试。`
}

/** Soft wording for allow path (never “安全脚本”). */
export function formatScriptAllowHint(): string {
  return '未发现已知高风险模式'
}

export type ScriptExecutionSummaryInput = {
  durationMs: number
  exitCode: number | null
  timedOut?: boolean
  truncated?: boolean
  budgetPaused?: boolean
  workspaceMayHaveChanged?: boolean
}

export type ScriptExecutionSummary = {
  durationMs: number
  exitCode: number | null
  timedOut: boolean
  truncated: boolean
  budgetPaused: boolean
  workspaceMayHaveChanged: boolean
  userMessage: string
}

/** Build a short execution summary for IM/desktop (no technical A/B codes). */
export function buildScriptExecutionSummary(input: ScriptExecutionSummaryInput): ScriptExecutionSummary {
  const timedOut = Boolean(input.timedOut)
  const truncated = Boolean(input.truncated)
  const budgetPaused = Boolean(input.budgetPaused)
  const workspaceMayHaveChanged = Boolean(input.workspaceMayHaveChanged)
  const secs = Math.max(0, Math.round(input.durationMs / 1000))
  const parts: string[] = []
  if (timedOut) {
    parts.push(`已超时停止（约 ${secs}s）`)
  } else if (input.exitCode === 0) {
    parts.push(`已完成（约 ${secs}s）`)
  } else {
    parts.push(`已结束，退出码 ${input.exitCode ?? '未知'}（约 ${secs}s）`)
  }
  if (truncated) parts.push('输出已截断')
  if (budgetPaused) parts.push('已达任务预算')
  if (workspaceMayHaveChanged) parts.push('工作区可能有变更，可回桌面恢复')
  return {
    durationMs: input.durationMs,
    exitCode: input.exitCode,
    timedOut,
    truncated,
    budgetPaused,
    workspaceMayHaveChanged,
    userMessage: parts.join('；')
  }
}
