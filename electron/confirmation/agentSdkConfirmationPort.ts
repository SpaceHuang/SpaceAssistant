import { randomUUID } from 'node:crypto'
import type { ConfirmationPort, ToolConfirmationResult } from '../../packages/agent-sdk/src/turn'
import type { ConfirmOutcome, ConfirmRequest, ConfirmationChannel } from '../../src/shared/confirmation/types'

export type GateConfirmationContext = Readonly<{
  facts: ConfirmRequest['facts']
  decision: Pick<ConfirmRequest, 'riskLevel' | 'memoryTiers' | 'timeoutMs'> & { answerer?: 'user' | 'agent' }
  [key: string]: unknown
}>

function isGateContext(value: unknown): value is GateConfirmationContext {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<GateConfirmationContext>
  return !!candidate.facts && !!candidate.decision && typeof candidate.decision === 'object'
    && Array.isArray(candidate.decision.memoryTiers)
    && (candidate.decision.riskLevel === 'low' || candidate.decision.riskLevel === 'medium' || candidate.decision.riskLevel === 'high')
    && (candidate.decision.timeoutMs === null || typeof candidate.decision.timeoutMs === 'number')
}

export function mapAgentSdkConfirmationOutcome(outcome: ConfirmOutcome, requestedAnswerer: 'user' | 'agent'): Awaited<ReturnType<ConfirmationPort>> {
  const answererKind = outcome.kind === 'approved-with-action' ? 'user' : outcome.answererKind
  const answerer = answererKind === 'deny' ? undefined
    : answererKind ?? (outcome.cause.startsWith('user-') ? 'user' : outcome.cause.startsWith('agent-') ? 'agent' : requestedAnswerer)
  const attribution = { ...(answerer ? { answerer } : {}), cause: outcome.cause }
  const reason = 'reason' in outcome && outcome.reason && typeof outcome.reason.summary === 'string' && outcome.reason.summary.trim()
    ? { userMessage: outcome.reason.summary.trim() }
    : {}
  if (outcome.kind === 'approved' && (outcome.cause === 'user-approved' || outcome.cause === 'agent-approved')) {
    return {
      kind: 'approved', receipt: `confirmation:${randomUUID()}`, ...attribution, ...reason,
      ...(outcome.memory ? { selectedMemory: outcome.memory } : {})
    }
  }
  if (outcome.kind === 'timeout') return { kind: 'timeout', ...attribution, ...reason }
  if (outcome.cause === 'cancelled') return { kind: 'cancelled', ...attribution, ...reason }
  if (outcome.cause === 'unavailable' || outcome.cause === 'config-error' || outcome.cause === 'no-answerer') return { kind: 'unavailable', ...attribution, ...reason }
  return { kind: 'denied', ...attribution, ...reason }
}

