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

export function sanitizeCapabilityParamsForDisplay(value: unknown, key?: string): unknown {
  if (key && CREDENTIAL_KEY_PATTERN.test(key)) {
    return Boolean(value)
  }
  // URL 类值：内嵌凭据（userinfo / 凭据 query 参数）打码，与结果侧 sanitizeUrlCredentials 同口径。
  // electron 侧注入实现（评审中 4）；shared 侧默认原样（无 electron 依赖），由 electron/confirm
  // 提取器在组装摘要时二次处理——此处仅按 URL 形态保守处理 query 凭据。
  if (key && /^(endpoint|url|href)$/i.test(key) && typeof value === 'string') {
    return value.replace(/([?&](?:token|key|secret|signature|sig|password|passwd|access_token|refresh_token|api[_-]?key)=)[^&#]*/gi, '$1***')
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
