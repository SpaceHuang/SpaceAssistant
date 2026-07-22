import type { Message } from '../../shared/domainTypes'
import {
  assertValidPersistedSequence,
  compareDisplayOrder,
  type DisplayOrder
} from '../../shared/displayOrder'
import {
  estimateThinkingTokensFromMessage,
  estimateTokensFromHistoryImages
} from '../../shared/contextUsageEstimate'

export type ContextSummaryValue = {
  messageId: string
  role: Message['role']
  imageTokens: number
  thinkingTokens: number
}

export type ContextHistoryDbRow = ContextSummaryValue & {
  sequence: number
}

export type ContextSummaryEntry = ContextSummaryValue & {
  order: DisplayOrder
}

export type PersistedContextSummaryEntry = ContextSummaryValue & {
  order: Extract<DisplayOrder, { kind: 'persisted' }>
}

export function toPersistedContextSummaryEntry(row: ContextHistoryDbRow): PersistedContextSummaryEntry {
  assertValidPersistedSequence(row.sequence)
  const { sequence, ...value } = row
  return { ...value, order: { kind: 'persisted', sequence } }
}

export function summarizeContextMessage(message: Message, order: DisplayOrder): ContextSummaryEntry {
  const imageTokens = estimateTokensFromHistoryImages([message])
  const thinkingTokens = estimateThinkingTokensFromMessage(message.thinking)
  return {
    messageId: message.id,
    role: message.role,
    imageTokens,
    thinkingTokens,
    order
  }
}

type ContextHistorySummaryState = {
  sessionId: string
  generation: number
  baseById: Map<string, PersistedContextSummaryEntry>
  overrideById: Map<string, ContextSummaryEntry>
}

const stateBySession = new Map<string, ContextHistorySummaryState>()

export function resetContextHistorySummaryForTest(): void {
  stateBySession.clear()
}

function ensure(sessionId: string): ContextHistorySummaryState {
  let s = stateBySession.get(sessionId)
  if (!s) {
    s = {
      sessionId,
      generation: 1,
      baseById: new Map(),
      overrideById: new Map()
    }
    stateBySession.set(sessionId, s)
  }
  return s
}

export function beginContextSummarySession(sessionId: string): number {
  const s = ensure(sessionId)
  s.generation += 1
  s.baseById.clear()
  s.overrideById.clear()
  return s.generation
}

export function applyContextSummaryDbBaseline(
  sessionId: string,
  generation: number,
  rows: ContextHistoryDbRow[]
): void {
  const s = stateBySession.get(sessionId)
  if (!s || s.generation !== generation) return
  try {
    const next = new Map<string, PersistedContextSummaryEntry>()
    for (const row of rows) {
      const entry = toPersistedContextSummaryEntry(row)
      next.set(entry.messageId, entry)
    }
    s.baseById = next
    for (const [id, over] of [...s.overrideById]) {
      if (over.order.kind === 'persisted' && next.has(id)) {
        // baseline 已覆盖且无 pending 时清理；首版简化：persisted override 若与 baseline 同 id 则删除 override
        s.overrideById.delete(id)
      }
    }
  } catch {
    // 非法 sequence：保留旧状态
  }
}

export function upsertContextSummaryOverride(sessionId: string, entry: ContextSummaryEntry): void {
  const s = ensure(sessionId)
  s.overrideById.set(entry.messageId, entry)
}

export function ackContextSummaryPersisted(sessionId: string, messageId: string, sequence: number): void {
  const s = stateBySession.get(sessionId)
  if (!s) return
  const existing = s.overrideById.get(messageId)
  if (!existing) {
    throw new Error(`ackContextSummaryPersisted: missing override ${messageId}`)
  }
  assertValidPersistedSequence(sequence)
  s.overrideById.set(messageId, {
    ...existing,
    order: { kind: 'persisted', sequence }
  })
}

export function mergeContextSummaryEntries(sessionId: string): ContextSummaryEntry[] {
  const s = stateBySession.get(sessionId)
  if (!s) return []
  const byId = new Map<string, ContextSummaryEntry>()
  for (const e of s.baseById.values()) byId.set(e.messageId, e)
  for (const e of s.overrideById.values()) byId.set(e.messageId, e)
  return [...byId.values()].sort((a, b) => compareDisplayOrder(a.order, b.order))
}

export function selectContextSummaryScalars(sessionId: string): {
  historyImageTokens: number
  thinkingTokensToExclude: number
} {
  const entries = mergeContextSummaryEntries(sessionId)
  const historyImageTokens = entries.reduce((sum, e) => sum + e.imageTokens, 0)
  let thinkingTokensToExclude = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.role === 'assistant' && e.thinkingTokens > 0) {
      thinkingTokensToExclude = e.thinkingTokens
      break
    }
  }
  return { historyImageTokens, thinkingTokensToExclude }
}
