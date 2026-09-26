import type { AgentReasoningEffort } from './agent/invocation'
import { MODEL_BASELINE } from './modelBaseline'

export type ThinkingSupportSource = 'baseline' | 'memo' | 'unknown'

export type ThinkingAvailability = {
  unsupported: readonly AgentReasoningEffort[]
  source: ThinkingSupportSource
}

const PRODUCT_EFFORTS: readonly AgentReasoningEffort[] = ['low', 'medium', 'high']

/**
 * 用模型目录的逐模型元数据做 fail-open 事前捷径，不改变档位校验或允许用户选择的值。
 * 键缺失代表上游数据没有明确裁决，只有显式 null 才视为不支持。
 */
export function resolveThinkingAvailability(
  modelName: string,
  opts: { effortUnsupportedByMemo: boolean }
): ThinkingAvailability {
  if (opts.effortUnsupportedByMemo === true) {
    return { unsupported: [...PRODUCT_EFFORTS], source: 'memo' }
  }

  try {
    const baseline = MODEL_BASELINE[modelName]
    const map = baseline?.thinkingLevelMap
    if (!baseline || !map || typeof map !== 'object' || Array.isArray(map)) {
      return { unsupported: [], source: 'unknown' }
    }
    if (Object.values(map).some((value) => value !== null && typeof value !== 'string')) {
      return { unsupported: [], source: 'unknown' }
    }
    return {
      unsupported: PRODUCT_EFFORTS.filter((effort) => map[effort] === null),
      source: 'baseline'
    }
  } catch {
    return { unsupported: [], source: 'unknown' }
  }
}
