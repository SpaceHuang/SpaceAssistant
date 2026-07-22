import type { Message } from '../../shared/domainTypes'
import {
  compareDisplayOrder,
  type DisplayMessageEntry
} from '../../shared/displayOrder'

/** 按 sequence ASC 游标加载全会话搜索语料（真实 DisplayOrder）。 */
export async function loadSessionSearchCorpus(
  sessionId: string,
  fetcher: (payload: {
    sessionId: string
    fromSequence?: number
    limit?: number
  }) => Promise<{
    entries: Array<{ message: Message; sequence: number }>
    nextSequence: number
    hasMore: boolean
  }> = (payload) => window.api.chatGetSearchCorpusPage(payload)
): Promise<DisplayMessageEntry[]> {
  const entries: DisplayMessageEntry[] = []
  let fromSequence = 0
  for (;;) {
    const page = await fetcher({ sessionId, fromSequence, limit: 200 })
    for (const row of page.entries) {
      entries.push({
        message: row.message,
        order: { kind: 'persisted', sequence: row.sequence }
      })
    }
    if (!page.hasMore || page.entries.length === 0) break
    fromSequence = page.nextSequence
  }
  return entries
}

/** DB 语料 + live/optimistic 按 id 覆盖；保留真实 DisplayOrder。 */
export function mergeSearchCorpusWithLive(
  dbEntries: DisplayMessageEntry[],
  liveEntries: DisplayMessageEntry[]
): DisplayMessageEntry[] {
  const byId = new Map<string, DisplayMessageEntry>()
  for (const entry of dbEntries) byId.set(entry.message.id, entry)
  for (const entry of liveEntries) byId.set(entry.message.id, entry)
  return [...byId.values()].sort((a, b) => compareDisplayOrder(a.order, b.order))
}

export function displayMessagesToEntries(messages: Message[]): DisplayMessageEntry[] {
  return messages.map((message, index) => {
    // 展示数组在分页路径下通常已是 sequence 序；无 sequence 时用 optimistic 兜底
    return {
      message,
      order: { kind: 'optimistic' as const, ordinal: index }
    }
  })
}
