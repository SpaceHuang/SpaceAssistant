import type { AppDatabase } from '../database/sqliteStore'
import { createImLifecycleOutbox } from './imLifecycleOutbox'
import { markDeferredCompletionWakeDelivered } from './deferredCompletionWake'

export type DeferredCompletionWakeTurn = Readonly<{ state: string; outcome?: string | null }>
export type DeferredCompletionWakeRecoveryDecision =
  | { kind: 'start' }
  | { kind: 'acknowledge' }
  | { kind: 'notify-interrupted'; outcome: string }
  | { kind: 'recovery-pending' }

/** Reconciles an existing completion turn before deciding whether any follow-up work may run. */
export function decideDeferredCompletionWakeRecovery(input: {
  read: () => DeferredCompletionWakeTurn | undefined
  recover: () => unknown
}): DeferredCompletionWakeRecoveryDecision {
  const existing = input.read()
  if (!existing) return { kind: 'start' }
  let turn = existing
  if (turn.state !== 'terminal') {
    input.recover()
    const recovered = input.read()
    if (!recovered || recovered.state !== 'terminal') return { kind: 'recovery-pending' }
    turn = recovered
  }
  if (turn.outcome === 'completed' || turn.outcome === 'parked') return { kind: 'acknowledge' }
  return { kind: 'notify-interrupted', outcome: turn.outcome ?? 'unknown' }
}

/** User-visible failure receipt is durable; only a successful platform send consumes the completion outbox. */
export async function deliverInterruptedDeferredCompletionNotice(db: AppDatabase, input: {
  todoId: string
  sessionId: string
  now?: number
  send: (text: string) => Promise<void>
}): Promise<void> {
  const eventId = `deferred-completion-interrupted:${input.todoId}`
  const text = '原操作结果已保存，但后续回复在恢复时中断。为避免重复操作，系统没有重跑任务；请检查桌面会话中的状态后再继续。'
  await createImLifecycleOutbox(db).deliver({ eventId, sessionId: input.sessionId, stage: 'failed', text }, input.send)
  if (!markDeferredCompletionWakeDelivered(db, input.todoId, input.now)) {
    throw new Error('DEFERRED_COMPLETION_INTERRUPTION_ACK_FAILED')
  }
}
