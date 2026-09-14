import type { ToolCallRecord } from '../../shared/domainTypes'
import { ToolCallDetailsCache } from './toolCallDetailsCache'

export type ToolCallDetailsKey = { sessionId: string; turnId: string; messageId: string; toolCallId: string; revision?: string }
const keyOf = (key: ToolCallDetailsKey): string => `${key.sessionId}\0${key.turnId}\0${key.messageId}\0${key.toolCallId}\0${key.revision ?? ''}`

export class ToolCallDetailsLoader {
  private readonly cache = new ToolCallDetailsCache<ToolCallRecord>({ ttlMs: 5 * 60_000, maxEntries: 32 })
  private readonly inFlight = new Map<string, Promise<ToolCallRecord | undefined>>()
  constructor(private readonly read: (key: ToolCallDetailsKey) => Promise<ToolCallRecord | undefined>) {}
  load(key: ToolCallDetailsKey): Promise<ToolCallRecord | undefined> {
    const cacheKey = keyOf(key)
    const cached = this.cache.get(cacheKey)
    if (cached) return Promise.resolve(cached)
    const pending = this.inFlight.get(cacheKey)
    if (pending) return pending
    const request = this.read(key).then((detail) => {
      if (detail) this.cache.set(cacheKey, detail)
      return detail
    }).finally(() => { this.inFlight.delete(cacheKey) })
    this.inFlight.set(cacheKey, request)
    return request
  }
  clear(): void { this.cache.clear(); this.inFlight.clear() }
}

export const toolCallDetailsLoader = new ToolCallDetailsLoader((key) => window.api.chatGetToolCallDetails(key))
