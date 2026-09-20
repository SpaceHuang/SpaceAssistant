import { DEFAULT_MODEL_MAX_CONTEXT } from './domainTypes'
import { estimateTokensFromUtf8Text } from './contextUsageEstimate'

function estimateProtocolTokens(value: unknown): number {
  if (typeof value === 'string') return estimateTokensFromUtf8Text(value)
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateProtocolTokens(item), 0)
  if (!value || typeof value !== 'object') return 0
  const record = value as Record<string, unknown>
  if (record.type === 'image' && record.source && typeof record.source === 'object') {
    const source = record.source as Record<string, unknown>
    return typeof source.data === 'string' ? Math.max(85, Math.ceil(source.data.length / 2_000)) : 85
  }
  return Object.entries(record).reduce((sum, [key, entry]) => key === 'data' && typeof entry === 'string' ? sum : sum + estimateProtocolTokens(entry), 0)
}

export type RequestContextPayload = {
  requestId: string
  windowId: string
  provider: string
  model: string
  contextWindow: { tokens: number; source: 'config' | 'adapter' }
  maxTokensEffective: number
  outputReserveTokens: number
  outputAccounting: 'shared' | 'separate'
  schemaVersion: 1
  budget: { totalInputBudget: number; bodyBudget: number; inputBudget: number; prefixTokens: number; requiredTokens: number; outputReserveTokens: number; safetyReserveTokens: number; triggerRatio: number; targetBodyRatio: number; estimatorVersion: string; serializationVersion: string }
  contextUsage: { pressureTokens: number | null; projectedTokens: number | null; surfaceTokens: number; hardFit: boolean; bodyFit: boolean }
  decisionId: string
  phase: string
  reason: string
  ruleVersion: string
  decisionFingerprint: string
  planningStatus: 'target_reached' | 'fits_without_headroom' | 'exhausted' | 'uncompressible'
}

export type RequestHeaderPayload = {
  schemaVersion: 1
  requestId: string
  surfaceSnapshot: { schemaVersion: 1; fingerprint: string; systemFingerprint: string; toolsFingerprint: string; surfaceTokens: number; systemTokens: number; toolsTokens: number; messageTokens: number }
  stablePrefixFingerprint: string
  /** P1-3(b)：指纹未变时省略全量（undefined），读取侧按 surfaceSnapshot 的指纹回填。 */
  system?: string
  tools?: unknown[]
  requiredSurfaceSet: string[]
  /** P1-3(c)：completedToolUseIds 为「相对上一请求新增」的增量（request_header 的 checkpoint
   *  无程序化读取方——压缩恢复走内存对象；随轮次写全量曾占 ≈5.6 KB/请求）。 */
  toolExecutionCheckpoint: { completedToolUseIds: string[]; replayForbidden: boolean }
  /** P0-1 messages 面埋点：与上一请求的规范化消息序列逐 item 比对（§5.2.3-1）。 */
  messagePrefixStats?: MessagePrefixStats
  /** P0-1 wire 面埋点：cache_control 断点位置序列与上一请求对比（§5.2.3-2）。 */
  cacheBreakpoints?: CacheBreakpoints
}

/** P1-3(b)：system/tools 的「上一请求指纹」记忆（调用方按缓存域保存并回传）。 */
export type ConstantHeaderFingerprints = { system: string; tools: string }

/**
 * P1-3(b)（agent-context-token-cost-optimization-plan §5.1.4）：system/tools 全程恒定时
 * （实测 b680b181 两指纹跨 146 请求不变），每请求重复写全量 ≈93 KB。
 * 首见或指纹变化时保留全量；指纹未变则省略 system/tools（指纹引用保留在 surfaceSnapshot）。
 * 纯函数：调用方保存返回的 fingerprints 并在下一次传入。
 */
export function elideConstantHeaderFields(header: RequestHeaderPayload, prev: ConstantHeaderFingerprints | null): { elided: RequestHeaderPayload; fingerprints: ConstantHeaderFingerprints } {
  const fingerprints = { system: header.surfaceSnapshot.systemFingerprint, tools: header.surfaceSnapshot.toolsFingerprint }
  if (prev && prev.system === fingerprints.system && prev.tools === fingerprints.tools) {
    return { elided: { ...header, system: undefined, tools: undefined }, fingerprints }
  }
  return { elided: header, fingerprints }
}

/** messages 面前缀统计：firstDivergedIndex 即「前缀在第几个 item 断了」（Codex 的 input diverged at item N）。 */
export type MessagePrefixStats = {
  itemCount: number
  prevItemCount: number | null
  commonPrefixItems: number | null
  firstDivergedIndex: number | null
  /** appended=严格前缀扩展（缓存友好）；replaced=原地改写（缓存杀手）；truncated=历史被裁剪；reordered=仅位置变化。 */
  divergedReason: 'appended' | 'replaced' | 'truncated' | 'reordered' | null
  /** 分歧项（firstDivergedIndex 处）的 item 内容指纹；reordered 时为两侧剩余 item 排序后的聚合指纹（相等 ⇔ 仅位置变化）。 */
  prevItemDigest: string | null
  currItemDigest: string | null
}

