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
  if (error && typeof error === 'object') {
    const record = error as { status?: unknown; type?: unknown; error?: { type?: unknown; code?: unknown } }
    if (record.status === 429) return false
    const type = [record.type, record.error?.type, record.error?.code].filter((value): value is string => typeof value === 'string').join(' ')
    if (/rate[_ -]?limit|quota|too_many_requests/i.test(type)) return false
    if (/context[_ -]?length|prompt[_ -]?too[_ -]?long|input[_ -]?too[_ -]?large/i.test(type)) return true
  }
  const text = error instanceof Error ? error.message : String(error)
  if (/rate\s*limit|too many requests|quota|requests?\s+per\s+(minute|second)|tokens?\s+per\s+(minute|second)/i.test(text)) return false
  return /context|prompt|token|window/i.test(text) && /limit|length|exceed|overflow|too large|max/i.test(text)
}

export function decideOverflowRecovery(input: OverflowRecoveryInput): OverflowRecoveryDecision {
  if (!isProviderContextOverflow(input.error)) return { action: 'ignore', reason: 'not_overflow' }
  if (input.retries >= Math.max(0, input.maxRetries)) return { action: 'ignore', reason: 'retry_limit' }
  if (input.inFlightToolCount > 0 || !input.safeBoundary) return { action: 'wait_for_tools', reason: 'in_flight' }
  return { action: 'reset_and_retry_provider', nextRetry: input.retries + 1 }
}

export function selectRecoveryMessages<T extends { role: string; id?: string; content?: unknown }>(messages: readonly T[], currentUserMessageId?: string): T[] {
  const retained = new Set<T>()
  const toolResultMessages = messages.filter((message) => message.role === 'user' && Array.isArray(message.content) && message.content.some((block) => Boolean(block && typeof block === 'object' && (block as { type?: string }).type === 'tool_result')))
  for (const result of toolResultMessages) {
    const ids = new Set((result.content as Array<{ tool_use_id?: unknown }>).map((block) => block.tool_use_id))
    for (const message of messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
      if (message.content.some((block) => Boolean(block && typeof block === 'object' && (block as { type?: string; id?: unknown }).type === 'tool_use' && ids.has((block as { id?: unknown }).id)))) retained.add(message)
    }
    retained.add(result)
  }
  const current = currentUserMessageId ? messages.find((message) => message.id === currentUserMessageId) : undefined
  if (current) retained.add(current)
  const result = messages.filter((message) => retained.has(message))
  if (!result.length && messages.length) result.push(messages[messages.length - 1]!)
  return result
}
