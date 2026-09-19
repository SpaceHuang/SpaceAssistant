import { normalizeToolLoopMaxTokens } from '../src/shared/llm/toolLoopMaxTokens'

/**
 * Thinking 档位不经此函数承接：effort 由 invocation.profile.reasoning 下传（评审 N1），
 * 本函数仅负责 maxTokens 归一与遗留布尔 enableThinking 的过渡期解析。
 */
export function resolveToolLoopModelOptions(raw: unknown): { maxTokens: number; enableThinking: boolean } {
  const enableThinkingFallback = false
  if (!raw || typeof raw !== 'object') {
    return { maxTokens: normalizeToolLoopMaxTokens(undefined), enableThinking: enableThinkingFallback }
  }
  const obj = raw as { maxTokens?: unknown; enableThinking?: unknown }
  return {
    maxTokens: normalizeToolLoopMaxTokens(obj.maxTokens),
    enableThinking: typeof obj.enableThinking === 'boolean' ? obj.enableThinking : enableThinkingFallback
  }
}
