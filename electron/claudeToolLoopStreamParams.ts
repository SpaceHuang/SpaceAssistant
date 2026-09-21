/**
 * 工具循环 Messages API 流式请求体：固定字段在前、`thinking` 置尾，便于上游前缀/KV 缓存对齐。
 * 档位扩展（需求 §7.3）：`output_config`（承载 effort）插在 `tool_choice` 之后、`thinking` 之前。
 */

import type { AgentReasoningEffort } from '../src/shared/agent/invocation'

export type ToolLoopThinkingConfig = { type: 'adaptive' } | { type: 'disabled' }
/** 目前仅承载 effort；后续若出现其他 output_config 用途（如 structured outputs），在此合并而非覆盖。 */
export type ToolLoopOutputConfig = { effort: AgentReasoningEffort }

/** provider 边界 DTO：内部 surface 元数据不得穿过此函数。 */
export function serializeProviderMessages(messages: unknown[]): Array<{ role: unknown; content: unknown }> {
  return messages.map((message) => {
    const source = message && typeof message === 'object' ? message as { role?: unknown; content?: unknown } : {}
    return { role: source.role, content: source.content }
  })
}

/**
 * P0-1 wire 面埋点（agent-context-token-cost-optimization-plan §5.2.3-2）：
 * 按 buildClaudeToolLoopStreamParams 的注入规则推导本次请求的 cache_control 断点位置
 * （'system' 或 'msg:<index>'）。必须与本文件的注入逻辑保持同源，注入规则变化时观测不漂移。
 */
export function computeCacheBreakpointPositions(args: { messages: readonly unknown[]; hasSystem: boolean; cacheControl: boolean }): string[] {
  const positions: string[] = []
  // 与 buildClaudeToolLoopStreamParams 同源：system 断点受 cacheControl 开关，消息级断点只要末条是字符串就注入
  if (args.cacheControl && args.hasSystem) positions.push('system')
  const last = args.messages.length > 0 ? args.messages[args.messages.length - 1] : undefined
  const tailIsString = typeof (last as { content?: unknown } | undefined)?.content === 'string'
  if (tailIsString) positions.push(`msg:${args.messages.length - 1}`)
  return positions
}

export function buildClaudeToolLoopStreamParams(args: {
  model: string
  max_tokens: number
  system?: string
  messages: unknown[]
  tools: unknown[]
  thinking: ToolLoopThinkingConfig
  outputConfig?: ToolLoopOutputConfig
  cacheControl?: boolean
}): Record<string, unknown> {
  const tool_choice = { type: 'auto' as const }
  const thinking = args.thinking
  const output_config = args.outputConfig ? { effort: args.outputConfig.effort } : undefined
  const hasSystem = typeof args.system === 'string' && args.system.trim().length > 0
  const cacheControl = { type: 'ephemeral' as const }
  const messages = serializeProviderMessages(args.messages).map((message, index) => {
    const content = index === args.messages.length - 1 && typeof message.content === 'string'
      ? [{ type: 'text', text: message.content, cache_control: cacheControl }]
      : message.content
    return { role: message.role, content }
  })
  const system = args.cacheControl && hasSystem ? [{ type: 'text', text: args.system!.trim(), cache_control: cacheControl }] : args.system

  if (hasSystem) {
    return {
      model: args.model,
      max_tokens: args.max_tokens,
      system,
      messages,
      tools: args.tools,
      tool_choice,
      ...(output_config ? { output_config } : {}),
      thinking
    }
  }

  return {
    model: args.model,
    max_tokens: args.max_tokens,
    messages,
    tools: args.tools,
    tool_choice,
    ...(output_config ? { output_config } : {}),
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
  const messages = serializeProviderMessages(args.messages)
  if (hasSystem) {
    return {
      model: args.model,
      max_tokens: args.max_tokens,
      system: args.system,
      messages,
      thinking: args.thinking
    }
  }
  return {
    model: args.model,
    max_tokens: args.max_tokens,
    messages,
    thinking: args.thinking
  }
}

/**
 * 叙述补全参数构建（评审 C4：当前生产代码无调用方，属预备代码——与 buildClaudeToolLoopStreamParams
 * 保持 outputConfig 映射同构，供后续非工具循环链路复用）。
 */
export function buildClaudeNarrativeCompletionParams(args: {
  model: string
  max_tokens: number
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  system?: string
  thinking: ToolLoopThinkingConfig
  outputConfig?: ToolLoopOutputConfig
  temperature?: number
  cache_control?: Record<string, unknown>
}): Record<string, unknown> {
  const thinking = args.thinking
  const output_config = args.outputConfig ? { effort: args.outputConfig.effort } : undefined
  const hasSystem = typeof args.system === 'string' && args.system.trim().length > 0
  const messages = serializeProviderMessages(args.messages)
  const base: Record<string, unknown> = hasSystem
    ? {
        model: args.model,
        max_tokens: args.max_tokens,
        system: args.system!.trim(),
      messages,
        ...(output_config ? { output_config } : {}),
        thinking
      }
    : {
        model: args.model,
        max_tokens: args.max_tokens,
        messages: args.messages,
        ...(output_config ? { output_config } : {}),
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
