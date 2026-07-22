import type { Message } from '../../shared/domainTypes'
import { compareDisplayOrder, type DisplayMessageEntry, type DisplayOrder } from '../../shared/displayOrder'

export function compareDisplayMessageEntry(a: DisplayMessageEntry, b: DisplayMessageEntry): number {
  return compareDisplayOrder(a.order, b.order)
}

/**
 * 合并当前展示条目与 incoming DB 页。
 * incoming 按 sequence ASC；已存在 id 以 DB message 为基线再叠 livePatchById。
 */
export function mergeDisplayEntries(
  current: DisplayMessageEntry[],
  incomingPage: Array<{ message: Message; sequence: number }>,
  livePatchById?: Map<string, Partial<Message>>
): DisplayMessageEntry[] {
  const byId = new Map<string, DisplayMessageEntry>()
  for (const entry of current) {
    byId.set(entry.message.id, entry)
  }
  for (const row of incomingPage) {
    const live = livePatchById?.get(row.message.id)
    const message = live ? ({ ...row.message, ...live, id: row.message.id } as Message) : row.message
    byId.set(row.message.id, {
      message,
      order: { kind: 'persisted', sequence: row.sequence }
    })
  }
  return [...byId.values()].sort(compareDisplayMessageEntry)
}

export function ackDisplayEntryPersisted(
  entries: DisplayMessageEntry[],
  messageId: string,
  sequence: number
): DisplayMessageEntry[] {
  const next = entries.map((entry) =>
    entry.message.id === messageId
      ? { ...entry, order: { kind: 'persisted' as const, sequence } }
      : entry
  )
  return next.sort(compareDisplayMessageEntry)
}

export function patchDisplayEntryMessage(
  entries: DisplayMessageEntry[],
  messageId: string,
  patch: Partial<Message>
): DisplayMessageEntry[] {
  return entries.map((entry) =>
    entry.message.id === messageId
      ? { ...entry, message: { ...entry.message, ...patch, id: messageId } }
      : entry
  )
}

export function appendOptimisticDisplayEntry(
  entries: DisplayMessageEntry[],
  message: Message,
  ordinal: number
): DisplayMessageEntry[] {
  const without = entries.filter((e) => e.message.id !== message.id)
  const next: DisplayMessageEntry[] = [
    ...without,
    { message, order: { kind: 'optimistic', ordinal } }
  ]
  return next.sort(compareDisplayMessageEntry)
}

export type { DisplayOrder, DisplayMessageEntry }
