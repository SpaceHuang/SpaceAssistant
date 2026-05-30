import type { StagehandModelConfig } from './browserLlmCredentials'

/** Stagehand 构造参数中的 model 字段（含 clientOptions + 可选 middleware） */
export type StagehandInitModel = {
  modelName: string
  apiKey: string
  baseURL?: string
  /** 注入到 @ai-sdk/anthropic createAnthropic，用于 DeepSeek 关闭默认 Thinking */
  fetch?: typeof fetch
}

type FetchFn = typeof fetch

/**
 * DeepSeek Anthropic 兼容接口下，V4 Pro 等模型默认开启 Thinking，
 * 与 Stagehand extract/observe 的 json 工具 + tool_choice 不兼容。
 * @ai-sdk/anthropic 在 thinking.type=disabled 时不会写入 HTTP body，需在 fetch 层补丁。
 */
export function isDeepSeekStagehandTarget(modelName: string, baseUrl?: string): boolean {
  const name = modelName.toLowerCase()
  const base = (baseUrl ?? '').toLowerCase()
  if (name.includes('deepseek')) return true
  if (base.includes('deepseek.com')) return true
  return false
}

export function shouldPatchDeepSeekAnthropicMessagesUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.hostname.includes('deepseek.com') && u.pathname.includes('/messages')
  } catch {
    return false
  }
}

/** 向 DeepSeek /anthropic/messages 请求体注入 thinking: disabled */
export function patchDeepSeekAnthropicRequestBody(body: string): string {
  const parsed = JSON.parse(body) as Record<string, unknown>
  parsed.thinking = { type: 'disabled' }
  return JSON.stringify(parsed)
}

export function createDeepSeekDisableThinkingFetch(baseFetch: FetchFn = globalThis.fetch.bind(globalThis)): FetchFn {
  return async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input instanceof Request
            ? input.url
            : String(input)

    if (!shouldPatchDeepSeekAnthropicMessagesUrl(url) || !init?.body || typeof init.body !== 'string') {
      return baseFetch(input, init)
    }

    try {
      const nextInit: RequestInit = {
        ...init,
        body: patchDeepSeekAnthropicRequestBody(init.body)
      }
      return baseFetch(input, nextInit)
    } catch {
      return baseFetch(input, init)
    }
  }
}

/** 转为 Stagehand 构造函数接受的 model 对象 */
export function buildStagehandInitModel(model: StagehandModelConfig): StagehandInitModel {
  const init: StagehandInitModel = {
    modelName: model.modelName,
    apiKey: model.apiKey
  }
  const url = model.baseURL?.trim()
  if (url) init.baseURL = url
  if (isDeepSeekStagehandTarget(model.modelName, url)) {
    init.fetch = createDeepSeekDisableThinkingFetch()
  }
  return init
}
