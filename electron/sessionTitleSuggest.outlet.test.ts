import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockCreateAnthropicClient = vi.fn()

vi.mock('./appIpc', () => ({
  readAppLocale: vi.fn(() => 'zh-CN')
}))

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicClient: (...args: unknown[]) => mockCreateAnthropicClient(...args)
}))

import { SESSION_META_TITLE_GENERATED, scheduleSessionTitleSuggestion } from './sessionTitleSuggest'
import { createMemoryAppDb } from './database/testHelpers'
import { createSession } from './database'

describe('sessionTitleSuggest 出口化（偏差 1 评审 N1）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function seedSessionWithTitleEligibility() {
    const db = createMemoryAppDb('zh-CN')
    const session = createSession(db, { name: '未命名会话' })
    return { db, sessionId: session.id }
  }

  it('生成成功后经 onTitleGenerated 回调通知，不再持有 WebContents', async () => {
    const { db, sessionId } = seedSessionWithTitleEligibility()
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        create: vi.fn(async () => ({ content: [{ type: 'text', text: '项目概况讨论' }] }))
      }
    })
    const onTitleGenerated = vi.fn()
    scheduleSessionTitleSuggestion({
      db,
      sessionId,
      model: 'claude-sonnet-4-20250514',
      messagesForApi: [
        { role: 'user', content: '帮我看看这个项目' },
        { role: 'assistant', content: '好的，这是项目概况。' },
        { role: 'user', content: '继续' }
      ],
      getApiKey: async () => 'test-key',
      onTitleGenerated
    })
    await vi.waitFor(() => {
      expect(onTitleGenerated).toHaveBeenCalledTimes(1)
    })
    const updated = onTitleGenerated.mock.calls[0]?.[0] as { id: string; name: string; metadata?: Record<string, unknown> }
    expect(updated.id).toBe(sessionId)
    expect(updated.name).toBe('项目概况讨论')
    expect(updated.metadata?.[SESSION_META_TITLE_GENERATED]).toBe(true)
  })

  it('未传 onTitleGenerated（no-op 出口）时落库完成且不抛错', async () => {
    const { db, sessionId } = seedSessionWithTitleEligibility()
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        create: vi.fn(async () => ({ content: [{ type: 'text', text: '无出口标题' }] }))
      }
    })
    expect(() =>
      scheduleSessionTitleSuggestion({
        db,
        sessionId,
        model: 'claude-sonnet-4-20250514',
        messagesForApi: [
          { role: 'user', content: '帮我看看这个项目' },
          { role: 'assistant', content: '好的，这是项目概况。' },
          { role: 'user', content: '继续' }
        ],
        getApiKey: async () => 'test-key'
      })
    ).not.toThrow()
    await vi.waitFor(async () => {
      const { getSession } = await import('./database')
      const session = getSession(db, sessionId)
      expect(session?.metadata?.[SESSION_META_TITLE_GENERATED]).toBe(true)
    })
  })
})
