import { describe, expect, it, vi } from 'vitest'
import { createRetryAuditedFetch } from './anthropicClientFactory'

describe('createRetryAuditedFetch', () => {
  it('reports the measured wait before the second fetch attempt', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after-ms': '250' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const retries: unknown[] = []
    const fetch = createRetryAuditedFetch(fetchImpl, (info) => retries.push(info))
    await fetch('https://example.test', { body: 'request-1' })
    vi.setSystemTime(Date.now() + 2_000)
    await fetch('https://example.test', { body: 'request-1' })
    expect(retries).toEqual([{ attempt: 2, backoffMs: 2_000, code: 'http_429' }])
  })

  it('does not classify a later identical request as a retry after a non-retryable response', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 400 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const retries: unknown[] = []
    const fetch = createRetryAuditedFetch(fetchImpl, (info) => retries.push(info))
    await fetch('https://example.test', { body: 'same-request' })
    await fetch('https://example.test', { body: 'same-request' })
    expect(retries).toEqual([])
  })
})
