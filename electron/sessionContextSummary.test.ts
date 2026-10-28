import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAnthropicClient } from './anthropicClientFactory'
import { SessionContextSummaryCache, sessionContextSummaryCacheKey, summarizeSessionContext, waitForSessionContextSummary } from './sessionContextSummary'

vi.mock('./anthropicClientFactory', () => ({ createAnthropicClient: vi.fn() }))

const messagesCreate = vi.fn()

describe('session context semantic summary', () => {
  it('scopes reusable model summaries to session, model, service, locale, prompt version, and transcript', () => {
    const base = { sessionId: 's1', model: 'm1', serviceId: 'svc1', locale: 'zh-CN' as const, messages: [{ role: 'user' as const, content: 'history' }] }
    const key = sessionContextSummaryCacheKey(base)
    expect(sessionContextSummaryCacheKey({ ...base, sessionId: 's2' })).not.toBe(key)
    expect(sessionContextSummaryCacheKey({ ...base, serviceId: 'svc2' })).not.toBe(key)
    expect(sessionContextSummaryCacheKey({ ...base, messages: [{ role: 'user', content: 'changed' }] })).not.toBe(key)
    expect(sessionContextSummaryCacheKey({ ...base, model: 'm2' })).not.toBe(key)
    expect(sessionContextSummaryCacheKey({ ...base, locale: 'en-US' })).not.toBe(key)
  })

  it('caches only committed or no-gain valid summaries and allows retry after every discarded outcome', () => {
    const cache = new SessionContextSummaryCache(2)
    const summary = { task: 'Task', completed: 'Done', decisions: 'Decision', constraints: 'Constraint', pending: 'Pending', blockers: 'None', nextStep: 'Continue' }
    cache.settle('stale', summary, 'stale')
    cache.settle('cancelled', summary, 'cancelled')
    cache.settle('failed', summary, 'failed')
    expect(cache.get('stale')).toBeUndefined()
    expect(cache.get('cancelled')).toBeUndefined()
    expect(cache.get('failed')).toBeUndefined()
    cache.settle('committed', summary, 'committed')
    cache.settle('no-gain', summary, 'no-gain')
    expect(cache.get('committed')).toEqual(summary)
    expect(cache.get('no-gain')).toEqual(summary)
    cache.settle('next', summary, 'committed')
    expect(cache.get('committed')).toBeUndefined()
    expect(cache.get('next')).toEqual(summary)
  })

  it('stops waiting on parent cancellation even when summary work ignores abort and resolves late', async () => {
    const controller = new AbortController()
    let resolveLate!: (value: string) => void
    const work = new Promise<string>((resolve) => { resolveLate = resolve })
    const waiting = waitForSessionContextSummary(work, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toThrow('SESSION_CONTEXT_SUMMARY_CANCELLED')
    resolveLate('late success')
    await expect(waiting).rejects.toThrow('SESSION_CONTEXT_SUMMARY_CANCELLED')
  })

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

  it('sends an oversized shadowed transcript in one summary call without entering a recursive compaction path', async () => {
    const oversizedTranscript = [{ role: 'user' as const, content: 'oversized history '.repeat(20_000) }]
    messagesCreate.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ task: 'Task', completed: 'Done', decisions: 'Decision', constraints: 'Constraint', pending: 'Pending', blockers: 'None', nextStep: 'Continue' }) }] })

    await summarizeSessionContext({ model: 'test-model', apiKey: 'test-key', locale: 'en-US', messages: oversizedTranscript })

    expect(messagesCreate).toHaveBeenCalledOnce()
    expect(messagesCreate.mock.calls[0]?.[0]).toMatchObject({ messages: [{ role: 'user', content: JSON.stringify(oversizedTranscript) }] })
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