/** wire 面断点观测：positions 元素为 'system' 或 'msg:<index>'（与 serializer 注入规则同源）。 */
export type CacheBreakpoints = {
  count: number
  positions: string[]
  tailIsString: boolean
  prevPositions: string[] | null
  moved: boolean
}

function fingerprint(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 指纹比较的是模型可见语义，不把 serializer 的缓存控制元数据当成消息内容。 */
function canonicalizeSurfaceMessages(messages: readonly unknown[]): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== 'object') return message
    const source = message as { role?: unknown; content?: unknown }
    const content = source.content
    if (Array.isArray(content) && content.every((block) => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string')) {
      return { role: source.role, content: content.map((block) => (block as { text: string }).text).join('') }
    }
    if (Array.isArray(content)) {
      return { role: source.role, content: content.map((block) => {
        if (!block || typeof block !== 'object') return block
        const { cache_control: _cacheControl, ...withoutCacheControl } = block as Record<string, unknown>
        return withoutCacheControl
      }) }
    }
    return { role: source.role, content }
  })
}

/** canonicalize 后逐 item 的内容指纹（8 位 FNV-1a）。 */
function itemDigest(canonical: unknown): string {
  return fingerprint(JSON.stringify(canonical))
}

function sortedAggregateDigest(digests: string[]): string {
  return fingerprint(JSON.stringify([...digests].sort()))
}

/**
 * P0-1 messages 面前缀统计（§5.2.3-1）：比较本次请求与上一请求的规范化消息序列。
 * 比较基于 canonicalizeSurfaceMessages（剥离 cache_control、合并纯 text 块数组），
 * 保证比较的是「模型可见语义」；wire 面的断点注入不会在这里制造假分歧（§7.1 场景 5/10）。
 * prevItemDigests 来自 digestSurfaceItems(上一请求 messages)——调用方只需保存上一请求的
 * digest 列表（数百个 8 字符哈希），不必持有完整消息（§5.2.3 要点 6 内存口径）。
 */
export function digestSurfaceItems(messages: readonly unknown[]): string[] {
  return canonicalizeSurfaceMessages(messages).map(itemDigest)
}

export function computeMessagePrefixStats(messages: readonly unknown[], prevItemDigests: readonly string[] | null): MessagePrefixStats {
  const itemCount = messages.length
  if (!prevItemDigests) {
    return { itemCount, prevItemCount: null, commonPrefixItems: null, firstDivergedIndex: null, divergedReason: null, prevItemDigest: null, currItemDigest: null }
  }
  const prevDigests = [...prevItemDigests]
  const currDigests = digestSurfaceItems(messages)
  let common = 0
  const n = Math.min(prevDigests.length, currDigests.length)
  while (common < n && prevDigests[common] === currDigests[common]) common++
  const prevItemDigest = common < prevDigests.length ? prevDigests[common]! : null
  const currItemDigest = common < currDigests.length ? currDigests[common]! : null
  const base = { itemCount, prevItemCount: prevDigests.length, commonPrefixItems: common, prevItemDigest, currItemDigest }
  if (common === prevDigests.length && common === currDigests.length) {
    return { ...base, firstDivergedIndex: null, divergedReason: null }
  }
  if (common === prevDigests.length && currDigests.length > prevDigests.length) {
    return { ...base, firstDivergedIndex: prevDigests.length, divergedReason: 'appended' }
  }
  if (common === currDigests.length && currDigests.length < prevDigests.length) {
    return { ...base, firstDivergedIndex: common, divergedReason: 'truncated' }
  }
  // 截断（含中间裁剪）：curr 的 digests 按序出现在 prev 中且整体更短
  if (currDigests.length < prevDigests.length) {
    let pi = 0
    let isSubsequence = true
    for (const digest of currDigests) {
      while (pi < prevDigests.length && prevDigests[pi] !== digest) pi++
      if (pi >= prevDigests.length) { isSubsequence = false; break }
      pi++
    }
    if (isSubsequence) return { ...base, firstDivergedIndex: common, divergedReason: 'truncated' }
  }
  // 仅位置变化：分歧后两侧的多重集合一致
  if (prevDigests.length === currDigests.length && sortedAggregateDigest(prevDigests.slice(common)) === sortedAggregateDigest(currDigests.slice(common))) {
    return { ...base, firstDivergedIndex: common, divergedReason: 'reordered', prevItemDigest: sortedAggregateDigest(prevDigests.slice(common)), currItemDigest: sortedAggregateDigest(currDigests.slice(common)) }
  }
  return { ...base, firstDivergedIndex: common, divergedReason: 'replaced' }
}

