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
      resolveFailureReasonForMessage({ a1: '未知模型「x」' }, failedMessage())
    ).toBe('未知模型「x」')
  })

  it('messageId 不一致时不串到其它气泡', () => {
    expect(
      resolveFailureReasonForMessage({ a2: '旧原因' }, failedMessage())
    ).toBeUndefined()
  })

  it('同一会话的多条失败消息各保留自己的原因', () => {
    const failures = { a1: '第一条原因', a2: '第二条原因' }
    expect(resolveFailureReasonForMessage(failures, failedMessage({ id: 'a1' }))).toBe('第一条原因')
    expect(resolveFailureReasonForMessage(failures, failedMessage({ id: 'a2' }))).toBe('第二条原因')
  })

  it('其它会话的失败消息不展示', () => {
    expect(
      resolveFailureReasonForMessage({ b1: 'r' }, failedMessage({ id: 'a1' }))
    ).toBeUndefined()
  })

  it('非失败消息不展示', () => {
    expect(
      resolveFailureReasonForMessage({ a1: 'r' }, failedMessage({ status: 'completed' }))
    ).toBeUndefined()
  })

  it('空白原因视为没有原因', () => {
    expect(resolveFailureReasonForMessage({ a1: '   ' }, failedMessage())).toBeUndefined()
  })
})
