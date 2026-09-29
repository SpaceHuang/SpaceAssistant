import type { CanonicalTurnMessage } from '../../packages/agent-sdk/src/turn'
import type { UsageTurnOutcome } from '../usageStats/usageStatsRecorder'
import { mergeHostedTurnUsageSummary, type HostedTurnUsageCounts } from './hostedTurnUsageSummary'

export type HostedTurnUsageCheckpoint = Readonly<{
  modelTurns: number
  initialMessageCount: number
  messages: readonly CanonicalTurnMessage[]
  notDispatchedToolCallIds?: readonly string[]
}>

export type HostedTurnFinalization = Readonly<{
  outcome: UsageTurnOutcome
  usage?: HostedTurnUsageCheckpoint
}>

export type HostedFailureUsage = Readonly<{
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}>

export function hostedTerminalSessionEventReason(outcome: UsageTurnOutcome): 'completed' | 'failed' | 'cancelled' | 'interrupted' {
  if (outcome === 'completed' || outcome === 'cancelled' || outcome === 'interrupted') return outcome
  return 'failed'
}

const finalizations = new WeakMap<object, HostedTurnFinalization>()

export function markHostedTurnFinalization<T extends object>(result: T, finalization: HostedTurnFinalization): T {
  if (finalizations.has(result)) throw new Error('HOSTED_TURN_ALREADY_FINALIZED')
  finalizations.set(result, finalization)
  return result
}

export function getHostedTurnFinalization(result: object): HostedTurnFinalization | undefined {
  return finalizations.get(result)
}

export async function finalizeInvocationResult(input: {
  result: { ok: boolean; cancelled?: boolean }
  counts: HostedTurnUsageCounts
  appendLegacyTerminal(): Promise<void>
  onSummaryError?(error: unknown): void
}): Promise<{ outcome: UsageTurnOutcome; terminalCommittedBy: 'legacy' | 'hosted' }> {
  const finalization = getHostedTurnFinalization(input.result)
  if (!finalization) {
    await input.appendLegacyTerminal()
    return { outcome: input.result.ok ? 'completed' : input.result.cancelled ? 'cancelled' : 'failed', terminalCommittedBy: 'legacy' }
  }
  if (finalization.usage) {
    try { mergeHostedTurnUsageSummary(input.counts, finalization.usage) }
    catch (error) { input.onSummaryError?.(error) }
  }
  return { outcome: finalization.outcome, terminalCommittedBy: 'hosted' }
}

export class HostedTurnFinalizedError extends Error {
  readonly historyTerminalCommitted = true
  constructor(
    readonly cause: unknown,
    readonly outcome: Exclude<UsageTurnOutcome, 'completed' | 'recovered' | 'timed-out'>,
    readonly usage?: HostedFailureUsage
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'HostedTurnFinalizedError'
  }
}
