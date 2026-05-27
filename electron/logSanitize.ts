const SENSITIVE_KEY_PATTERN =
  /^(api[_-]?key|password|passwd|secret|token|authorization|x-api-key|credentials?|private[_-]?key)$/i

const ANTHROPIC_KEY_PATTERN = /sk-ant-[a-zA-Z0-9_-]+/g
const BEARER_PATTERN = /Bearer\s+\S+/gi
const LONG_B64_PATTERN = /[A-Za-z0-9+/]{80,}={0,2}/g

export const DEFAULT_MAX_STRING_LENGTH = 128 * 1024

export type SanitizeOptions = {
  maxStringLength?: number
}

function sanitizeString(value: string): string {
  let s = value
  s = s.replace(ANTHROPIC_KEY_PATTERN, '[REDACTED]')
  s = s.replace(BEARER_PATTERN, 'Bearer [REDACTED]')
  s = s.replace(LONG_B64_PATTERN, '[REDACTED_B64]')
  return s
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key)
}

export function sanitizeForLog(value: unknown, options?: SanitizeOptions): unknown {
  const maxLen = options?.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH
  const seen = new WeakSet<object>()

  const walk = (v: unknown, key?: string): unknown => {
    if (key && isSensitiveKey(key)) {
      return '[REDACTED]'
    }

    if (v == null || typeof v === 'number' || typeof v === 'boolean') {
      return v
    }

    if (typeof v === 'string') {
      const sanitized = sanitizeString(v)
      if (v.length > maxLen) {
        return {
          _value: sanitized.slice(0, maxLen),
          _truncated: true,
          _originalLength: v.length
        }
      }
      return sanitized
    }

    if (typeof v !== 'object') {
      return String(v)
    }

    if (seen.has(v)) {
      return '[Circular]'
    }
    seen.add(v)

    if (Array.isArray(v)) {
      return v.map((item) => walk(item))
    }

    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = walk(val, k)
    }
    return out
  }

  return walk(value)
}
