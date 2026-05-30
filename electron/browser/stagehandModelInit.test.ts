import { describe, expect, it, vi } from 'vitest'
import {
  buildStagehandInitModel,
  createDeepSeekDisableThinkingFetch,
  isDeepSeekStagehandTarget,
  patchDeepSeekAnthropicRequestBody,
  shouldPatchDeepSeekAnthropicMessagesUrl
} from './stagehandModelInit'

describe('isDeepSeekStagehandTarget', () => {
  it('detects deepseek in model name', () => {
    expect(isDeepSeekStagehandTarget('anthropic/deepseek-v4-pro')).toBe(true)
  })

  it('detects deepseek.com base URL', () => {
    expect(isDeepSeekStagehandTarget('anthropic/claude-sonnet-4-6', 'https://api.deepseek.com/anthropic')).toBe(
      true
    )
  })

  it('returns false for non-deepseek', () => {
    expect(isDeepSeekStagehandTarget('anthropic/claude-sonnet-4-6', 'https://api.anthropic.com')).toBe(false)
  })
})

describe('shouldPatchDeepSeekAnthropicMessagesUrl', () => {
  it('matches deepseek anthropic messages endpoint', () => {
    expect(shouldPatchDeepSeekAnthropicMessagesUrl('https://api.deepseek.com/anthropic/v1/messages')).toBe(true)
  })

  it('skips non-deepseek hosts', () => {
    expect(shouldPatchDeepSeekAnthropicMessagesUrl('https://api.anthropic.com/v1/messages')).toBe(false)
  })
})

describe('patchDeepSeekAnthropicRequestBody', () => {
  it('injects thinking disabled', () => {
    const out = patchDeepSeekAnthropicRequestBody(
      JSON.stringify({ model: 'deepseek-v4-pro', max_tokens: 4096, messages: [] })
    )
    expect(JSON.parse(out)).toMatchObject({ thinking: { type: 'disabled' } })
  })

  it('overrides enabled thinking', () => {
    const out = patchDeepSeekAnthropicRequestBody(
      JSON.stringify({ thinking: { type: 'enabled' }, messages: [] })
    )
    expect(JSON.parse(out).thinking).toEqual({ type: 'disabled' })
  })
})

describe('createDeepSeekDisableThinkingFetch', () => {
  it('patches JSON body for deepseek messages requests', async () => {
    const baseFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true, body: init?.body }), { status: 200 })
    })
    const wrapped = createDeepSeekDisableThinkingFetch(baseFetch as typeof fetch)

    await wrapped('https://api.deepseek.com/anthropic/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] })
    })

    expect(baseFetch).toHaveBeenCalledOnce()
    const sentBody = (baseFetch.mock.calls[0][1] as RequestInit).body as string
    expect(JSON.parse(sentBody).thinking).toEqual({ type: 'disabled' })
  })

  it('does not patch anthropic.com requests', async () => {
    const baseFetch = vi.fn(async () => new Response('ok'))
    const wrapped = createDeepSeekDisableThinkingFetch(baseFetch as typeof fetch)
    const body = JSON.stringify({ model: 'claude', messages: [] })

    await wrapped('https://api.anthropic.com/v1/messages', { method: 'POST', body })

    expect((baseFetch.mock.calls[0][1] as RequestInit).body).toBe(body)
  })
})

describe('buildStagehandInitModel', () => {
  it('adds disable-thinking fetch for deepseek', () => {
    const init = buildStagehandInitModel({
      modelName: 'anthropic/deepseek-v4-pro',
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com/anthropic'
    })
    expect(init.fetch).toBeTypeOf('function')
  })

  it('omits fetch for claude on anthropic', () => {
    const init = buildStagehandInitModel({
      modelName: 'anthropic/claude-sonnet-4-6',
      apiKey: 'sk-test',
      baseURL: 'https://api.anthropic.com'
    })
    expect(init.fetch).toBeUndefined()
  })
})
