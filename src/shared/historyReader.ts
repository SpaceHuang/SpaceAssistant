export type HistoryFact = { id: string; sessionId: string; windowId: string; text: string; tokens: number; role?: 'user' | 'assistant'; details?: { toolCalls?: unknown[]; toolUse?: unknown; attachments?: unknown[] } }
export type HistoryReadResult = { entries: HistoryFact[]; nextCursor: string | null }
export const HISTORY_READ_MAX_TOKENS = 4_000

export function readHistory(facts: readonly HistoryFact[], args: { sessionId: string; windowId?: string; entryId?: string; query?: string; cursor?: string; limit?: number; maxTokens?: number }): HistoryReadResult {
  const scoped = facts.filter((fact) => fact.sessionId === args.sessionId && (!args.windowId || fact.windowId === args.windowId))
  if (args.entryId) {
    const entry = scoped.find((fact) => fact.id === args.entryId)
    if (!entry) throw new Error('History entry not found or not authorized')
    const entryBudget = Math.min(HISTORY_READ_MAX_TOKENS, Math.max(0, args.maxTokens ?? HISTORY_READ_MAX_TOKENS))
    if (entry.tokens > entryBudget) throw new Error('History entry exceeds token budget')
    return { entries: [entry], nextCursor: null }
  }
  const filtered = args.query ? scoped.filter((fact) => fact.text.toLowerCase().includes(args.query!.toLowerCase())) : scoped
  const start = Math.max(0, Number.parseInt(args.cursor ?? '0', 10) || 0)
  const limit = Math.max(1, Math.min(100, args.limit ?? 20))
  const maxTokens = Math.min(HISTORY_READ_MAX_TOKENS, Math.max(0, args.maxTokens ?? HISTORY_READ_MAX_TOKENS))
  const entries: HistoryFact[] = []
  let used = 0
  let nextIndex = start
  for (let i = start; i < filtered.length && entries.length < limit; i++) {
    const fact = filtered[i]!
    nextIndex = i + 1
    if (fact.tokens > maxTokens && entries.length === 0) continue
    if (used + fact.tokens > maxTokens) {
      nextIndex = i
      break
    }
    entries.push(fact)
    used += fact.tokens
  }
  const next = nextIndex < filtered.length ? String(nextIndex) : null
  return { entries, nextCursor: next }
}
