import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSafeDiscoveryFetch } from './discoveryPolicyFetch'

/**
 * OAuth discovery 策略 fetch 的判定矩阵（评审追加：allowPrivateNetwork 透传）。
 * 私网目标在 fetch 发起前被合成 403 拦截；开关显式开启时放行到真实 fetch 层。
 */

const fetchMock = vi.fn(async () => new Response(null, { status: 404 }))

afterEach(() => {
  fetchMock.mockClear()
  vi.unstubAllGlobals()
})

describe('createSafeDiscoveryFetch', () => {
  it('blocks private targets with a synthetic 403 before any network I/O (default)', async () => {
    vi.stubGlobal('fetch', fetchMock)
    const fetchFn = createSafeDiscoveryFetch()
    const response = await fetchFn('https://10.154.200.32/.well-known/oauth-protected-resource')
    expect(response.status).toBe(403)
    expect(response.statusText).toBe('endpoint policy blocked')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still validates loopback and public targets through to the network layer', async () => {
    vi.stubGlobal('fetch', fetchMock)
    const fetchFn = createSafeDiscoveryFetch()
    const ok = await fetchFn('https://example.com/.well-known/oauth-protected-resource')
    expect(ok.status).toBe(404)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('allowPrivateNetwork lets private targets reach the network layer', async () => {
    vi.stubGlobal('fetch', fetchMock)
    const fetchFn = createSafeDiscoveryFetch(undefined, undefined, { allowPrivateNetwork: true })
    const response = await fetchFn('https://10.154.200.32/.well-known/oauth-protected-resource')
    expect(response.status).toBe(404)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]![0])).toContain('10.154.200.32')
  })

  it('intercepts redirects to private targets even from allowed origins, and honors the toggle', async () => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://example.com/start') {
        return new Response(null, { status: 302, headers: { Location: 'https://10.154.200.32/next' } })
      }
      return new Response(null, { status: 200 })
    })
    const blocked: URL[] = []
    const blockedFn = createSafeDiscoveryFetch(undefined, (target) => blocked.push(target))
    const blockedResponse = await blockedFn('https://example.com/start')
    expect(blockedResponse.status).toBe(403)
    expect(blocked).toHaveLength(1)

    const allowedFn = createSafeDiscoveryFetch(undefined, undefined, { allowPrivateNetwork: true })
    const allowedResponse = await allowedFn('https://example.com/start')
    expect(allowedResponse.status).toBe(200)
  })
})
