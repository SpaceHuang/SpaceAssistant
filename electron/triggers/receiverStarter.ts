import type { QueueScope } from '../../src/shared/queueScope'
import type { TurnIntent } from '../../src/shared/assistantFactAggregator'

export function runtimeTriggerQueueLane(scope: QueueScope): 'desktop' | 'wechat' | 'feishu' {
  return scope.kind === 'im' ? scope.channel : 'desktop'
}

export type RuntimeTriggerReceiverStartInput = Readonly<{ sessionId: string; requestId: string; messageId: string; queueScope: QueueScope }>

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
        userMessageId: receiver.messageId, excludeMessageIds: [], config: {}, queueScope: receiver.queueScope })
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
