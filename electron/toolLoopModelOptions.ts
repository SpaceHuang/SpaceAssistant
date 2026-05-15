import { normalizeToolLoopMaxTokens } from '../src/shared/llm/toolLoopMaxTokens'

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
