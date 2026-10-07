import type { Message } from '../../src/shared/domainTypes'
import type { AppDatabase } from '../database'
import { getTurnContext, iterateRecentTurnRoutingMessageCandidates, type RecentTurnRoutingMessageCandidate } from '../database/operations'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'

/** Select the persisted sequence window independently from the body projection resolver. */
export function selectTurnContext(
  db: AppDatabase,
  sessionId: string,
  boundarySequence: number | undefined,
  requiredUserMessageId: string | undefined,
  excludeMessageIds: readonly string[]
): Message[] {
  return getTurnContext(db, sessionId, boundarySequence, requiredUserMessageId, [...excludeMessageIds])
}

/** Apply route-window eligibility/order after the supplied body resolver has validated each candidate. */
export function selectRecentTurnRoutingMessages(
  db: AppDatabase,
  input: {
    sessionId: string
    limit: number
    boundarySequence?: number
    excludeMessageIds: readonly string[]
    resolveBody(candidate: RecentTurnRoutingMessageCandidate): string
  }
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (input.limit === 0) return []
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const selectedDescending: Array<{ role: 'user' | 'assistant'; content: string }> = []
    for (const candidate of iterateRecentTurnRoutingMessageCandidates(db, input.sessionId, input.boundarySequence, [...input.excludeMessageIds])) {
      const content = input.resolveBody(candidate)
      if (!content.trim()) continue
      selectedDescending.push({ role: candidate.message.role as 'user' | 'assistant', content })
      if (input.limit > 0 && selectedDescending.length >= input.limit) break
    }
    return selectedDescending.reverse()
  })
}
