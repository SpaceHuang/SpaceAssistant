import { normalizeToolLoopMaxTokens } from '../src/shared/llm/toolLoopMaxTokens'
import { isThinkingEffort, type AgentReasoningEffort } from '../src/shared/thinkingEffort'

export function resolveToolLoopModelOptions(raw: unknown): {
  maxTokens: number
  enableThinking: boolean
  /** 显式档位（§7.2 契约下传）；迁移期与 enableThinking 并存，effort 优先。 */
  effort?: AgentReasoningEffort
} {
  const enableThinkingFallback = false
  if (!raw || typeof raw !== 'object') {
    return { maxTokens: normalizeToolLoopMaxTokens(undefined), enableThinking: enableThinkingFallback }
  }
  const obj = raw as { maxTokens?: unknown; enableThinking?: unknown; effort?: unknown }
  return {
    maxTokens: normalizeToolLoopMaxTokens(obj.maxTokens),
    enableThinking: typeof obj.enableThinking === 'boolean' ? obj.enableThinking : enableThinkingFallback,
    ...(isThinkingEffort(obj.effort) ? { effort: obj.effort } : {})
  }
}
