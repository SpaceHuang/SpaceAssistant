import { describe, expect, it } from 'vitest'
import { buildToolChatPayload } from './chatToolSessionService'
import type { Message } from '../../shared/domainTypes'
import { assistantMessage as assistantMessageFactory, userMessage } from '../../test/factories/message'

describe('buildToolChatPayload', () => {
    const stubMessage: Message = userMessage({ id: '00000000-0000-4000-8000-000000000001', sessionId: 'sess-1', content: 'hello', timestamp: 1, status: 'completed' })

    const assistantReply: Message = assistantMessageFactory({ id: '00000000-0000-4000-8000-000000000002', sessionId: 'sess-1', content: 'hi there', timestamp: 2, status: 'completed' })

  it('includes locale in payload when provided', () => {
    const payload = buildToolChatPayload({
      requestId: '00000000-0000-4000-8000-000000000003',
      sessionId: 'sess-1',
      turnId: 'turn-locale',
      turnStartToken: 'token-locale'
    })
    expect(payload).not.toHaveProperty('locale')
  })

  it('does not submit renderer-owned message history to execute-turn', () => {
    const payload = buildToolChatPayload({
      requestId: '00000000-0000-4000-8000-000000000004',
      sessionId: 'sess-1',
      turnId: 'turn-history',
      turnStartToken: 'token-history'
    })
    expect(payload).not.toHaveProperty('sourceMessages')
    expect(payload).not.toHaveProperty('currentUserMessageId')
  })

  it('turn execute payload 只提交执行凭据，不允许 renderer 重交模型或 endpoint', () => {
    const payload = buildToolChatPayload({
      requestId: 'execute-request', sessionId: 'sess-1', turnId: 'turn-1', turnStartToken: 'token-1'
    })

    expect(payload).toEqual({ requestId: 'execute-request', sessionId: 'sess-1', turnId: 'turn-1', turnStartToken: 'token-1' })
  })
})
