import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAnthropicClient } from './anthropicClientFactory'
import { summarizeSessionContext } from './sessionContextSummary'

vi.mock('./anthropicClientFactory', () => ({ createAnthropicClient: vi.fn() }))

const messagesCreate = vi.fn()

describe('session context semantic summary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createAnthropicClient).mockReturnValue({ messages: { create: messagesCreate } } as never)
  })

  it('sends the complete shadowed transcript and parses all summary fields', async () => {
    const middleDecision = 'MIDDLE_DECISION_MUST_SURVIVE'
    messagesCreate.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ task: 'Task', decisions: middleDecision, pending: 'Next action' }) }] })
    const transcript = [
      { role: 'user' as const, content: 'beginning '.repeat(100) },
      { role: 'assistant' as const, content: `${'middle context '.repeat(40)}${middleDecision}${'ending '.repeat(40)}` }
    ]

    const result = await summarizeSessionContext({
      model: 'test-model', apiKey: 'test-key', baseUrl: 'https://example.test', locale: 'en-US', messages: transcript
    })

    expect(result).toEqual({ task: 'Task', decisions: middleDecision, pending: 'Next action' })
    expect(createAnthropicClient).toHaveBeenCalledWith('test-key', 'https://example.test')
    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'test-model',
      system: expect.stringContaining('Review every message'),
      messages: [{ role: 'user', content: JSON.stringify(transcript) }]
    }), undefined)
  })

  it('rejects malformed model output instead of allowing a truncated mechanical summary to commit', async () => {
    messagesCreate.mockResolvedValue({ content: [{ type: 'text', text: 'not JSON' }] })
    await expect(summarizeSessionContext({
      model: 'test-model', apiKey: 'test-key', locale: 'zh-CN', messages: [{ role: 'user', content: 'history' }]
    })).rejects.toThrow('SESSION_CONTEXT_SUMMARY_INVALID')
  })
})
