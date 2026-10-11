import type { HistoryPort } from '../../packages/agent-sdk/src/history'

/**
 * P0-⑤ turn-scoped read memo (plan §5 ⑤). Within one runToolChatSession the same invocation
 * stream is read several times (terminal check, message rebuild, base ownership check) with no
 * writes in between; each underlying read re-parses the full stream. Memoize per invocation id
 * and drop the whole memo on any append so a continued turn can never observe a stale transcript
 * missing the previous round's tool results.
 */
export function createTurnScopedHistoryMemo(history: HistoryPort): HistoryPort {
  let memo = new Map<string, Awaited<ReturnType<HistoryPort['read']>>>()
  return {
    read: async (invocationId) => {
      const hit = memo.get(invocationId)
      if (hit) return hit
      const snapshot = await history.read(invocationId)
      memo.set(invocationId, snapshot)
      return snapshot
    },
    appendBatch: async (events, expectedVersion, transcriptCommit) => {
      const result = await history.appendBatch(events, expectedVersion, transcriptCommit)
      memo = new Map()
      return result
    }
  }
}
