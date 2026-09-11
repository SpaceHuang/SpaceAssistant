export type SurfaceFact = { id: string; role: 'user' | 'assistant' | 'tool'; tokens: number }
export type SurfaceProjection = { status: 'fit' | 'uncompressible_input'; required: SurfaceFact[]; history: SurfaceFact[]; all: SurfaceFact[]; requiredTokens: number; surfaceTokens: number }

export function projectSurface(args: { facts: readonly SurfaceFact[]; currentUserMessageId: string; prefixTokens: number; bodyBudget: number; maxRetainedUserMessages: number; historyTokenRatio?: number }): SurfaceProjection {
  const current = args.facts.filter((fact) => fact.id === args.currentUserMessageId)
  const required = current.length > 0 ? [current[current.length - 1]!] : []
  const requiredTokens = required.reduce((sum, fact) => sum + Math.max(0, fact.tokens), 0)
  if (requiredTokens > args.bodyBudget) return { status: 'uncompressible_input', required, history: [], all: required, requiredTokens, surfaceTokens: args.prefixTokens + requiredTokens }
  const historyBudget = Math.max(0, Math.floor(args.bodyBudget * (args.historyTokenRatio ?? 0.5)))
  const history: SurfaceFact[] = []
  let used = 0
  for (let i = args.facts.length - 1; i >= 0 && history.length < args.maxRetainedUserMessages; i--) {
    const fact = args.facts[i]!
    if (fact.id === args.currentUserMessageId || fact.role !== 'user') continue
    const tokens = Math.max(0, fact.tokens)
    if (used + tokens > historyBudget) continue
    history.unshift(fact)
    used += tokens
  }
  const all = [...history, ...required]
  return { status: 'fit', required, history, all, requiredTokens, surfaceTokens: args.prefixTokens + requiredTokens + used }
}
