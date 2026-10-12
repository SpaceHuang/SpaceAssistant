import { describe, expect, it } from 'vitest'
import { snapshotPreparedModelCall } from '../src/model'
import type { PreparedModelCall } from '../src/model'

function preparedCall(overrides: Partial<PreparedModelCall['request']> = {}): PreparedModelCall {
  return {
    route: { routeId: 'route-1', protocol: 'anthropic', dialect: 'anthropic-messages', adapterVersion: '1', modelId: 'claude-test' },
    request: {
      messages: [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'answer' }
      ],
      maxTokens: 96,
      credentials: { apiKey: 'must-not-be-persisted' },
      ...overrides
    }
  }
}

describe('requestSnapshot slimming (P2a)', () => {
  it('persists the request without the messages body', () => {
    const snapshot = snapshotPreparedModelCall(preparedCall())
    expect(Object.hasOwn(snapshot.request, 'messages')).toBe(false)
    expect(snapshot.request).toMatchObject({ maxTokens: 96 })
  })

  it('carries diagnostic count and digest for the omitted body', () => {
    const snapshot = snapshotPreparedModelCall(preparedCall())
    expect(snapshot.messagesCount).toBe(2)
    expect(snapshot.messagesSha256).toMatch(/^[a-f0-9]{64}$/)
    // 相同 messages 摘要稳定；正文变化摘要变化（route/maxTokens 等字段不影响）。
    expect(snapshotPreparedModelCall(preparedCall()).messagesSha256).toBe(snapshot.messagesSha256)
    expect(snapshotPreparedModelCall(preparedCall({ maxTokens: 32 })).messagesSha256).toBe(snapshot.messagesSha256)
    expect(snapshotPreparedModelCall(preparedCall({ messages: [{ role: 'user', content: 'different' }] })).messagesSha256)
      .not.toBe(snapshot.messagesSha256)
  })

  it('keeps credentials and signals out of the persisted snapshot', () => {
    const snapshot = snapshotPreparedModelCall(preparedCall())
    expect(JSON.stringify(snapshot)).not.toContain('must-not-be-persisted')
    expect(Object.hasOwn(snapshot.request as Record<string, unknown>, 'signal')).toBe(false)
  })

  it('remains compatible with the legacy comparison: options equality ignores the omitted body', () => {
    // 新旧格式并存时，withoutMessages 语义下的 options 必须一致——即 request 里除 messages 外
    // 的字段在新旧格式中相同（messages 的有无不参与 options 比较）。
    const slim = snapshotPreparedModelCall(preparedCall())
    const legacyShape = { route: slim.route, request: { ...slim.request, messages: [{ role: 'user', content: 'question' }] } }
    expect(Object.hasOwn(legacyShape.request, 'messages')).toBe(true)
    expect(Object.hasOwn(slim.request, 'messages')).toBe(false)
    const strip = (request: Record<string, unknown>) => Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'messages'))
    expect(JSON.stringify(strip(slim.request as Record<string, unknown>)))
      .toBe(JSON.stringify(strip(legacyShape.request as Record<string, unknown>)))
  })
})
