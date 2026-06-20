import type { SessionUsage } from './sessionUsage'

export type UsageCacheSemantics = 'additive' | 'subset'

function finiteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

/** 从 API 原始 usage 对象推断 cache 口径（优先于 baseUrl） */
export function inferCacheSemanticsFromRawUsage(
  uo: Record<string, unknown>,
  baseUrl?: string
): UsageCacheSemantics {
  if (uo.prompt_tokens != null || uo.prompt_tokens_details != null) {
    return 'subset'
  }
  if (finiteNumber(uo.cache_read_input_tokens) || finiteNumber(uo.cache_creation_input_tokens)) {
    return 'additive'
  }
  return resolveUsageCacheSemanticsFromBaseUrl(baseUrl)
}

/** 从 LLM 服务 baseUrl 推断 cache 口径；未知时保守加性（避免低估） */
export function resolveUsageCacheSemanticsFromBaseUrl(baseUrl?: string): UsageCacheSemantics {
  const trimmed = (baseUrl ?? '').trim()
  if (!trimmed) return 'additive'

  let host = ''
  let path = ''
  try {
    const u = new URL(trimmed)
    host = u.hostname.toLowerCase()
    path = u.pathname.toLowerCase()
  } catch {
    return 'additive'
  }

  if (host.includes('openai.com') || host.includes('openai.azure')) {
    return 'subset'
  }

  if (host.includes('anthropic.com')) {
    return 'additive'
  }

  if (host.includes('deepseek.com') && path.includes('anthropic')) {
    return 'additive'
  }

  return 'additive'
}

export type AnnotateUsageCacheSemanticsContext = {
  baseUrl?: string
  rawUsage?: Record<string, unknown>
}

/** 为归一化后的 usage 标注 cacheSemantics */
export function annotateUsageCacheSemantics(
  usage: SessionUsage,
  ctx?: AnnotateUsageCacheSemanticsContext
): SessionUsage {
  if (usage.cacheSemantics) return usage

  const semantics = ctx?.rawUsage
    ? inferCacheSemanticsFromRawUsage(ctx.rawUsage, ctx.baseUrl)
    : resolveUsageCacheSemanticsFromBaseUrl(ctx?.baseUrl)

  return { ...usage, cacheSemantics: semantics }
}
