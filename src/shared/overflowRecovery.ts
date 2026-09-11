export type OverflowRecoveryInput = {
  error: unknown
  retries: number
  maxRetries: number
  inFlightToolCount: number
  safeBoundary: boolean
}
export type OverflowRecoveryDecision =
  | { action: 'ignore'; reason: 'not_overflow' | 'retry_limit' }
  | { action: 'wait_for_tools'; reason: 'in_flight' }
  | { action: 'reset_and_retry_provider'; nextRetry: number }

export function isProviderContextOverflow(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return /context|prompt|token|window/i.test(text) && /limit|length|exceed|overflow|too large|max/i.test(text)
}

export function decideOverflowRecovery(input: OverflowRecoveryInput): OverflowRecoveryDecision {
  if (!isProviderContextOverflow(input.error)) return { action: 'ignore', reason: 'not_overflow' }
  if (input.retries >= Math.max(0, input.maxRetries)) return { action: 'ignore', reason: 'retry_limit' }
  if (input.inFlightToolCount > 0 || !input.safeBoundary) return { action: 'wait_for_tools', reason: 'in_flight' }
  return { action: 'reset_and_retry_provider', nextRetry: input.retries + 1 }
}
