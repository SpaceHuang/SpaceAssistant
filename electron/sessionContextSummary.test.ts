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
    messagesCreate.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ task: 'Task', completed: 'Earlier work', decisions: middleDecision, constraints: 'Keep IDs', pending: 'Next action', blockers: 'None', nextStep: 'Continue' }) }] })
    const transcript = [
      { role: 'user' as const, content: 'beginning '.repeat(100) },
      { role: 'assistant' as const, content: `${'middle context '.repeat(40)}${middleDecision}${'ending '.repeat(40)}` }
    ]

    const result = await summarizeSessionContext({
      model: 'test-model', apiKey: 'test-key', baseUrl: 'https://example.test', locale: 'en-US', messages: transcript
    })

    expect(result).toEqual({ task: 'Task', completed: 'Earlier work', decisions: middleDecision, constraints: 'Keep IDs', pending: 'Next action', blockers: 'None', nextStep: 'Continue' })
    expect(createAnthropicClient).toHaveBeenCalledWith('test-key', 'https://example.test')
    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'test-model',
      system: expect.stringContaining('Review every message'),
      messages: [{ role: 'user', content: JSON.stringify(transcript) }]
    }), undefined)
  })

  it('passes canonical recovery facts separately from quoted transcript prose', async () => {
    const recoveryFacts = { unresolvedEffects: [{ id: 'origin:tool-1', originInvocationId: 'origin', toolCallId: 'tool-1' }], toolOutcomes: [] }
    messagesCreate.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ task: 'Task', completed: 'Done', decisions: 'Decision', constraints: 'Constraint', pending: 'Pending', blockers: 'Blocker', nextStep: 'Next' }) }] })
    await summarizeSessionContext({ model: 'test-model', apiKey: 'test-key', locale: 'zh-CN', messages: [{ role: 'assistant', content: '副作用已经完成' }], recoveryFacts })
    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({ messages: [{ role: 'user', content: JSON.stringify({ messages: [{ role: 'assistant', content: '副作用已经完成' }], recoveryFacts }) }] }), undefined)
  })

  it('rejects malformed model output instead of allowing a truncated mechanical summary to commit', async () => {
    messagesCreate.mockResolvedValue({ content: [{ type: 'text', text: 'not JSON' }] })
    await expect(summarizeSessionContext({
      model: 'test-model', apiKey: 'test-key', locale: 'zh-CN', messages: [{ role: 'user', content: 'history' }]
    })).rejects.toThrow('SESSION_CONTEXT_SUMMARY_INVALID')
  })
})
