import type { ModelEntry } from '../domainTypes'
import { TOOL_LOOP_MAX_TOKENS_MAX, TOOL_LOOP_MAX_TOKENS_MIN, normalizeToolLoopMaxTokens } from './toolLoopMaxTokens'

/**
 * 单次 API 的 max_tokens：优先使用「模型列表」里与当前 model 名称对应行的「输出」；
 * 未匹配到有效值时，再使用全局配置中的 maxTokens（经 normalize）。
 */
export function resolveEffectiveOutputMaxTokens(
  modelName: string,
  models: ModelEntry[] | undefined,
  configMaxTokens: number
): number {
  const row = (Array.isArray(models) ? models : []).find((m) => m.name === modelName)
  const fromRow =
    row &&
    typeof row.maxTokens === 'number' &&
    Number.isFinite(row.maxTokens) &&
    row.maxTokens >= TOOL_LOOP_MAX_TOKENS_MIN
      ? Math.floor(row.maxTokens)
      : undefined
  if (fromRow != null) return Math.min(TOOL_LOOP_MAX_TOKENS_MAX, fromRow)
  return normalizeToolLoopMaxTokens(configMaxTokens)
}
