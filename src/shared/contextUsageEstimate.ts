import type { ChatImageAttachment, Message } from './domainTypes'

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
  // 当非缓存 input 仍明显大于 cache 合计时，更可能是 Anthropic 加性口径（input 不含 cache）
  if (input >= cacheSum) {
    if (cacheRead < input * 0.5) return input + cacheSum
    return input
  }

  // Anthropic 原生：cache 字段与 input_tokens 加性
  return input + cacheSum
}

/** 含 assistant 回复、下轮发送前的预估占用 */
export function computeEstimatedOccupancy(usage: ContextUsageRaw): number {
  return computeTotalRequestInputTokens(usage) + (usage.output_tokens ?? 0)
}

/** 保守估计单张图片 prompt token（非精确；Anthropic 按分辨率分块） */
export function estimateTokensFromImageAttachment(a: ChatImageAttachment): number {
  if (a.width != null && a.height != null && a.width > 0 && a.height > 0) {
    const blocks = Math.ceil(a.width / 512) * Math.ceil(a.height / 512)
    return Math.max(85, blocks * 400)
  }
  return Math.max(85, Math.ceil(a.byteLength / 2000))
}

export function estimateTokensFromImageAttachments(
  attachments: ReadonlyArray<ChatImageAttachment>
): number {
  return attachments.reduce((sum, a) => sum + estimateTokensFromImageAttachment(a), 0)
}

/** 粗估 history 中带图 user 消息的 prompt token（策略 A：每轮请求均计入） */
export function estimateTokensFromHistoryImages(messages: Message[]): number {
  let total = 0
  for (const m of messages) {
    if (m.role === 'user' && m.attachments?.length) {
      total += estimateTokensFromImageAttachments(m.attachments)
    }
  }
  return total
}

/** 粗估 UTF-8 文本 token 数（用于 tool_result 写入后的占用投影） */
export function estimateTokensFromUtf8Text(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 3.5)
}

function estimateTokensFromToolResultContent(content: unknown): number {
  if (typeof content === 'string') return estimateTokensFromUtf8Text(content)
  if (Array.isArray(content)) {
    let total = 0
    for (const block of content) {
      if (block && typeof block === 'object' && 'text' in block) {
        const text = (block as { text?: unknown }).text
        if (typeof text === 'string') total += estimateTokensFromUtf8Text(text)
      }
    }
    return total
  }
  try {
    return estimateTokensFromUtf8Text(JSON.stringify(content))
  } catch {
    return 0
  }
}

/** 估算一轮 tool_result 块将新增的 prompt token（下轮请求前尚未有 API usage） */
export function estimateTokensFromToolResults(toolResults: ReadonlyArray<{ content?: unknown }>): number {
  let total = 0
  for (const tr of toolResults) {
    total += estimateTokensFromToolResultContent(tr.content)
  }
  return total
}

/**
 * 工具执行完毕、tool_result 已拼入 messages 后，投影下一轮请求的 input 占用。
 * 在真实 API usage 返回前填补监控器更新空窗。
 */
export function projectUsageAfterToolResults(
  usage: ContextUsageRaw,
  toolResults: ReadonlyArray<{ content?: unknown }>
): ContextUsageRaw {
  const added = estimateTokensFromToolResults(toolResults)
  if (added <= 0) return usage
  return {
    ...usage,
    input_tokens: (usage.input_tokens ?? 0) + added
  }
}

/** 已知网关/提供商实际上下文上限（token）；展示分母取 min(模型配置, 此表) */
const MODEL_PROVIDER_CONTEXT_LIMITS: Readonly<Record<string, number>> = {
  'deepseek-v4-pro': 1_048_565,
  'deepseek-v4-flash': 1_048_565
}

const DEEPSEEK_PROVIDER_CONTEXT_LIMIT = 1_048_565

/** 环形图分母：模型配置与已知网关上限取较小值，避免配置偏大导致占用率失真 */
export function resolveEffectiveMaximumContext(modelName: string, configuredMaximumContext: number): number {
  if (!Number.isFinite(configuredMaximumContext) || configuredMaximumContext <= 0) {
    return configuredMaximumContext
  }
  const normalized = modelName.trim().toLowerCase()
  let providerCap = MODEL_PROVIDER_CONTEXT_LIMITS[normalized]
  if (providerCap == null && normalized.startsWith('deepseek-')) {
    providerCap = DEEPSEEK_PROVIDER_CONTEXT_LIMIT
  }
  if (providerCap != null && providerCap > 0) {
    return Math.min(configuredMaximumContext, providerCap)
  }
  return configuredMaximumContext
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
