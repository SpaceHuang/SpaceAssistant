import type { Message } from './domainTypes'

export type DisplayOrder =
  | { kind: 'persisted'; sequence: number }
  | { kind: 'optimistic'; ordinal: number }

export type DisplayMessageEntry = {
  message: Message
  order: DisplayOrder
}

export type ApiContextEntry = {
  message: Message
  order: DisplayOrder
}

export type PersistedMessageAck = {
  messageId: string
  sequence: number
}

export type ApiContextBaseline = {
  sessionId: string
  entries: Array<{
    message: Message
    sequence: number
  }>
}

export type ChatMessagePage = {
  entries: Array<{
    message: Message
    sequence: number
  }>
  oldestSequence: number | null
  hasMoreBefore: boolean
}

export type QueuedMessageEntry = {
  message: Message
  sequence: number
}

export type RetryContextTarget = {
  failedAssistant: { message: Message; sequence: number }
  currentUser: { message: Message; sequence: number }
}

export type ApiContextRequest = {
  sessionId: string
  requiredCurrentUser: ApiContextEntry
  excludeMessageIds?: string[]
}

/** persisted 按 sequence；optimistic 全部在 persisted 之后，按 ordinal。 */
export function compareDisplayOrder(a: DisplayOrder, b: DisplayOrder): number {
  if (a.kind === 'persisted' && b.kind === 'persisted') {
    return a.sequence - b.sequence
  }
  if (a.kind === 'optimistic' && b.kind === 'optimistic') {
    return a.ordinal - b.ordinal
  }
  if (a.kind === 'persisted') return -1
  return 1
}

export function assertValidPersistedSequence(sequence: number): void {
  if (!Number.isFinite(sequence) || sequence < 0 || !Number.isInteger(sequence)) {
    throw new Error(`invalid persisted sequence: ${String(sequence)}`)
  }
}
