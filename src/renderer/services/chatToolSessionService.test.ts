import { describe, expect, it } from 'vitest'
import { buildToolChatPayload } from './chatToolSessionService'
import { CURRENT_SCHEMA_VERSION } from '../../shared/domainTypes'
import type { Message } from '../../shared/domainTypes'

describe('buildToolChatPayload', () => {
    const stubMessage: Message = {
      id: '00000000-0000-4000-8000-000000000001',
      sessionId: 'sess-1',
      role: 'user',
      content: 'hello',
      timestamp: 1,
      status: 'completed',
      schemaVersion: CURRENT_SCHEMA_VERSION
    }

    const assistantMessage: Message = {
      id: '00000000-0000-4000-8000-000000000002',
      sessionId: 'sess-1',
      role: 'assistant',
      content: 'hi there',
      timestamp: 2,
      status: 'completed',
      schemaVersion: CURRENT_SCHEMA_VERSION
    }

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
