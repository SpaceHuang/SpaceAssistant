import { CREDENTIAL_KEY_PATTERN, isEnvSecretMapKey } from '../../src/shared/capabilityParamSanitize'

const ANTHROPIC_KEY_PATTERN = /sk-ant-[a-zA-Z0-9_-]+/g
const BEARER_PATTERN = /Bearer\s+\S+/gi
const LONG_B64_PATTERN = /[A-Za-z0-9+/]{80,}={0,2}/g

/**
 * URL 内嵌凭据打码（评审中 4）：userinfo 段与凭据类 query 参数值打码，
 * 供 endpoint/url 类值进摘要、审计、错误消息前统一处理。
 */
export function sanitizeUrlCredentials(raw: string): string {
  const QUERY_SECRET_PATTERN = /(token|key|secret|signature|sig|password|passwd|access_token|refresh_token|api[_-]?key)(=[^&#]*)/gi
  try {
    const u = new URL(raw)
    let out = raw
    if (u.username || u.password) {
      const redactedAuth = `${u.username ? '***' : ''}:${u.password ? '***' : ''}@`
      out = out.replace(`${u.username}${u.password ? ':' + u.password : ''}@`, redactedAuth)
    }
    out = out.replace(QUERY_SECRET_PATTERN, '$1=***')
    return out
  } catch {
    // 非合法 URL：仅对凭据类 query 形态做保守打码
    return raw.replace(QUERY_SECRET_PATTERN, '$1=***')
  }
}

/** 字符串级凭据形态打码（导出供 callCapability 的 handler 错误消息复用，评审建议 3）。 */
export function scrubString(s: string): string {
  return s.replace(ANTHROPIC_KEY_PATTERN, '[REDACTED]').replace(BEARER_PATTERN, 'Bearer [REDACTED]').replace(LONG_B64_PATTERN, '[REDACTED_B64]')
}

/**
 * 结果脱敏（凭据零出现）：
 * 1) 凭据类字段只出布尔存在性，不透传值（与 mcpConfigStore 的 secretPresent 旗标同思路）；
 *    env:KEY 形态的 secret map 键同样只出布尔；
 * 2) 字符串内容打码凭据形态（token/Bearer/长 base64）。
 * 键清单与展示侧共享（src/shared/capabilityParamSanitize.ts，v2 评审建议 5 消除漂移）。
 */
export function sanitizeCapabilityResult(value: unknown): unknown {
  const seen = new WeakSet<object>()
  const walk = (v: unknown, key?: string): unknown => {
    if (key && (CREDENTIAL_KEY_PATTERN.test(key) || isEnvSecretMapKey(key))) {
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
