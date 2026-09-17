const CREDENTIAL_KEY_PATTERN =
  /^(api[_-]?key|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|authorization|x-api-key|credentials?|private[_-]?key|client[_-]?secret)$/i

const ANTHROPIC_KEY_PATTERN = /sk-ant-[a-zA-Z0-9_-]+/g
const BEARER_PATTERN = /Bearer\s+\S+/gi
const LONG_B64_PATTERN = /[A-Za-z0-9+/]{80,}={0,2}/g

function scrubString(s: string): string {
  return s.replace(ANTHROPIC_KEY_PATTERN, '[REDACTED]').replace(BEARER_PATTERN, 'Bearer [REDACTED]').replace(LONG_B64_PATTERN, '[REDACTED_B64]')
}

/**
 * 结果脱敏（凭据零出现）：
 * 1) 凭据类字段只出布尔存在性，不透传值（与 mcpConfigStore 的 secretPresent 旗标同思路）；
 * 2) 字符串内容打码凭据形态（token/Bearer/长 base64）。
 * 独立实现而不复用 sanitizeForLog 的键级 [REDACTED] 规则，以保留「存在性布尔」语义。
 */
export function sanitizeCapabilityResult(value: unknown): unknown {
  const seen = new WeakSet<object>()
  const walk = (v: unknown, key?: string): unknown => {
    if (key && CREDENTIAL_KEY_PATTERN.test(key)) {
      return Boolean(v)
    }
    if (v == null || typeof v === 'number' || typeof v === 'boolean') return v
    if (typeof v === 'string') return scrubString(v)
    if (typeof v !== 'object') return String(v)
    if (seen.has(v)) return '[Circular]'
    seen.add(v)
    if (Array.isArray(v)) return v.map((item) => walk(item))
    const out: Record<string, unknown> = {}
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
      out[k] = walk(item, k)
    }
    return out
  }
  return walk(value)
}
