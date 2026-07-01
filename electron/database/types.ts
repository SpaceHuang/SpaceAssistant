import type { SessionUsage } from '../../src/shared/sessionUsage'

export type StoredMessage = {
  id: string
  sessionId: string
  role: string
  content: string
  toolUse: string | null
  toolCalls: string | null
  thinking: string | null
  contentSegments?: string | null
  skillHints?: string | null
  attachments?: string | null
  imagesDeliveredToApi?: boolean | null
  status: string
  schemaVersion: number
  timestamp: number
  sequence: number
}

export type DbSnapshot = {
  sessions: import('../../src/shared/domainTypes').Session[]
  messages: StoredMessage[]
  configs: Record<string, { value: string; createdAt: number; updatedAt: number }>
  searchHistory: Array<{ id: string; query: string; timestamp: number }>
  sessionUsages?: Record<string, SessionUsage>
}
