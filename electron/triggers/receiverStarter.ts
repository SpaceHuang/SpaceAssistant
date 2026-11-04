import type { QueueScope } from '../../src/shared/queueScope'
import type { TurnIntent } from '../../src/shared/assistantFactAggregator'
import { AgentTurnPauseTimedOutError } from '../../packages/agent-sdk/src/turn'

export function runtimeTriggerQueueLane(scope: QueueScope): 'desktop' | 'wechat' | 'feishu' {
  return scope.kind === 'im' ? scope.channel : 'desktop'
}

export type RuntimeTriggerReceiverStartInput = Readonly<{ sessionId: string; requestId: string; messageId: string; queueScope: QueueScope }>

/** Wait for the shared recovery owner to claim a previously queued marker and persist its Turn identity. */
export function waitForRuntimeTriggerReceiverTurn(input: {
  readReceipt(): Readonly<{ queuedMessageId?: string; turnId?: string; state: string }> | undefined
  expectedMessageId: string
  signal: AbortSignal
  deadlineAt: number
  now?: () => number
  pollIntervalMs?: number
}): Promise<string> {
  const now = input.now ?? Date.now
  const interval = input.pollIntervalMs ?? 50
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (error?: Error, turnId?: string) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      input.signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else if (turnId) resolve(turnId)
      else reject(new Error('runtime trigger receiver turn identity unavailable'))
    }
    const onAbort = () => finish(input.signal.reason === 'lifecycle-pause-timeout'
      ? new AgentTurnPauseTimedOutError()
      : input.signal.reason instanceof Error ? input.signal.reason : new Error(String(input.signal.reason ?? 'sync wait aborted')))
    const poll = () => {
      if (input.signal.aborted) { onAbort(); return }
      if (now() >= input.deadlineAt) { finish(new AgentTurnPauseTimedOutError()); return }
      let receipt: ReturnType<typeof input.readReceipt>
      try { receipt = input.readReceipt() }
      catch { finish(new Error('runtime trigger receipt unavailable')); return }
      if (!receipt || receipt.queuedMessageId !== input.expectedMessageId) { finish(new Error('runtime trigger receipt binding invalid')); return }
      if (receipt.turnId) { finish(undefined, receipt.turnId); return }
      if (receipt.state !== 'queued' && receipt.state !== 'claimed') { finish(new Error(`runtime trigger receipt is ${receipt.state}`)); return }
      timer = setTimeout(poll, interval)
    }
    input.signal.addEventListener('abort', onAbort, { once: true })
    poll()
  })
}

/** Reuse the ordinary trusted preparation and execution path for an already persisted trigger marker. */
export function createRuntimeTriggerReceiverStarter(input: {
  prepare(intent: TurnIntent): Promise<{ turnId: string; requestId: string; sessionId: string; startToken: string }>
  dispatch(sender: null, payload: { requestId: string; turnId: string; turnStartToken: string; sessionId: string }): Promise<unknown> | unknown
}) {
  return async (receiver: RuntimeTriggerReceiverStartInput): Promise<'started' | 'busy' | 'unavailable'> => {
    if (!receiver.requestId.startsWith('runtime-trigger:') || !receiver.sessionId || !receiver.messageId) return 'unavailable'
    let prepared: Awaited<ReturnType<typeof input.prepare>>
    try {
      prepared = await input.prepare({ mode: 'reuse-user', requestId: receiver.requestId, sessionId: receiver.sessionId,
        userMessageId: receiver.messageId, excludeMessageIds: [], config: {}, queueScope: receiver.queueScope, queueInputSource: 'runtime-trigger' })
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error)
      if (code === 'SESSION_TURN_BUSY' || code === 'SESSION_CONTEXT_COMPACTION_BUSY' || code === 'SESSION_EXECUTION_ACTIVE' ||
        code === 'SESSION_EXECUTION_ACTIVE_OWNER') return 'busy'
      throw error
    }
    if (prepared.requestId !== receiver.requestId || prepared.sessionId !== receiver.sessionId) return 'unavailable'
    await input.dispatch(null, { requestId: prepared.requestId, turnId: prepared.turnId, turnStartToken: prepared.startToken, sessionId: prepared.sessionId })
    return 'started'
  }
}
