export type HistoryFact = { id: string; sessionId: string; windowId: string; text: string; tokens: number }
export type HistoryReadResult = { entries: HistoryFact[]; nextCursor: string | null }

export function readHistory(facts: readonly HistoryFact[], args: { sessionId: string; windowId?: string; entryId?: string; query?: string; cursor?: string; limit?: number; maxTokens?: number }): HistoryReadResult {
  const scoped = facts.filter((fact) => fact.sessionId === args.sessionId && (!args.windowId || fact.windowId === args.windowId))
  if (args.entryId) {
    const entry = scoped.find((fact) => fact.id === args.entryId)
    if (!entry) throw new Error('History entry not found or not authorized')
    if (args.maxTokens != null && entry.tokens > args.maxTokens) throw new Error('History entry exceeds token budget')
    return { entries: [entry], nextCursor: null }
  }
  const filtered = args.query ? scoped.filter((fact) => fact.text.toLowerCase().includes(args.query!.toLowerCase())) : scoped
  const start = Math.max(0, Number.parseInt(args.cursor ?? '0', 10) || 0)
  const limit = Math.max(1, Math.min(100, args.limit ?? 20))
  const maxTokens = Math.max(0, args.maxTokens ?? 4_000)
  const entries: HistoryFact[] = []
  let used = 0
  for (let i = start; i < filtered.length && entries.length < limit; i++) {
    const fact = filtered[i]!
    if (used + fact.tokens > maxTokens) break
    entries.push(fact)
    used += fact.tokens
  }
  const next = start + entries.length < filtered.length ? String(start + entries.length) : null
  return { entries, nextCursor: next }
}
