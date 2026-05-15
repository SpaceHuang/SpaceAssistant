/**
 * 工具循环 Messages API 流式请求体：固定字段在前、`thinking` 置尾，便于上游前缀/KV 缓存对齐。
 */

export type ToolLoopThinkingConfig = { type: 'adaptive' } | { type: 'disabled' }

export function buildClaudeToolLoopStreamParams(args: {
  model: string
  max_tokens: number
  system?: string
  messages: unknown[]
  tools: unknown[]
  thinking: ToolLoopThinkingConfig
}): Record<string, unknown> {
  const tool_choice = { type: 'auto' as const }
  const thinking = args.thinking
  const hasSystem = typeof args.system === 'string' && args.system.trim().length > 0

  if (hasSystem) {
    return {
      model: args.model,
      max_tokens: args.max_tokens,
      system: args.system,
      messages: args.messages,
      tools: args.tools,
      tool_choice,
      thinking
    }
  }

  return {
    model: args.model,
    max_tokens: args.max_tokens,
    messages: args.messages,
    tools: args.tools,
    tool_choice,
    thinking
  }
}

export function buildClaudeChatSendStreamParams(args: {
  model: string
  max_tokens: number
  messages: unknown[]
  system?: string
  thinking: { type: 'adaptive' }
}): Record<string, unknown> {
  const hasSystem = typeof args.system === 'string' && args.system.trim().length > 0
  if (hasSystem) {
    return {
      model: args.model,
      max_tokens: args.max_tokens,
      system: args.system,
      messages: args.messages,
      thinking: args.thinking
    }
  }
  return {
    model: args.model,
    max_tokens: args.max_tokens,
    messages: args.messages,
    thinking: args.thinking
  }
}

export function buildClaudeNarrativeCompletionParams(args: {
  model: string
  max_tokens: number
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  system?: string
  thinking: ToolLoopThinkingConfig
  temperature?: number
  cache_control?: Record<string, unknown>
}): Record<string, unknown> {
  const thinking = args.thinking
  const hasSystem = typeof args.system === 'string' && args.system.trim().length > 0
  const base: Record<string, unknown> = hasSystem
    ? {
        model: args.model,
        max_tokens: args.max_tokens,
        system: args.system!.trim(),
        messages: args.messages,
        thinking
      }
    : {
        model: args.model,
        max_tokens: args.max_tokens,
        messages: args.messages,
        thinking
      }
  if (args.temperature !== undefined && Number.isFinite(args.temperature)) {
    base.temperature = args.temperature
  }
  if (args.cache_control && typeof args.cache_control === 'object') {
    base.cache_control = args.cache_control
  }
  return base
}
