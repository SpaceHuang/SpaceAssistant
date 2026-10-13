export interface McpConfirmPromptMetadata {
  serverName: string
  originalToolName: string
  description?: string
}

const SECRET_KEY = /(?:password|secret|token|api[_-]?key|authorization|credential|cookie)/i
const MAX_ARGUMENTS_LENGTH = 1400

function safeString(value: string, maxLength = 500): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function redact(value: unknown, key = '', depth = 0): unknown {
  if (SECRET_KEY.test(key)) return '[已隐藏]'
  if (depth > 5) return '[已省略：嵌套过深]'
  if (typeof value === 'string') {
    const normalized = safeString(value, 700)
    if (/^https?:\/\//i.test(normalized)) {
      try {
        const url = new URL(normalized)
        if (url.username || url.password) {
          url.username = ''
          url.password = ''
        }
        for (const param of [...url.searchParams.keys()]) {
          if (SECRET_KEY.test(param)) url.searchParams.set(param, '[已隐藏]')
        }
        return url.toString()
      } catch {
        return normalized
      }
    }
    return normalized
  }
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => redact(item, key, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 50)
      .map(([childKey, child]) => [safeString(childKey, 100), redact(child, childKey, depth + 1)]))
  }
  return value
}

/** MCP descriptors come from the server; show them as unverified context alongside the exact bounded request. */
export function formatMcpConfirmPromptDetails(
  metadata: McpConfirmPromptMetadata,
  input?: Record<string, unknown>
): string {
  const toolName = safeString(metadata.originalToolName, 120) || '未命名工具'
  const serverName = safeString(metadata.serverName, 120) || '未知服务'
  const description = safeString(metadata.description ?? '', 700) || '服务没有提供用途说明。'
  const lines = [
    `MCP 工具：${toolName}（服务：${serverName}）`,
    `用途说明（由 MCP 服务提供，未经验证）：${description}`
  ]
  if (input && Object.keys(input).length) {
    let args = JSON.stringify(redact(input), null, 2) ?? '{}'
    if (args.length > MAX_ARGUMENTS_LENGTH) args = `${args.slice(0, MAX_ARGUMENTS_LENGTH)}…（参数已截断）`
    lines.push(`本次请求参数：\n${args}`)
  }
  return lines.join('\n')
}
