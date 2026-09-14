import { estimateTokensFromUtf8Text } from './contextUsageEstimate'

export type HistoryFact = { id: string; sessionId: string; windowId: string; text: string; tokens: number; role?: 'user' | 'assistant'; details?: { toolCalls?: unknown[]; toolUse?: unknown; attachments?: unknown[] } }
export type HistoryReadResult = { entries: HistoryFact[]; nextCursor: string | null }
export const HISTORY_READ_MAX_TOKENS = 4_000
const HISTORY_RESPONSE_OVERHEAD_TOKENS = 32
const HISTORY_DETAIL_STRING_MAX_CHARS = 2_000
const HISTORY_DETAIL_ARRAY_MAX_ITEMS = 32
const HISTORY_DETAIL_OBJECT_MAX_KEYS = 64
const HISTORY_DETAIL_MAX_DEPTH = 6

function sanitizeHistoryDetail(value: unknown, key: string | undefined, depth: number): unknown {
  if (depth > HISTORY_DETAIL_MAX_DEPTH) return '[history details truncated]'
  if (typeof value === 'string') {
    if (key?.toLowerCase() === 'data') return `[binary data omitted; originalLength=${value.length}]`
    return value.length > HISTORY_DETAIL_STRING_MAX_CHARS ? `${value.slice(0, HISTORY_DETAIL_STRING_MAX_CHARS - 1)}…` : value
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, HISTORY_DETAIL_ARRAY_MAX_ITEMS).map((item) => sanitizeHistoryDetail(item, key, depth + 1))
    return value.length > HISTORY_DETAIL_ARRAY_MAX_ITEMS ? [...items, `[${value.length - HISTORY_DETAIL_ARRAY_MAX_ITEMS} more items omitted]`] : items
  }
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  const entries = Object.entries(value)
  for (const [entryKey, entryValue] of entries.slice(0, HISTORY_DETAIL_OBJECT_MAX_KEYS)) {
    output[entryKey] = sanitizeHistoryDetail(entryValue, entryKey, depth + 1)
  }
  if (entries.length > HISTORY_DETAIL_OBJECT_MAX_KEYS) output._truncatedKeys = `[${entries.length - HISTORY_DETAIL_OBJECT_MAX_KEYS} more keys omitted]`
  return output
}

function sanitizeHistoryFact(fact: HistoryFact): HistoryFact {
  if (!fact.details) return fact
  return { ...fact, details: sanitizeHistoryDetail(fact.details, 'details', 0) as HistoryFact['details'] }
}

function historyFactOutputTokens(fact: HistoryFact): number {
  return estimateTokensFromUtf8Text(JSON.stringify(fact) ?? '')
}

/** 限制完整返回对象，而不是只限制 fact.text 的影子 token 计数。 */
function fitHistoryFact(fact: HistoryFact, budget: number): HistoryFact | null {
  const sanitized = sanitizeHistoryFact(fact)
  if (historyFactOutputTokens(sanitized) <= budget) return sanitized
  // 详情仅用于恢复辅助信息；详情过大时降级为正文，绝不让附件阻塞正文读取。
  const withoutDetails = { ...sanitized }
  delete withoutDetails.details
  return historyFactOutputTokens(withoutDetails) <= budget ? withoutDetails : null
}

export function readHistory(facts: readonly HistoryFact[], args: { sessionId: string; windowId?: string; entryId?: string; query?: string; cursor?: string; limit?: number; maxTokens?: number }): HistoryReadResult {
  const scoped = facts.filter((fact) => fact.sessionId === args.sessionId && (!args.windowId || fact.windowId === args.windowId))
  if (args.entryId) {
    const entry = scoped.find((fact) => fact.id === args.entryId)
    if (!entry) throw new Error('History entry not found or not authorized')
    const entryBudget = Math.max(0, Math.min(HISTORY_READ_MAX_TOKENS, Math.max(0, args.maxTokens ?? HISTORY_READ_MAX_TOKENS)) - HISTORY_RESPONSE_OVERHEAD_TOKENS)
    if (entry.tokens > entryBudget) throw new Error('History entry exceeds token budget')
    const boundedEntry = fitHistoryFact(entry, entryBudget)
    if (!boundedEntry) throw new Error('History entry exceeds token budget')
    return { entries: [boundedEntry], nextCursor: null }
  }
  const filtered = args.query ? scoped.filter((fact) => fact.text.toLowerCase().includes(args.query!.toLowerCase())) : scoped
  const start = Math.max(0, Number.parseInt(args.cursor ?? '0', 10) || 0)
  const limit = Math.max(1, Math.min(100, args.limit ?? 20))
  const maxTokens = Math.min(HISTORY_READ_MAX_TOKENS, Math.max(0, args.maxTokens ?? HISTORY_READ_MAX_TOKENS))
  const outputBudget = Math.max(0, maxTokens - HISTORY_RESPONSE_OVERHEAD_TOKENS)
  const entries: HistoryFact[] = []
  let used = 0
  let nextIndex = start
  for (let i = start; i < filtered.length && entries.length < limit; i++) {
    const fact = filtered[i]!
    nextIndex = i + 1
    if (fact.tokens > maxTokens && entries.length === 0) continue
    const boundedFact = fitHistoryFact(fact, outputBudget)
    if (!boundedFact) continue
    const factTokens = historyFactOutputTokens(boundedFact)
    if (used + factTokens > outputBudget) {
      nextIndex = i
      break
    }
    entries.push(boundedFact)
    used += factTokens
  }
  const next = nextIndex < filtered.length ? String(nextIndex) : null
  return { entries, nextCursor: next }
}
