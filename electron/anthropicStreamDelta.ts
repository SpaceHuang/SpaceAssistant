export type NormalizedDelta =
  | { type: 'block_start'; index: number; blockType: string; id?: string; name?: string }
  | { type: 'block_end'; index: number }
  | { type: 'text_delta'; index: number; text: string }
  | { type: 'reasoning_delta'; index: number; text: string }
  | { type: 'tool_call_delta'; index: number; partialJson: string }
  | { type: 'usage'; usage: unknown }
  | { type: 'finish'; stopReason?: string }

export function normalizeAnthropicEvent(event: unknown, blockTypes: Map<number, string>): NormalizedDelta | undefined {
  if (!event || typeof event !== 'object') return undefined
  const e = event as { type?: string; index?: number; content_block?: { type?: string; id?: string; name?: string }; delta?: Record<string, unknown>; message?: { usage?: unknown }; usage?: unknown; message_delta?: { stop_reason?: string } }
  const index = typeof e.index === 'number' ? e.index : -1
  if (e.type === 'content_block_start' && index >= 0 && typeof e.content_block?.type === 'string') {
    blockTypes.set(index, e.content_block.type)
    return { type: 'block_start', index, blockType: e.content_block.type, ...(e.content_block.id ? { id: e.content_block.id } : {}), ...(e.content_block.name ? { name: e.content_block.name } : {}) }
  }
  if (e.type === 'content_block_stop' && index >= 0) return { type: 'block_end', index }
  if (e.type === 'content_block_delta' && index >= 0 && e.delta) {
    if (e.delta.type === 'input_json_delta' && typeof e.delta.partial_json === 'string') return { type: 'tool_call_delta', index, partialJson: e.delta.partial_json }
    if (e.delta.type === 'thinking_delta' && typeof e.delta.thinking === 'string') return { type: 'reasoning_delta', index, text: e.delta.thinking }
    if (e.delta.type === 'text_delta' && typeof e.delta.text === 'string') return blockTypes.get(index) === 'thinking' ? { type: 'reasoning_delta', index, text: e.delta.text } : { type: 'text_delta', index, text: e.delta.text }
  }
  if (e.type === 'message_start') return { type: 'usage', usage: e.message?.usage }
  if (e.type === 'message_delta') return { type: 'finish', stopReason: e.message_delta?.stop_reason }
  if (e.type === 'message_stop') return { type: 'finish' }
  return undefined
}
