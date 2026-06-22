/** 从 assistant 历史消息中移除 thinking / redacted_thinking（仅 thinking 关闭时安全） */
export function stripThinkingBlocksFromAssistantMessages<T extends { role: string; content: unknown }>(
  messages: T[]
): T[] {
  return messages.map((m) => {
    if (m.role !== 'assistant' || typeof m.content === 'string' || !Array.isArray(m.content)) return m
    const filtered = m.content.filter((b: unknown) => {
      if (!b || typeof b !== 'object') return true
      const t = (b as { type?: string }).type
      return t !== 'thinking' && t !== 'redacted_thinking'
    })
    if (filtered.length === 0) {
      return { ...m, content: [{ type: 'text', text: ' ' }] }
    }
    return { ...m, content: filtered }
  })
}
