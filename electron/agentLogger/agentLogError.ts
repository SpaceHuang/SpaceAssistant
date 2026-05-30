import { sanitizeForLog } from './sanitize'
import { isAgentLogProductionMode } from './agentLogPaths'

type AgentLogDepsLike = { isPackaged: boolean }

let getDeps: (() => AgentLogDepsLike | null) | null = null

/** 开发态 errorDetail 单字段最大长度（脱敏后） */
const DEV_ERROR_DETAIL_MAX_STRING = 16 * 1024

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'cookie',
  'set-cookie'
])

/** 由 agentLogger 在 init 时注入 */
export function bindAgentLogErrorDeps(getter: () => AgentLogDepsLike | null): void {
  getDeps = getter
}

export function isAgentLogProductionModeActive(): boolean {
  const deps = getDeps?.()
  if (!deps) return true
  return isAgentLogProductionMode(deps.isPackaged)
}

/** 开发态日志用：保留 message + stack */
export function errorDetailForLog(err: unknown): string {
  if (err instanceof Error) {
    const stack = err.stack?.trim()
    return stack && stack.includes(err.message) ? stack : err.message
  }
  return String(err)
}

export type AgentLogErrorFields = {
  error: string
  userError?: string
  /** 开发态：结构化错误详情（API 响应体、状态码等，已脱敏） */
  errorDetail?: Record<string, unknown>
}

function truncateForDetail(value: string | undefined, max = 8000): string | undefined {
  if (value == null) return undefined
  if (value.length <= max) return value
  return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`
}

function redactUrlForLog(url: string): string {
  try {
    const u = new URL(url)
    for (const key of [...u.searchParams.keys()]) {
      if (/key|token|secret|password|auth/i.test(key)) {
        u.searchParams.set(key, '[REDACTED]')
      }
    }
    return u.toString()
  } catch {
    return url
  }
}

function redactHeadersForLog(
  headers: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!headers) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADER_NAMES.has(k.toLowerCase()) ? '[REDACTED]' : v
  }
  return out
}

function tryParseJsonBody(body: string | undefined): unknown | undefined {
  if (!body?.trim()) return undefined
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

function summarizeMessageContent(content: unknown): unknown {
  if (typeof content === 'string') {
    if (content.length <= 600) return content
    return `${content.slice(0, 600)}…[truncated ${content.length - 600} chars]`
  }
  if (!Array.isArray(content)) return content
  return content.map((part) => {
    if (part && typeof part === 'object') {
      const p = part as Record<string, unknown>
      if (p.type === 'text' && typeof p.text === 'string') {
        return { ...p, text: summarizeMessageContent(p.text) }
      }
      if (p.type === 'image' || 'image_url' in p) {
        return { type: p.type ?? 'image', _omitted: 'binary_or_image_content' }
      }
    }
    return part
  })
}

function summarizeRequestBodyValues(values: unknown): unknown {
  if (values == null || typeof values !== 'object') return values
  const body = values as Record<string, unknown>
  if (!Array.isArray(body.messages)) {
    return { _keys: Object.keys(body), _preview: truncateForDetail(JSON.stringify(body), 2000) }
  }
  return {
    model: body.model,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    stream: body.stream,
    thinking: body.thinking,
    tool_choice: body.tool_choice,
    tools: Array.isArray(body.tools)
      ? body.tools.map((t) => {
          if (t && typeof t === 'object') {
            const tool = t as Record<string, unknown>
            return {
              name: tool.name,
              description:
                typeof tool.description === 'string'
                  ? truncateForDetail(tool.description, 200)
                  : tool.description,
              input_schema:
                tool.input_schema != null
                  ? { _present: true, _keys: Object.keys(tool.input_schema as object) }
                  : undefined
            }
          }
          return t
        })
      : body.tools,
    output_config: body.output_config,
    messageCount: body.messages.length,
    messages: body.messages.map((m: unknown) => {
      if (!m || typeof m !== 'object') return m
      const msg = m as Record<string, unknown>
      return {
        role: msg.role,
        content: summarizeMessageContent(msg.content)
      }
    })
  }
}

function extractOneErrorDetail(err: unknown): Record<string, unknown> | null {
  if (!(err instanceof Error)) {
    if (err == null) return null
    return { kind: 'value', value: String(err) }
  }

  const url = 'url' in err && typeof (err as { url?: unknown }).url === 'string' ? (err as { url: string }).url : undefined
  if (url) {
    const e = err as Error & {
      statusCode?: number
      responseBody?: string
      responseHeaders?: Record<string, string>
      data?: unknown
      requestBodyValues?: unknown
    }
    const responseBody = truncateForDetail(e.responseBody)
    return {
      kind: 'api_call',
      name: e.name,
      message: e.message,
      url: redactUrlForLog(url),
      statusCode: e.statusCode,
      responseBody,
      responseBodyJson: tryParseJsonBody(responseBody),
      responseHeaders: redactHeadersForLog(e.responseHeaders),
      data: e.data,
      requestBody: summarizeRequestBodyValues(e.requestBodyValues)
    }
  }

  if ('text' in err && (err.name === 'AI_NoObjectGeneratedError' || err.name.includes('NoObjectGenerated'))) {
    const e = err as Error & {
      text?: string
      finishReason?: string
      usage?: unknown
      response?: unknown
    }
    return {
      kind: 'no_object_generated',
      name: e.name,
      message: e.message,
      text: truncateForDetail(e.text),
      finishReason: e.finishReason,
      usage: e.usage,
      response: e.response
    }
  }

  return {
    kind: 'error',
    name: err.name,
    message: err.message
  }
}

/**
 * 开发态专用：从错误链提取 API 响应体、状态码、请求摘要等（已脱敏）。
 * 发布态或未注入 deps 时返回 undefined。
 */
export function extractDevErrorDetail(err: unknown): Record<string, unknown> | undefined {
  if (isAgentLogProductionModeActive()) return undefined
  if (err == null || err === '') return undefined

  const chain: Record<string, unknown>[] = []
  let current: unknown = err
  for (let depth = 0; depth < 4 && current != null; depth++) {
    const item = extractOneErrorDetail(current)
    if (item) chain.push(item)
    current =
      current instanceof Error && current.cause != null && current.cause !== current
        ? current.cause
        : undefined
  }

  if (chain.length === 0) return undefined

  const raw = chain.length === 1 ? chain[0]! : { errorChain: chain }
  return sanitizeForLog(raw, { maxStringLength: DEV_ERROR_DETAIL_MAX_STRING }) as Record<string, unknown>
}

/**
 * 发布态：error 与用户提示一致；开发态：error 为完整技术细节，可选 userError / errorDetail。
 */
export function buildAgentLogErrorFields(
  err: unknown,
  userMessage: string
): AgentLogErrorFields {
  if (isAgentLogProductionModeActive()) {
    return { error: userMessage }
  }
  const detail = err != null && err !== '' ? errorDetailForLog(err) : userMessage
  const errorDetail = extractDevErrorDetail(err)
  const base: AgentLogErrorFields =
    detail === userMessage ? { error: detail } : { error: detail, userError: userMessage }
  if (errorDetail) {
    base.errorDetail = errorDetail
  }
  return base
}
