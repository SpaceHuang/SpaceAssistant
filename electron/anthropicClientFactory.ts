import Anthropic from '@anthropic-ai/sdk'

export type AnthropicRetryInfo = { attempt: number; backoffMs: number; code: string }

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
}

export function createRetryAuditedFetch(fetchImpl: typeof fetch, onRetry?: (info: AnthropicRetryInfo) => void | Promise<void>): typeof fetch {
  let lastRequestKey = ''
  let attempt = 0
  let lastCode = 'network_error'
  let lastAttemptFinishedAt: number | undefined
  return async (input, init) => {
    const requestKey = typeof init?.body === 'string' ? init.body : String(input)
    if (requestKey !== lastRequestKey) {
      lastRequestKey = requestKey
      attempt = 0
      lastCode = 'network_error'
      lastAttemptFinishedAt = undefined
    }
    attempt += 1
    if (attempt > 1) {
      const backoffMs = lastAttemptFinishedAt === undefined ? 0 : Math.max(0, Date.now() - lastAttemptFinishedAt)
      await onRetry?.({ attempt, backoffMs, code: lastCode })
    }
    try {
      const response = await fetchImpl(input, init)
      if (!response.ok) {
        lastCode = `http_${response.status}`
      }
      lastAttemptFinishedAt = Date.now()
      if (response.ok || !isRetryableStatus(response.status)) {
        lastRequestKey = ''
        attempt = 0
        lastCode = 'network_error'
        lastAttemptFinishedAt = undefined
      }
      return response
    } catch (error) {
      lastCode = error instanceof Error ? error.name : 'network_error'
      lastAttemptFinishedAt = Date.now()
      throw error
    }
  }
}

export function createAnthropicClient(apiKey: string, baseURL?: string, options?: { onRetry?: (info: AnthropicRetryInfo) => void | Promise<void> }): Anthropic {
  const fetchWithRetryAudit = createRetryAuditedFetch(globalThis.fetch, options?.onRetry)
  const config = { apiKey, ...(baseURL ? { baseURL } : {}), ...(options ? { fetch: fetchWithRetryAudit } : {}) }
  return new Anthropic(config)
}
