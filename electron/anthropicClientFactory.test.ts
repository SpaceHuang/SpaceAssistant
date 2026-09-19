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
    // backoffMs 来自 Date.now() 实测等待时长：跨毫秒进位会 +1（满载下更明显），用容差断言
    expect(retries).toEqual([
      { attempt: 2, backoffMs: expect.any(Number), code: 'http_429' }
    ])
    expect((retries[0] as { backoffMs: number }).backoffMs).toBeGreaterThanOrEqual(2_000)
    expect((retries[0] as { backoffMs: number }).backoffMs).toBeLessThan(2_100)
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
