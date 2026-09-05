import type { FetchedModelInfo, FetchServiceModelsResult } from '../src/shared/llmModelConfig'

/** 单次最多采纳的模型数量（§5.4；分页拉全时的总量上限） */
export const MAX_FETCHED_MODELS = 1000

const DEFAULT_TIMEOUT_MS = 10_000
const ANTHROPIC_OFFICIAL_BASE_URL = 'https://api.anthropic.com'
const ANTHROPIC_VERSION_HEADER = '2023-06-01'
/** Anthropic /v1/models 分页参数：每页 100，最多 10 页（与 MAX_FETCHED_MODELS 对齐） */
const PAGE_LIMIT = 100
const MAX_PAGES = 10

export type { FetchServiceModelsResult }

/**
 * baseUrl 归一化（§5.1 硬约束）：去尾斜杠；已含 /v1 结尾则拼 /models，否则补 /v1/models。
 * baseUrl 为空时回退 Anthropic 官方端点（与 createAnthropicClient 行为一致）。
 */
export function normalizeModelsEndpoint(baseUrl?: string): string {
  let base = (baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!base) base = ANTHROPIC_OFFICIAL_BASE_URL
  return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`
}

/**
 * 宽容解析（§5.1）：只取 data 数组中各元素的字符串 id；display_name 可用则带上。
 * 结构不符返回 null（含顶层不是对象、data 非数组）。
 */
export function parseModelListBody(body: unknown): FetchedModelInfo[] | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return null
  const out: FetchedModelInfo[] = []
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue
    const id = (item as { id?: unknown }).id
    if (typeof id !== 'string' || !id.trim()) continue
    const displayName = (item as { display_name?: unknown }).display_name
    out.push({ id, displayName: typeof displayName === 'string' && displayName.trim() ? displayName : undefined })
  }
  return out
}

type PageOutcome =
  | { ok: true; body: unknown }
  | { ok: false; result: FetchServiceModelsResult }

async function fetchPage(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  timeoutMs: number
): Promise<PageOutcome> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        Authorization: `Bearer ${apiKey}`,
        'anthropic-version': ANTHROPIC_VERSION_HEADER
      },
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (e) {
    const isAbort =
      (e instanceof DOMException && e.name === 'AbortError') ||
      (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError'))
    return { ok: false, result: { ok: false, error: isAbort ? 'timeout' : 'network' } }
  }

  // 错误分类仅依赖 HTTP 状态码（§5.1），禁止严格反序列化错误体
  if (response.status === 401 || response.status === 403) {
    return { ok: false, result: { ok: false, error: 'unauthorized', status: response.status } }
  }
  if (response.status === 404) {
    return { ok: false, result: { ok: false, error: 'not-found', status: response.status } }
  }
  if (!response.ok) {
    return { ok: false, result: { ok: false, error: 'network', status: response.status } }
  }

  try {
    return { ok: true, body: await response.json() }
  } catch {
    return { ok: false, result: { ok: false, error: 'invalid-response' } }
  }
}

/**
 * 从 LLM 服务拉取模型列表（§5）：GET {baseUrl}/v1/models，双认证头同带，10s 超时不重试。
 * 按 Anthropic 分页协议（has_more + after_id）翻页拉全；翻页/总量达到上限时 truncated=true，
 * 此时结果不完整，调用方不得将其用于替换勾选或失效判定。
 */
export async function fetchServiceModels(options: {
  baseUrl?: string
  apiKey: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<FetchServiceModelsResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const endpoint = normalizeModelsEndpoint(options.baseUrl)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const collected: FetchedModelInfo[] = []
  let afterId: string | undefined

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${endpoint}?limit=${PAGE_LIMIT}` + (afterId ? `&after_id=${encodeURIComponent(afterId)}` : '')
    const outcome = await fetchPage(fetchImpl, url, options.apiKey, timeoutMs)
    if (!outcome.ok) return outcome.result

    const pageModels = parseModelListBody(outcome.body)
    if (!pageModels) return { ok: false, error: 'invalid-response' }
    collected.push(...pageModels)
    if (collected.length > MAX_FETCHED_MODELS) {
      return { ok: true, models: collected.slice(0, MAX_FETCHED_MODELS), truncated: true }
    }

    // Anthropic 分页：has_more + last_id → after_id 翻下一页；网关未实现分页时字段缺失即视为拉全
    const body = outcome.body as { has_more?: unknown; last_id?: unknown }
    const hasMore = body.has_more === true
    const lastId = typeof body.last_id === 'string' && body.last_id ? body.last_id : undefined
    if (!hasMore || !lastId) {
      return { ok: true, models: collected, truncated: false }
    }
    afterId = lastId
  }

  // 页数耗尽仍未拉完：结果不完整
  return { ok: true, models: collected.slice(0, MAX_FETCHED_MODELS), truncated: true }
}