export function buildRequestHeaderPayload(args: { requestId: string; system: string; tools: unknown[]; messages: unknown[]; requiredSurfaceSet?: string[]; toolExecutionCheckpoint?: { completedToolUseIds: string[]; replayForbidden: boolean }; messagePrefixStats?: MessagePrefixStats; cacheBreakpoints?: CacheBreakpoints }): RequestHeaderPayload {
  const systemTokens = estimateTokensFromUtf8Text(args.system)
  const toolsTokens = estimateTokensFromUtf8Text(JSON.stringify(args.tools))
  const messageTokens = estimateProtocolTokens(args.messages)
  const systemFingerprint = fingerprint(args.system)
  const toolsFingerprint = fingerprint(JSON.stringify(args.tools))
  const surfaceFingerprint = fingerprint(JSON.stringify({ system: args.system, tools: args.tools, messages: canonicalizeSurfaceMessages(args.messages) }))
  return { schemaVersion: 1, requestId: args.requestId, system: args.system, tools: args.tools, requiredSurfaceSet: [...(args.requiredSurfaceSet ?? [])], toolExecutionCheckpoint: args.toolExecutionCheckpoint ?? { completedToolUseIds: [], replayForbidden: false }, stablePrefixFingerprint: fingerprint(`${systemFingerprint}:${toolsFingerprint}`), surfaceSnapshot: { schemaVersion: 1, fingerprint: surfaceFingerprint, systemFingerprint, toolsFingerprint, surfaceTokens: systemTokens + toolsTokens + messageTokens, systemTokens, toolsTokens, messageTokens }, ...(args.messagePrefixStats ? { messagePrefixStats: args.messagePrefixStats } : {}), ...(args.cacheBreakpoints ? { cacheBreakpoints: args.cacheBreakpoints } : {}) }
}

export function buildRequestContextPayload(args: {
  requestId: string
  provider: string
  model: string
  contextWindow?: number
  maxTokensEffective: number
  outputAccounting?: 'shared' | 'separate'
  surfaceSnapshot?: { surfaceTokens: number; systemTokens: number; toolsTokens?: number }
  decision?: { decisionId: string; phase: string; reason: string; ruleVersion: string }
  contextUsage?: RequestContextPayload['contextUsage']
  windowId?: string
  planningStatus?: RequestContextPayload['planningStatus']
}): RequestContextPayload {
  const outputAccounting = args.outputAccounting ?? 'shared'
  const hasConfiguredWindow = Number.isFinite(args.contextWindow) && args.contextWindow! > 0
  const contextWindow = hasConfiguredWindow ? args.contextWindow! : DEFAULT_MODEL_MAX_CONTEXT
  const prefixTokens = Math.max(0, (args.surfaceSnapshot?.systemTokens ?? 0) + (args.surfaceSnapshot?.toolsTokens ?? 0))
  const rawInputWindow = Math.max(0, contextWindow - (outputAccounting === 'shared' ? Math.max(0, args.maxTokensEffective) : 0))
  const totalInputBudget = Math.max(0, Math.floor(rawInputWindow * 0.95))
  const bodyBudget = Math.max(0, totalInputBudget - prefixTokens)
  const surfaceTokens = args.surfaceSnapshot?.surfaceTokens ?? prefixTokens
  const decision = args.decision ?? { decisionId: args.requestId, phase: 'turn_boundary', reason: 'proactive', ruleVersion: 'adaptive-v1' }
  const decisionFingerprint = fingerprint(JSON.stringify({ ...decision, surfaceTokens, prefixTokens, totalInputBudget, bodyBudget, triggerRatio: 0.9, targetBodyRatio: 0.8, contextWindow, windowId: args.windowId ?? args.requestId }))
  return {
    requestId: args.requestId,
    windowId: args.windowId ?? args.requestId,
    provider: args.provider,
    model: args.model,
    contextWindow: { tokens: contextWindow, source: hasConfiguredWindow ? 'config' : 'adapter' },
    maxTokensEffective: Math.max(0, args.maxTokensEffective),
    outputReserveTokens: outputAccounting === 'shared' ? Math.max(0, args.maxTokensEffective) : 0,
    outputAccounting,
    schemaVersion: 1,
    budget: { totalInputBudget, bodyBudget, inputBudget: bodyBudget, prefixTokens, requiredTokens: 0, outputReserveTokens: outputAccounting === 'shared' ? Math.max(0, args.maxTokensEffective) : 0, safetyReserveTokens: 0, triggerRatio: 0.9, targetBodyRatio: 0.8, estimatorVersion: 'default-v1', serializationVersion: 'anthropic-wire-v1' },
    contextUsage: args.contextUsage ?? { pressureTokens: null, projectedTokens: null, surfaceTokens, hardFit: surfaceTokens <= totalInputBudget, bodyFit: Math.max(0, surfaceTokens - prefixTokens) <= bodyBudget },
    ...decision,
    decisionFingerprint,
    planningStatus: args.planningStatus ?? 'fits_without_headroom'
  }
}
