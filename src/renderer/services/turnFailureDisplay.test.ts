import { describe, expect, it } from 'vitest'
import type { Message } from '../../shared/domainTypes'
import { resolveFailureReasonForMessage } from './turnFailureDisplay'

function failedMessage(over: Partial<Message> = {}): Message {
  return {
    id: 'a1',
    sessionId: 's1',
    role: 'assistant',
    content: '',
    timestamp: 1,
    status: 'failed',
    schemaVersion: 1,
    ...over
  }
}

describe('resolveFailureReasonForMessage', () => {
  it('命中同会话同消息的失败原因', () => {
    expect(
      resolveFailureReasonForMessage({ s1: { messageId: 'a1', reason: '未知模型「x」' } }, failedMessage())
    ).toBe('未知模型「x」')
  })

  it('messageId 不一致时不串到其它气泡', () => {
    expect(
      resolveFailureReasonForMessage({ s1: { messageId: 'a2', reason: '旧原因' } }, failedMessage())
    ).toBeUndefined()
  })

  it('会话不一致时不展示', () => {
    expect(
      resolveFailureReasonForMessage({ s2: { messageId: 'a1', reason: 'r' } }, failedMessage())
    ).toBeUndefined()
  })

  it('非失败消息不展示', () => {
    expect(
      resolveFailureReasonForMessage({ s1: { messageId: 'a1', reason: 'r' } }, failedMessage({ status: 'completed' }))
    ).toBeUndefined()
  })
})
