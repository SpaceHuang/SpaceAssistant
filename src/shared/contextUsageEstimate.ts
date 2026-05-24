/** API 返回的原始 usage 字段（与 chatSlice.LastUsage 非 null 形态一致） */
export type ContextUsageRaw = {
  input_tokens: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** 单次 API 请求的完整 prompt token 数（兼容 Anthropic 加性 / OpenAI 子集性） */
export function computeTotalRequestInputTokens(usage: ContextUsageRaw): number {
  const input = usage.input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheCreate = usage.cache_creation_input_tokens ?? 0
  const cacheSum = cacheRead + cacheCreate

  if (cacheSum <= 0) return input

  // OpenAI 兼容：cached 为 prompt 子集，input 已是总量
  if (input >= cacheSum) return input

  // Anthropic 原生：cache 字段与 input_tokens 加性
  return input + cacheSum
}

/** 含 assistant 回复、下轮发送前的预估占用 */
export function computeEstimatedOccupancy(usage: ContextUsageRaw): number {
  return computeTotalRequestInputTokens(usage) + (usage.output_tokens ?? 0)
}

export type ContextUsageDisplay = {
  totalRequestInput: number
  lastOutput: number
  estimatedOccupancy: number
  effectiveOutputMax: number
  maximumContext: number
  usedRatio: number
  reservedRatio: number
  freeRatio: number
  percentUsed: number
}

export function computeContextUsageDisplay(
  usage: ContextUsageRaw,
  maximumContext: number,
  effectiveOutputMax: number
): ContextUsageDisplay {
  const totalRequestInput = computeTotalRequestInputTokens(usage)
  const lastOutput = usage.output_tokens ?? 0
  const estimatedOccupancy = totalRequestInput + lastOutput

  let usedRatio = estimatedOccupancy / maximumContext
  let reservedRatio = effectiveOutputMax / maximumContext

  if (usedRatio + reservedRatio > 1) {
    const scale = 1 / (usedRatio + reservedRatio)
    usedRatio *= scale
    reservedRatio *= scale
  }

  const freeRatio = Math.max(0, 1 - usedRatio - reservedRatio)
  const percentUsed = Math.round((estimatedOccupancy / maximumContext) * 1000) / 10

  return {
    totalRequestInput,
    lastOutput,
    estimatedOccupancy,
    effectiveOutputMax,
    maximumContext,
    usedRatio,
    reservedRatio,
    freeRatio,
    percentUsed
  }
}
