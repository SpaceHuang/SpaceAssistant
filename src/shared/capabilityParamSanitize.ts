/**
 * 能力入参的展示侧净化（评审 B1）：
 * toolkit.call 的 act 能力（如 action.mcp.add）以 accessToken/headerValue/env 为入参，
 * 这些值会出现在确认摘要、confirm-requested 载荷与确认卡片中——展示前必须把凭据值
 * 归并为布尔存在性，与结果路径的 sanitizeCapabilityResult（electron/capabilities/sanitize.ts）
 * 形成输入/输出两侧对称防线。
 */

const CREDENTIAL_KEY_PATTERN =
  /^(api[_-]?key|password|passwd|secret|token|access[_-]?token|refresh[_-]?token|authorization|x-api-key|credentials?|private[_-]?key|client[_-]?secret|header[_-]?value|headerName)$/i

/** env 键值表的值整体布尔化（键名保留，供用户辨认是哪个变量） */
function isEnvValueTable(key: string | undefined, value: unknown): value is Record<string, unknown> {
  return key === 'env' && Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function sanitizeCapabilityParamsForDisplay(value: unknown, key?: string): unknown {
  if (key && CREDENTIAL_KEY_PATTERN.test(key)) {
    return Boolean(value)
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
