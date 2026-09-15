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
    const record = error as { status?: unknown; type?: unknown; message?: unknown; error?: { type?: unknown; code?: unknown; message?: unknown } }
    if (record.status === 429) return false
    const type = [record.type, record.error?.type, record.error?.code].filter((value): value is string => typeof value === 'string').join(' ')
    if (/rate[_ -]?limit|quota|too_many_requests/i.test(type)) return false
    if (/context[_ -]?length|prompt[_ -]?too[_ -]?long|input[_ -]?too[_ -]?large/i.test(type)) return true
  }
  const structured = error && typeof error === 'object' ? error as { message?: unknown; error?: { message?: unknown } } : undefined
  const text = error instanceof Error
    ? error.message
    : typeof structured?.message === 'string'
      ? structured.message
      : typeof structured?.error?.message === 'string' ? structured.error.message : String(error)
  if (/rate\s*limit|too many requests|quota|requests?\s+per\s+(minute|second)|tokens?\s+per\s+(minute|second)/i.test(text)) return false
  // 只有明确的输出预算字段才排除；“maximum context length ... tokens”是标准的输入超窗文案，必须保留。
  const hasContextOverflowText = /(?:context|prompt|input).{0,80}(?:length|window|size|limit|exceed|overflow|too\s+long|too\s+large)|(?:length|window|size).{0,80}(?:context|prompt|input)/i.test(text)
  const hasOutputTokenParameter = /\b(?:max[_ -]?tokens?|max(?:imum)?[_ -]?output[_ -]?tokens?|output[_ -]?tokens?)\b/i.test(text)
  if (hasOutputTokenParameter && !hasContextOverflowText) return false
  return /context|prompt|token|window/i.test(text) && /limit|length|exceed|overflow|too large|max/i.test(text)
}

export function decideOverflowRecovery(input: OverflowRecoveryInput): OverflowRecoveryDecision {
  if (!isProviderContextOverflow(input.error)) return { action: 'ignore', reason: 'not_overflow' }
  if (input.retries >= Math.max(0, input.maxRetries)) return { action: 'ignore', reason: 'retry_limit' }
  if (input.inFlightToolCount > 0 || !input.safeBoundary) return { action: 'wait_for_tools', reason: 'in_flight' }
  return { action: 'reset_and_retry_provider', nextRetry: input.retries + 1 }
}

export function selectRecoveryMessages<T extends { role: string; id?: string; content?: unknown }>(messages: readonly T[], currentUserMessageId?: string): T[] {
  // 当前用户消息之后属于本次 invoke；保留它和后续完整工具轮次，丢弃更早的历史工具对。
  // 这样既不会丢掉当前问题依赖的工具结果，也不会把所有历史 tool_result 原样带回超窗重试。
  let currentIndex = currentUserMessageId ? messages.findIndex((message) => message.id === currentUserMessageId) : -1
  if (currentIndex < 0 && !currentUserMessageId) {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!
      if (message.role !== 'user' || !Array.isArray(message.content)) {
        if (message.role === 'user') {
          currentIndex = index
          break
        }
        continue
      }
      if (!message.content.some((block) => Boolean(block && typeof block === 'object' && (block as { type?: string }).type === 'tool_result'))) {
        currentIndex = index
        break
      }
    }
  }
  if (currentIndex >= 0) return messages.slice(currentIndex).map((message, index) => index === 0 ? stripHistoricalToolResults(message) : message)
  if (!messages.length) return []
  return [messages[messages.length - 1]!]
}

function stripHistoricalToolResults<T extends { role: string; content?: unknown }>(message: T): T {
  if (message.role !== 'user' || !Array.isArray(message.content)) return message
  const retained = message.content.filter((block) => !block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'tool_result')
  if (retained.length === message.content.length) return message
  if (retained.length === 0) return { ...message, content: ' ' }
  if (retained.every((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')) {
    return { ...message, content: retained.map((block) => (block as { text: string }).text).join('') }
  }
  return { ...message, content: retained }
}
