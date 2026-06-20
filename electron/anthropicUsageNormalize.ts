import type { SessionUsage } from '../src/shared/sessionUsage'
import { annotateUsageCacheSemantics } from '../src/shared/usageCacheSemantics'

function finitePositive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
}

function pickNestedNumber(obj: unknown, key: string): number | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const v = (obj as Record<string, unknown>)[key]
  return finitePositive(v) ? v : undefined
}

export function pickCacheReadInputTokensFromUsageObject(uo: Record<string, unknown>): number | undefined {
  const nested = pickNestedNumber(uo.prompt_tokens_details, 'cached_tokens')
  if (nested != null) return nested
  if (finitePositive(uo.cached_tokens)) return uo.cached_tokens
  if (finitePositive(uo.cache_read_input_tokens)) return uo.cache_read_input_tokens
  return undefined
}

export function pickCacheCreationInputTokensFromUsageObject(uo: Record<string, unknown>): number | undefined {
  const nested = pickNestedNumber(uo.prompt_tokens_details, 'cache_creation_input_tokens')
  if (nested != null) return nested
  if (finitePositive(uo.cache_creation_input_tokens)) return uo.cache_creation_input_tokens
  return undefined
}

export function pickInputTokensFromUsageObject(u: Record<string, unknown>): number | undefined {
  const direct = u.input_tokens
  if (finitePositive(direct)) return direct

  const prompt = u.prompt_tokens
  if (finitePositive(prompt)) return prompt

  const inp = u.input
  if (finitePositive(inp)) return inp

  const pr = u.prompt
  if (finitePositive(pr)) return pr

  const total = u.total_tokens
  if (finitePositive(total)) return total

  return undefined
}

export function normalizeAnthropicMessageUsage(
  res: unknown,
  baseUrl?: string
): SessionUsage | undefined {
  const u = (res as { usage?: unknown } | null)?.usage
  if (!u || typeof u !== 'object') return undefined
  const uo = u as Record<string, unknown>
  const input_tokens = pickInputTokensFromUsageObject(uo)
  if (input_tokens == null) return undefined
  const out: SessionUsage = { input_tokens }
  const numericExtras = out as unknown as Record<string, number | undefined>
  for (const [k, v] of Object.entries(uo)) {
    if (k === 'input_tokens') continue
    if (typeof v === 'number' && Number.isFinite(v)) {
      numericExtras[k] = v
    }
  }

  const cacheRead = pickCacheReadInputTokensFromUsageObject(uo)
  if (cacheRead != null) {
    out.cache_read_input_tokens = cacheRead
  }

  const cacheCreate = pickCacheCreationInputTokensFromUsageObject(uo)
  if (cacheCreate != null) {
    out.cache_creation_input_tokens = cacheCreate
  }

  return annotateUsageCacheSemantics(out, { baseUrl, rawUsage: uo })
}
