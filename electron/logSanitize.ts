import { CREDENTIAL_KEY_PATTERN, isEnvCarrierKey, isEnvSecretMapKey } from '../src/shared/capabilityParamSanitize'

/**
 * 键级脱敏：精确匹配历史清单 + 凭据词包含匹配（v2 评审 S1'）。
 * 精确锚定不匹配 accessToken/headerValue/env 内 API_TOKEN 等复合键，toolkit.call 的
 * tool.request 日志经此落盘，故补「键名含凭据词」的宽匹配——误伤（普通值被 [REDACTED]）
 * 代价小于漏报（token 明文落 180 天日志）。
 */
const SENSITIVE_KEY_EXACT_PATTERN =
  /^(api[_-]?key|password|passwd|secret|token|authorization|x-api-key|credentials?|private[_-]?key)$/i

/**
 * 宽匹配否定白名单（v3 评审建议 2）：`max_tokens` 等量化字段名含 token 词但非凭据，
 * 误伤会把 LLM 400 排障关键字段打成 [REDACTED]。
 */
const NON_CREDENTIAL_KEY_PATTERN =
  /^(?:max|min|total|remaining|used|limit|budget)[_-]|[_-](?:max|min|total|remaining|used|limit|budget|count)$/i

function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEY_EXACT_PATTERN.test(key)) return true
  // env 键值表的载体键（toolkit.call 入参 env: { KEY: value }）与其 secret-map 变体
  if (isEnvCarrierKey(key) || isEnvSecretMapKey(key)) return true
  if (NON_CREDENTIAL_KEY_PATTERN.test(key)) return false
  if (CREDENTIAL_KEY_PATTERN.test(key)) return true
  // 复合键名含凭据词（accessToken / API_TOKEN / refreshToken…）：宽匹配兜底
  return /(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|authorization|credential)/i.test(key)
}

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
