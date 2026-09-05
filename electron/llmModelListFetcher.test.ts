import { describe, expect, it, vi } from 'vitest'
import {
  fetchServiceModels,
  normalizeModelsEndpoint,
  parseModelListBody,
  MAX_FETCHED_MODELS
} from './llmModelListFetcher'

describe('normalizeModelsEndpoint', () => {
  it('falls back to Anthropic official endpoint when baseUrl is empty', () => {
    expect(normalizeModelsEndpoint(undefined)).toBe('https://api.anthropic.com/v1/models')
    expect(normalizeModelsEndpoint('')).toBe('https://api.anthropic.com/v1/models')
    expect(normalizeModelsEndpoint('  ')).toBe('https://api.anthropic.com/v1/models')
  })

  it('appends /v1/models when baseUrl has no /v1 suffix', () => {
    expect(normalizeModelsEndpoint('https://api.kimi.com/coding/')).toBe('https://api.kimi.com/coding/v1/models')
    expect(normalizeModelsEndpoint('https://ark.cn-beijing.volces.com/api/coding')).toBe(
      'https://ark.cn-beijing.volces.com/api/coding/v1/models'
    )
  })

  it('appends only /models when baseUrl already ends with /v1', () => {
    expect(normalizeModelsEndpoint('https://example.com/v1')).toBe('https://example.com/v1/models')
    expect(normalizeModelsEndpoint('https://example.com/v1/')).toBe('https://example.com/v1/models')
  })
})

describe('parseModelListBody', () => {
  it('parses Anthropic-style response with display_name', () => {
    const body = {
      data: [
        { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2025-01-01' },
        { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' }
      ],
      has_more: false
    }
    expect(parseModelListBody(body)).toEqual([
      { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' }
    ])
  })

  it('parses OpenAI-style response', () => {
    const body = { data: [{ id: 'gpt-5.5', object: 'model' }, { id: 'kimi-k2.7-code' }] }
    expect(parseModelListBody(body)).toEqual([
      { id: 'gpt-5.5', displayName: undefined },
      { id: 'kimi-k2.7-code', displayName: undefined }
    ])
  })

  it('returns empty array for empty data', () => {
    expect(parseModelListBody({ data: [] })).toEqual([])
  })

  it('returns null for malformed bodies', () => {
    expect(parseModelListBody(null)).toBeNull()
    expect(parseModelListBody({})).toBeNull()
    expect(parseModelListBody({ data: 'nope' })).toBeNull()
    expect(parseModelListBody([{ id: 'x' }])).toBeNull()
  })

  it('skips entries without a string id and ignores blank ids', () => {
    const body = { data: [{ id: 'ok' }, { name: 'no-id' }, { id: '' }, { id: 42 }] }
    expect(parseModelListBody(body)).toEqual([{ id: 'ok', displayName: undefined }])
  })
})

function mockResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('fetchServiceModels', () => {
  it('sends dual auth headers and parses a successful response', async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse(200, { data: [{ id: 'm1', display_name: 'M One' }, { id: 'm2' }] })
    )
    const result = await fetchServiceModels({
      baseUrl: 'https://api.kimi.com/coding/',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })
    expect(result).toEqual({ ok: true, models: [{ id: 'm1', displayName: 'M One' }, { id: 'm2', displayName: undefined }], truncated: false })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.kimi.com/coding/v1/models?limit=100')
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-test')
    expect(headers['Authorization']).toBe('Bearer sk-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  it('classifies 401/403 as unauthorized without parsing the error body', async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn(async () => mockResponse(status, { error: { message: 'bad key', type: 'auth' } }))
      const result = await fetchServiceModels({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
      expect(result).toEqual({ ok: false, error: 'unauthorized', status })
    }
  })

  it('classifies 404 as not-found', async () => {
    const fetchImpl = vi.fn(async () => mockResponse(404, {}))
    const result = await fetchServiceModels({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result).toEqual({ ok: false, error: 'not-found', status: 404 })
  })

  it('classifies other non-2xx statuses as network', async () => {
    const fetchImpl = vi.fn(async () => mockResponse(500, {}))
    const result = await fetchServiceModels({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result).toEqual({ ok: false, error: 'network', status: 500 })
  })

  it('classifies abort as timeout', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation was aborted', 'AbortError')
    })
    const result = await fetchServiceModels({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result).toEqual({ ok: false, error: 'timeout' })
  })

  it('classifies connection failure as network', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const result = await fetchServiceModels({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result).toEqual({ ok: false, error: 'network' })
  })

  it('classifies 2xx with unparseable structure as invalid-response', async () => {
    const fetchImpl = vi.fn(async () => mockResponse(200, { models: ['m1'] }))
    const result = await fetchServiceModels({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result).toEqual({ ok: false, error: 'invalid-response' })
  })

  it('classifies non-JSON 2xx body as invalid-response', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>ok</html>', { status: 200 }))
    const result = await fetchServiceModels({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result).toEqual({ ok: false, error: 'invalid-response' })
  })

  it('treats an empty list as success with zero models', async () => {
    const fetchImpl = vi.fn(async () => mockResponse(200, { data: [] }))
    const result = await fetchServiceModels({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result).toEqual({ ok: true, models: [], truncated: false })
  })

  it(`truncates to ${MAX_FETCHED_MODELS} models and flags it`, async () => {
    const data = Array.from({ length: MAX_FETCHED_MODELS + 50 }, (_, i) => ({ id: `m${i}` }))
    const fetchImpl = vi.fn(async () => mockResponse(200, { data }))
    const result = await fetchServiceModels({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.models).toHaveLength(MAX_FETCHED_MODELS)
      expect(result.truncated).toBe(true)
    }
  })

  it('follows has_more pagination via after_id until complete', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { data: [{ id: 'm1' }, { id: 'm2' }], has_more: true, last_id: 'm2' }))
      .mockResolvedValueOnce(mockResponse(200, { data: [{ id: 'm3' }], has_more: false, last_id: 'm3' }))
    const result = await fetchServiceModels({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const secondUrl = (fetchImpl.mock.calls[1] as unknown as [string])[0]
    expect(secondUrl).toContain('after_id=m2')
    expect(result).toEqual({
      ok: true,
      models: [
        { id: 'm1', displayName: undefined },
        { id: 'm2', displayName: undefined },
        { id: 'm3', displayName: undefined }
      ],
      truncated: false
    })
  })

  it('flags truncated when pages are exhausted while has_more remains true', async () => {
    const page = () => mockResponse(200, { data: [{ id: 'x' }], has_more: true, last_id: 'x' })
    const fetchImpl = vi.fn(async () => page())
    const result = await fetchServiceModels({ apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.truncated).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(10)
  })
})