/** Bridges the SDK confirmation decision to the existing host channel and its waiter lifecycle. */
export function createAgentSdkConfirmationPort(input: {
  createChannel(call: Parameters<ConfirmationPort>[0]['call'], confirmation: Pick<Parameters<ConfirmationPort>[0], 'confirmationId' | 'answerer' | 'reasonCode' | 'context'>): ConfirmationChannel
  publish(call: Parameters<ConfirmationPort>[0]['call'], request: ConfirmRequest, confirmationId: string, context: GateConfirmationContext): void | Promise<void>
  cancel(call: Parameters<ConfirmationPort>[0]['call'], confirmationId: string): void
  onApproved?(
    call: Parameters<ConfirmationPort>[0]['call'],
    outcome: Awaited<ReturnType<ConfirmationPort>>,
    confirmation: Parameters<ConfirmationPort>[0],
    context: GateConfirmationContext,
    selectedMemory?: unknown
  ): void
  defer?(
    call: Parameters<ConfirmationPort>[0]['call'],
    outcome: ToolConfirmationResult,
    confirmation: Parameters<ConfirmationPort>[0],
    context: GateConfirmationContext,
    primaryOutcome: ConfirmOutcome
  ): Promise<Extract<ToolConfirmationResult, { kind: 'deferred' }> | undefined>
  fallback?(
    call: Parameters<ConfirmationPort>[0]['call'],
    confirmation: Parameters<ConfirmationPort>[0],
    context: GateConfirmationContext,
    primaryOutcome: ConfirmOutcome
  ): Promise<Awaited<ReturnType<ConfirmationPort>> | undefined>
}): ConfirmationPort {
  const explicitDenials = new Map<string, Readonly<{ userMessage?: string }>>()
  return async (confirmation) => {
    if (!isGateContext(confirmation.context)) return { kind: 'unavailable', cause: 'unavailable' }
    const target = confirmation.context.writePathFact && typeof confirmation.context.writePathFact === 'object'
      ? (confirmation.context.writePathFact as { normalizedPath?: unknown }).normalizedPath
      : undefined
    const normalizedTarget = typeof target === 'string' ? target : undefined
    if (normalizedTarget) {
      const key = JSON.stringify([confirmation.modelTurn, confirmation.call.toolName, normalizedTarget])
      const previous = explicitDenials.get(key)
      if (previous) return {
        kind: 'denied', cause: 'user-denied', answerer: 'user',
        userMessage: previous.userMessage ?? '同批同目标的同类调用已由用户拒绝。'
      }
    }
    const request: ConfirmRequest = {
      facts: confirmation.context.facts,
      ...confirmation.context.decision
    }
    const channel = input.createChannel(confirmation.call, confirmation)
    const cancel = () => {
      input.cancel(confirmation.call, confirmation.confirmationId)
      channel.cancel(confirmation.confirmationId, 'cancelled')
    }
    if (confirmation.signal?.aborted) {
      cancel()
      return { kind: 'cancelled', cause: 'cancelled' }
    }

    let abort: (() => void) | undefined
    const aborted = new Promise<Awaited<ReturnType<ConfirmationPort>>>((resolve) => {
      abort = () => { cancel(); resolve({ kind: 'cancelled', cause: 'cancelled' }) }
      confirmation.signal?.addEventListener('abort', abort, { once: true })
    })
    try {
      // request() synchronously registers the existing channel waiter before its first await.
      const response = channel.request(request).then(
        (outcome) => ({ outcome, mapped: mapAgentSdkConfirmationOutcome(outcome, confirmation.answerer) }),
        () => ({ outcome: { kind: 'rejected', cause: 'unavailable' } as ConfirmOutcome, mapped: { kind: 'unavailable' as const, cause: 'unavailable' } })
      )
      if (confirmation.signal?.aborted) {
        cancel()
        return { kind: 'cancelled', cause: 'cancelled' }
      }
      try {
        await input.publish(confirmation.call, request, confirmation.confirmationId, confirmation.context as GateConfirmationContext)
      } catch {
        cancel()
        return { kind: 'unavailable', cause: 'unavailable' }
      }
      const result = await Promise.race([response, aborted.then((mapped) => ({ mapped }))])
      let outcome = result.mapped
      if ('outcome' in result && confirmation.answerer === 'agent' &&
        result.outcome.kind !== 'approved-with-action' &&
        (result.outcome.cause === 'unavailable' || result.outcome.cause === 'timeout') &&
        result.outcome.answererKind === 'agent' && !confirmation.signal?.aborted && input.fallback) {
        outcome = await input.fallback(confirmation.call, confirmation, confirmation.context as GateConfirmationContext, result.outcome) ?? outcome
      }
      if (outcome.kind === 'approved' && outcome.answerer === 'agent' && confirmation.context.facts.actionClass === 'outbound') {
        outcome = { kind: 'denied', answerer: 'agent', cause: 'rules-violated', userMessage: '外发动作必须由真人逐次确认。' }
      }
      if ('outcome' in result && (outcome as { answerer?: unknown }).answerer === 'agent' &&
        !confirmation.signal?.aborted && input.defer) {
        const deferred = await input.defer(confirmation.call, outcome, confirmation,
          confirmation.context as GateConfirmationContext, result.outcome)
        if (deferred) return deferred
      }
      if (outcome.kind === 'approved') input.onApproved?.(confirmation.call, outcome, confirmation, confirmation.context as GateConfirmationContext, outcome.selectedMemory)
      if (outcome.kind === 'denied' && outcome.answerer === 'user' && normalizedTarget) {
        explicitDenials.set(JSON.stringify([confirmation.modelTurn, confirmation.call.toolName, normalizedTarget]), {
          ...(outcome.userMessage ? { userMessage: outcome.userMessage } : {})
        })
      }
      return outcome
    } finally {
      if (abort) confirmation.signal?.removeEventListener('abort', abort)
    }
  }
}
