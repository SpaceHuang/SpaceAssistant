/** Only replay Anthropic thinking blocks that carry a provider signature. */
export function sanitizeThinkingForReplay<T extends { role: string; content: unknown }>(messages: T[]): T[] {
  return messages.map((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return message
    const content = message.content.filter((block) => {
      if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'thinking') return true
      const signature = (block as { signature?: unknown }).signature
      return typeof signature === 'string' && signature.trim().length > 0
    })
    return content.length === message.content.length ? message : { ...message, content }
  })
}
