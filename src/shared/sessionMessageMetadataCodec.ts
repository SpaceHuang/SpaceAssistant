import type { Message, ThinkingData } from './domainTypes'

/** Decodes the shared JSON representation used by the messages.thinking SQLite column. */
export function deserializeThinkingFromDb(raw: string | null): ThinkingData | undefined {
  if (!raw) return undefined
  const value = JSON.parse(raw) as ThinkingData & { metadata?: string }
  return {
    ...value,
    metadata: value.metadata && typeof value.metadata === 'string' ? JSON.parse(value.metadata) : value.metadata
  }
}

/** Decodes attachment JSON without depending on Electron's message hydration layer. */
export function deserializeAttachmentsFromDb(raw: string | null | undefined): Message['attachments'] {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as Message['attachments']
    return Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}
