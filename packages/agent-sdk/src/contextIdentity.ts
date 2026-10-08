import type { CanonicalModelMessage } from './model'

/** SDK-owned replay identity rules; kept dependency-free from host shared modules. */
function canonicalSurfaceContent(role: unknown, content: unknown): unknown {
  if (role === 'user' && Array.isArray(content)) {
    const hasToolResult = content.some((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_result')
    if (!hasToolResult) return content
    const retained = content.filter((block) => !block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'tool_result')
    if (retained.length > 0 && retained.every((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')) {
      return canonicalPersistedAssistantText(retained.map((block) => (block as { text: string }).text).join(''))
    }
    return retained
  }
  if (role !== 'assistant') return content
  if (typeof content === 'string') return content.length === 0 ? '' : canonicalPersistedAssistantText(content)
  if (!Array.isArray(content)) return content
  const hasToolUse = content.some((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_use')
  const text = content
    .filter((block): block is { type?: unknown; text?: unknown } => Boolean(block) && typeof block === 'object')
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('')
  return hasToolUse ? text : canonicalPersistedAssistantText(text)
}

function canonicalPersistedAssistantText(content: string): string {
  const trimmed = content.trim()
  return trimmed.length > 0 ? trimmed : ' '
}

export function surfaceItemIdentity(value: unknown, fallbackIndex: number): string {
  if (value && typeof value === 'object' && 'role' in value && 'content' in value) {
    const message = value as { role?: unknown; content?: unknown }
    return hashIdentity(JSON.stringify({ role: message.role, content: canonicalSurfaceContent(message.role, message.content) }))
  }
  const explicit = value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined
  if (explicit) return explicit
  return hashIdentity(JSON.stringify(value) ?? `index:${fallbackIndex}`)
}

export function surfaceItemIdentities(values: readonly unknown[]): string[] {
  const counts = new Map<string, number>()
  return values.map((value, index) => {
    const base = surfaceItemIdentity(value, index)
    const occurrence = counts.get(base) ?? 0
    counts.set(base, occurrence + 1)
    return occurrence === 0 ? base : `${base}#${occurrence}`
  })
}

function hashIdentity(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return `surface-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/** Type-level assertion keeps this helper aligned with the SDK's public message shape. */
export type ContextIdentityMessage = CanonicalModelMessage
