import { afterEach, describe, expect, it } from 'vitest'
import {
  bindAgentLogErrorDeps,
  buildAgentLogErrorFields,
  errorDetailForLog,
  extractDevErrorDetail
} from './agentLogError'
import { isAgentLogProductionMode } from './agentLogPaths'

describe('agent log error fields', () => {
  afterEach(() => {
    bindAgentLogErrorDeps(() => null)
  })

  it('isAgentLogProductionMode follows packaged flag', () => {
    expect(isAgentLogProductionMode(true)).toBe(true)
    expect(isAgentLogProductionMode(false)).toBe(false)
  })

  it('production mode logs only user message', () => {
    bindAgentLogErrorDeps(() => ({ isPackaged: true }))
    const err = new Error('secret stack')
    err.stack = 'Error: secret stack\n    at E:\\app\\node_modules\\x.js:1:1'
    const fields = buildAgentLogErrorFields(err, '用户可见错误')
    expect(fields).toEqual({ error: '用户可见错误' })
  })

  it('dev mode logs full detail and userError', () => {
    bindAgentLogErrorDeps(() => ({ isPackaged: false }))
    const err = new Error('technical')
    err.stack = 'Error: technical\n    at foo.js:2:3'
    const fields = buildAgentLogErrorFields(err, '用户可见错误')
    expect(fields.error).toContain('technical')
    expect(fields.userError).toBe('用户可见错误')
  })

  it('errorDetailForLog prefers stack', () => {
    const err = new Error('boom')
    err.stack = 'Error: boom\n    at x'
    expect(errorDetailForLog(err)).toContain('at x')
  })

  it('dev mode includes APICallError responseBody in errorDetail', () => {
    bindAgentLogErrorDeps(() => ({ isPackaged: false }))
    const err = new Error('Bad Request') as Error & {
      url: string
      statusCode: number
      responseBody: string
      requestBodyValues: { model: string; messages: { role: string; content: string }[] }
      responseHeaders: Record<string, string>
    }
    err.name = 'AI_APICallError'
    err.url = 'https://api.deepseek.com/anthropic/v1/messages?api_key=sk-secret'
    err.statusCode = 400
    err.responseBody = JSON.stringify({ error: { type: 'invalid_request', message: 'unknown field' } })
    err.responseHeaders = { authorization: 'Bearer sk-ant-abc', 'content-type': 'application/json' }
    err.requestBodyValues = {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'x'.repeat(2000) }]
    }

    const fields = buildAgentLogErrorFields(err, '分析页面元素失败')
    expect(fields.errorDetail).toBeDefined()
    expect(fields.errorDetail?.kind).toBe('api_call')
    expect(fields.errorDetail?.statusCode).toBe(400)
    expect(fields.errorDetail?.responseBodyJson).toEqual({
      error: { type: 'invalid_request', message: 'unknown field' }
    })
    expect(String(fields.errorDetail?.url)).not.toContain('sk-secret')
    expect(fields.errorDetail?.responseHeaders).toMatchObject({
      authorization: '[REDACTED]',
      'content-type': 'application/json'
    })
    const req = fields.errorDetail?.requestBody as Record<string, unknown>
    expect(req.messageCount).toBe(1)
    const msg0 = (req.messages as { content: string }[])[0]
    expect(msg0.content).toContain('[truncated')
  })

  it('extractDevErrorDetail returns undefined in production', () => {
    bindAgentLogErrorDeps(() => ({ isPackaged: true }))
    const err = Object.assign(new Error('x'), { url: 'https://example.com' })
    expect(extractDevErrorDetail(err)).toBeUndefined()
  })

  it('extractDevErrorDetail walks error cause chain', () => {
    bindAgentLogErrorDeps(() => ({ isPackaged: false }))
    const inner = Object.assign(new Error('inner'), {
      url: 'https://api.example.com/v1/messages',
      statusCode: 502,
      responseBody: 'bad gateway'
    })
    inner.name = 'AI_APICallError'
    const outer = new Error('outer')
    outer.cause = inner

    const detail = extractDevErrorDetail(outer)
    expect(detail?.errorChain).toHaveLength(2)
    expect((detail?.errorChain as { kind: string }[])[0]?.kind).toBe('error')
    expect((detail?.errorChain as { statusCode: number }[])[1]?.statusCode).toBe(502)
  })
})
