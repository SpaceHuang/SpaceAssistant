/**
 * 能力入参的展示侧净化（评审 B1/R1）：
 * toolkit.call 的 act 能力（如 action.mcp.add）以 accessToken/headerValue/env 为入参，
 * 这些值会出现在确认摘要、confirm-requested 载荷、确认卡片与确认后的详情展开中——
 * 展示前必须把凭据值归并为布尔存在性，与结果路径的 sanitizeCapabilityResult
 * （electron/capabilities/sanitize.ts）形成输入/输出两侧对称防线。
 */

/**
 * 凭据键清单（展示/结果两侧共享）。
 * 不含 headerName：它是「用哪个 header 鉴权」的可辨识信息，非凭据值（v2 评审建议 5）。
 * electron/logSanitize 也引用此清单做键级宽匹配兜底。
 */
export const CREDENTIAL_KEY_PATTERN =
  /^(api[_-]?key|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|authorization|x-api-key|credentials?|private[_-]?key|client[_-]?secret|header[_-]?value)$/i

/** env 键值表的载体键（大小写不敏感；v3 评审建议 3：三处口径统一引用此判定） */
export function isEnvCarrierKey(key: string): boolean {
  return /^env$/i.test(key)
}

/** env secret-map 键形态（env:KEY，结果/日志侧） */
export function isEnvSecretMapKey(key: string): boolean {
  return /^env:/i.test(key)
}

/** env 键值表的值整体布尔化（键名保留，供用户辨认是哪个变量） */
function isEnvValueTable(key: string | undefined, value: unknown): value is Record<string, unknown> {
  return Boolean(key) && isEnvCarrierKey(key!) && Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const URL_QUERY_SECRET_PATTERN =
  /([?&](?:token|key|secret|signature|sig|password|passwd|access_token|refresh_token|api[_-]?key)=)[^&#]*/gi

/**
 * URL 内嵌凭据打码（R1，评审复验）：userinfo 段与凭据类 query 参数值打码。
 * 保留原串形态（正则切片替换，不做 URL 规范化重写）；非法 URL 仅做 query 保守打码。
 */
export function sanitizeUrlCredentials(value: string): string {
  let out = value
  const userinfo = /^([a-z][a-z0-9+.-]*:\/\/)([^@/\s]+)@/i.exec(out)
  if (userinfo) {
    // 统一 ***:***（不区分 user-only / user:pass，避免凭据存在性侧信道）
    out = userinfo[1] + '***:***@' + out.slice(userinfo[0].length)
  }
  return out.replace(URL_QUERY_SECRET_PATTERN, '$1***')
}

export function sanitizeCapabilityParamsForDisplay(value: unknown, key?: string): unknown {
  if (key && CREDENTIAL_KEY_PATTERN.test(key)) {
    return Boolean(value)
  }
  // URL 类值（R1/中4）：userinfo 与凭据 query 参数打码——展示、审计摘要、持久化三面同口径
  if (key && /^(endpoint|url|href)$/i.test(key) && typeof value === 'string') {
    return sanitizeUrlCredentials(value)
  }
  if (isEnvValueTable(key, value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = Boolean(v)
    }
    return out
  }
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => sanitizeCapabilityParamsForDisplay(item))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = sanitizeCapabilityParamsForDisplay(v, k)
  }
  return out
}
