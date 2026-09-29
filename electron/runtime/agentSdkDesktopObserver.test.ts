import { describe, expect, it, vi } from 'vitest'
import type { AgentTurnObserver } from '../../packages/agent-sdk/src/turn'
import { createAgentSdkDesktopObserver } from './agentSdkDesktopObserver'
import { buildRequestHeaderPayload } from '../../src/shared/requestContext'
import { estimateTokensFromToolResults } from '../../src/shared/contextUsageEstimate'
import { projectRequestHeaderForWindow } from './requestHeaderProjection'
import { reduceAssistantFact, type AssistantFactEvent } from '../../src/shared/assistantFactAggregator'
import { buildAssistantActivityTimeline } from '../../src/shared/assistantActivityTimeline'
import type { Message } from '../../src/shared/domainTypes'

describe('createAgentSdkDesktopObserver', () => {
  it('writes request headers for the first and follow-up Hosted model turns', async () => {
    const emitSessionEvent = vi.fn()
    const observer = createAgentSdkDesktopObserver({ requestId: 'r', sessionId: 's', turnId: 't', emitSessionEvent, model: 'claude-test', contextWindow: 1000, windowId: 'projection-window' })
    const request = {
      messages: [
        { role: 'system' as const, content: 'system prompt' },
        { role: 'user' as const, content: 'hello' },
        { role: 'assistant' as const, content: 'tool work' },
        { role: 'tool' as const, toolCallId: 'tc-1', content: 'result', isError: false }
      ],
      maxTokens: 200,
      tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object' } }]
    }

    const requiredUserMessage = { id: 'user-1', message: { role: 'user' as const, content: 'hello' } }
    await observer.onModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route', request, currentUserMessageId: requiredUserMessage.id, requiredUserMessage })
    expect(emitSessionEvent.mock.calls.map(([event]) => event.type)).toEqual(['request_header', 'request_context'])
    expect(emitSessionEvent.mock.calls[0]?.[0].payload).toMatchObject({ requestId: 'r:round:1', requiredSurfaceSet: ['user-1'] })
    await observer.onModelRequest?.({ modelTurn: 2, attempt: 1, routeId: 'route', request, currentUserMessageId: requiredUserMessage.id, requiredUserMessage })

    expect(emitSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'request_header',
      payload: expect.objectContaining({
        requestId: 'r:round:2', system: undefined, requiredSurfaceSet: ['user-1'],
        toolExecutionCheckpoint: { completedToolUseIds: ['tc-1'], replayForbidden: false },
        tools: undefined
      })
    }))
    expect(emitSessionEvent.mock.calls.map(([event]) => event.type)).toEqual(['request_header', 'request_context', 'request_header', 'request_context'])
    expect(emitSessionEvent.mock.calls[3]?.[0].payload).toMatchObject({ requestId: 'r:round:2', model: 'claude-test', contextWindow: { tokens: 1000, source: 'config' } })
  })

  it('shares header fingerprints with the legacy projection lane for the same window', async () => {
    const windowId = `shared-window-${Date.now()}`
    const first = createAgentSdkDesktopObserver({ requestId: 'hosted', sessionId: 's', turnId: 't', windowId })
    await first.onModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route', request: {
      messages: [{ role: 'system', content: 'stable-system' }, { role: 'user', content: 'hello' }],
      maxTokens: 100, tools: []
    } })
    const legacyHeader = buildRequestHeaderPayload({
      requestId: 'legacy-followup', system: 'stable-system', tools: [], messages: [{ role: 'user', content: 'hello' }]
    })
    const projectedLegacyHeader = projectRequestHeaderForWindow(windowId, legacyHeader)
    expect(projectedLegacyHeader.system).toBeUndefined()
    expect(projectedLegacyHeader.tools).toBeUndefined()
  })

  it('uses request identity rather than session identity as the fallback cache domain', async () => {
    const firstEvents = vi.fn()
    const secondEvents = vi.fn()
    const request = { messages: [{ role: 'system' as const, content: 'stable-system' }, { role: 'user' as const, content: 'hello' }], maxTokens: 100, tools: [] }
    const first = createAgentSdkDesktopObserver({ requestId: `request-a-${Date.now()}`, sessionId: 'shared-session', turnId: 't-a', emitSessionEvent: firstEvents })
    const second = createAgentSdkDesktopObserver({ requestId: `request-b-${Date.now()}`, sessionId: 'shared-session', turnId: 't-b', emitSessionEvent: secondEvents })
    await first.onModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route', request })
    await second.onModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route', request })

    expect(firstEvents.mock.calls[0]?.[0].payload).toMatchObject({ system: 'stable-system' })
    expect(secondEvents.mock.calls[0]?.[0].payload).toMatchObject({ system: 'stable-system' })
  })

  it('stages Remote assistant chunks until the entire Hosted turn succeeds', async () => {
    const facts: unknown[] = []
    const observer = createAgentSdkDesktopObserver({
      requestId: 'remote-staged-request', sessionId: 'remote-session', turnId: 'remote-turn',
      stageAssistantContentUntilTurnFinished: true, emitFactEvent: (event) => facts.push(event)
    })
    const typed = observer as Required<Pick<AgentTurnObserver, 'onModelRequest' | 'onModelChunk' | 'onModelResponseCommitted' | 'onTurnOutputReady' | 'onTurnFinished'>>
    await observer.prepareModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route', request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 100, tools: [] } })
    await typed.onModelChunk({ type: 'text-delta', text: 'intermediate tool explanation' })
    await typed.onModelChunk({ type: 'thinking-delta', text: 'private reasoning' })
    await typed.onModelResponseCommitted({
      modelTurn: 1, finishReason: 'tool-calls', usage: { type: 'usage', inputTokens: 2, outputTokens: 1 },
      message: { role: 'assistant', content: [{ type: 'text', text: 'intermediate tool explanation' }], toolCalls: [{ id: 'tool-1', name: 'lookup', input: {} }] }
    })

    expect(facts).not.toContainEqual(expect.objectContaining({ type: 'content-delta' }))
    expect(facts).not.toContainEqual(expect.objectContaining({ type: 'thinking-delta' }))
    expect(facts).not.toContainEqual({ type: 'preview-commit' })
    await typed.onModelRequest({ modelTurn: 2, attempt: 1, routeId: 'route', request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 100, tools: [] } })
    await typed.onModelChunk({ type: 'text-delta', text: 'final answer' })
    await typed.onModelResponseCommitted({
      modelTurn: 2, finishReason: 'stop', usage: { type: 'usage', inputTokens: 2, outputTokens: 1 },
      message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }] }
    })
    expect(facts).not.toContainEqual(expect.objectContaining({ type: 'content-reconciled' }))
    expect(facts).toContainEqual({ type: 'tool-use', id: 'tool-1', toolName: 'lookup', input: {} })
    const result = { text: 'intermediate tool explanationfinal answer', messages: [], modelTurns: 2, finishReason: 'stop' as const, usage: { inputTokens: 3, outputTokens: 2 } }
    await typed.onTurnOutputReady(result)
    await typed.onTurnFinished(result)

    expect(facts).toEqual(expect.arrayContaining([
      { type: 'tool-use', id: 'tool-1', toolName: 'lookup', input: {} },
      { type: 'content-reconciled', text: 'intermediate tool explanationfinal answer' }
    ]))
  })

  it('does not project a required surface id without an exact canonical user-message binding', async () => {
    const emitSessionEvent = vi.fn()
    const observer = createAgentSdkDesktopObserver({ requestId: 'r', sessionId: 's', turnId: 't', emitSessionEvent })
    await observer.onModelRequest?.({
      modelTurn: 1, attempt: 1, routeId: 'route', currentUserMessageId: 'missing-user-id',
      request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 100, tools: [] }
    })
    expect(emitSessionEvent.mock.calls[0]?.[0].payload).toMatchObject({ requiredSurfaceSet: [] })
  })

  it('re-anchors the accepted response usage and final surface in the request context ledger', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const facts: unknown[] = []
    const observer = createAgentSdkDesktopObserver({
      requestId: 'r', sessionId: 's', turnId: 't', model: 'claude-test', contextWindow: 1000,
      emitSessionEvent: (event) => events.push(event as { type: string; payload: Record<string, unknown> }),
      emitFactEvent: (event) => facts.push(event)
    })
    await observer.onModelRequest?.({ modelTurn: 2, attempt: 1, routeId: 'route', request: {
      messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
      maxTokens: 100, tools: []
    } })
    await observer.onModelResponseCommitted?.({
      modelTurn: 2, finishReason: 'stop', usage: { type: 'usage', inputTokens: 80, outputTokens: 5, cacheReadInputTokens: 20 },
      message: { role: 'assistant', content: 'done' }
    })

    const contexts = events.filter((event) => event.type === 'request_context')
    expect(contexts).toHaveLength(2)
    expect(contexts[1]?.payload).toMatchObject({
      requestId: 'r:round:2',
      contextUsage: { pressureTokens: 100 },
      planningStatus: 'fits_without_headroom'
    })
    expect(facts.find((fact) => (fact as { type?: string }).type === 'context-projection-updated')).toMatchObject({ type: 'context-projection-updated', projection: { pressureTokens: 100, projectedTokens: expect.any(Number), anchorStatus: 'matched' } })
  })

  it('projects tool-result usage before the next Hosted request without changing provider-attempt usage', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const facts: unknown[] = []
    const observer = createAgentSdkDesktopObserver({
      requestId: 'tool-projection', sessionId: 's', turnId: 't', model: 'claude-test', contextWindow: 100_000,
      emitSessionEvent: (event) => events.push(event as { type: string; payload: Record<string, unknown> }),
      emitFactEvent: (event) => facts.push(event)
    })
    const requestOne = {
      messages: [{ role: 'system' as const, content: 'system' }, { role: 'user' as const, content: 'read file' }],
      maxTokens: 100, tools: [{ name: 'read_file', description: 'read file', inputSchema: { type: 'object' } }]
    }
    await observer.onModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route', request: requestOne })
    await observer.onModelResponseCommitted?.({
      modelTurn: 1, finishReason: 'tool-calls', usage: { type: 'usage', inputTokens: 1000, outputTokens: 50 },
      message: { role: 'assistant', toolCalls: [{ id: 'tool-1', name: 'read_file', input: { path: 'a.txt' } }] }
    })
    const toolResultContent = 'file contents '.repeat(100)
    const requestTwo = {
      messages: [
        ...requestOne.messages,
        { role: 'assistant' as const, toolCalls: [{ id: 'tool-1', name: 'read_file', input: { path: 'a.txt' } }] },
        { role: 'tool' as const, toolCallId: 'tool-1', content: toolResultContent, isError: false }
      ],
      maxTokens: 100, tools: requestOne.tools
    }

    await observer.onModelRequest?.({ modelTurn: 2, attempt: 1, routeId: 'route', request: requestTwo })

    const projectedUsage = facts.find((fact) => (fact as { type?: string }).type === 'usage-updated' && (fact as { projected?: boolean }).projected)
    expect(projectedUsage).toMatchObject({ type: 'usage-updated', projected: true, usage: { input_tokens: expect.any(Number), output_tokens: 50 } })
    expect((projectedUsage as { usage: { input_tokens: number } }).usage.input_tokens)
      .toBe(1000 + estimateTokensFromToolResults([{ content: toolResultContent }]))
    const nextContext = events.find((event) => event.type === 'request_context' && event.payload.requestId === 'tool-projection:round:2')
    expect(nextContext?.payload).toMatchObject({
      contextUsage: { pressureTokens: expect.any(Number), projectedTokens: expect.any(Number), anchorStatus: 'matched' },
      phase: 'tool_loop', reason: 'proactive'
    })
    expect(events.find((event) => event.type === 'request_header' && event.payload.requestId === 'tool-projection:round:2')?.payload).toMatchObject({
      toolExecutionCheckpoint: { completedToolUseIds: ['tool-1'] }
    })
  })

  it('projects output-recovery retry and non-dispatched tool results before reconciling final text', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const facts: unknown[] = []
    const observer = createAgentSdkDesktopObserver({
      requestId: 'r', sessionId: 's', turnId: 't',
      emitSessionEvent: (event) => events.push(event as { type: string; payload: Record<string, unknown> }),
      emitFactEvent: (event) => facts.push(event)
    })
    const outputResult = { success: false, error: 'model_output_token_limit', userMessage: 'truncated tool was not dispatched', notExecuted: true, notExecutedReason: 'model_output_truncated' }
    const retryPayload = { turnId: 't', stepId: 'r', requestId: 'r:round:1', attempt: 1, backoffMs: 0, code: 'model_output_token_limit' }
    await observer.onOutputRecovery?.({ attempt: 1, modelTurn: 1, requestId: 'r:round:1', willRetry: true, toolCallErrorContent: 'truncated tool was not dispatched', sessionLedgerEvents: [
      { ...({ invocationId: 'r', turnId: 't', sequence: 1, schemaVersion: 1, eventId: 'e1', idempotencyKey: 'i1' }), kind: 'tool-call-not-dispatched', payload: { toolCallId: 'partial-tool', reason: 'MODEL_OUTPUT_TRUNCATED', sessionLedger: { location: { workDir: '/workspace', sessionId: 's', createdAt: 1 }, stepId: 'r', result: outputResult } } },
      { ...({ invocationId: 'r', turnId: 't', sequence: 2, schemaVersion: 1, eventId: 'e2', idempotencyKey: 'i2' }), kind: 'provider-retry-scheduled', payload: { requestId: retryPayload.requestId, sessionLedger: { location: { workDir: '/workspace', sessionId: 's', createdAt: 1 }, requestRetry: retryPayload } } }
    ], toolCalls: [
      { invocationId: 'r', toolCallId: 'partial-tool', toolName: 'write_file', input: { path: 'a.txt' } }
    ] })
    const result = { text: 'partial complete', messages: [], modelTurns: 2, finishReason: 'stop' as const, usage: { inputTokens: 2, outputTokens: 1 } }
    await observer.onTurnOutputReady?.(result)
    await observer.onTurnFinished?.(result)

    expect(events).toEqual([
      { type: 'tool_result', payload: { turnId: 't', stepId: 'r', toolUseId: 'partial-tool', result: outputResult, requestId: 'r', invocationRequestId: 'r' } },
      { type: 'request_retry', payload: { ...retryPayload, invocationRequestId: 'r' } }
    ])
    expect(facts).toContainEqual({ type: 'tool-result', id: 'partial-tool', result: expect.objectContaining({ notExecuted: true }) })
    expect(facts).toContainEqual({ type: 'content-reconciled', text: 'partial complete' })
  })

  it('prepares canonical provider retry ledger payload with exact session identity', async () => {
    const observer = createAgentSdkDesktopObserver({
      requestId: 'r', sessionId: 's', turnId: 't',
      sessionEventLocation: { workDir: '/workspace', sessionId: 's', createdAt: 123 }
    })
    await expect(observer.prepareProviderRetry?.({ attempt: 2, modelTurn: 3, routeId: 'route', requestId: 'r:round:3', code: 'provider_context_overflow' })).resolves.toEqual({
      location: { workDir: '/workspace', sessionId: 's', createdAt: 123 },
      requestRetry: { turnId: 't', stepId: 'r', requestId: 'r:round:3', attempt: 2, backoffMs: 0, code: 'provider_context_overflow' }
    })
  })

  it('projects accepted chunks and tool lifecycle into legacy session events and facts in source order', async () => {
    const order: string[] = []
    const projectedSessionEvents: Array<{ type: string; payload: Record<string, unknown> }> = []
    const observer = createAgentSdkDesktopObserver({
      requestId: 'request-1', sessionId: 'session-1', turnId: 'turn-1', assistantMessageId: 'assistant-1',
      emitSessionEvent: async (event) => { const normalized = event as { type: string; payload: Record<string, unknown> }; projectedSessionEvents.push(normalized); order.push(`session:${event.type}:${(event.payload as { toolUseId?: string }).toolUseId ?? ''}`) },
      emitFactEvent: (event) => { order.push(`fact:${event.type}:${'id' in event ? event.id : ''}`) }
    })
    const typed = observer as Required<Pick<AgentTurnObserver, 'onModelChunk' | 'onModelResponseCommitted' | 'onToolStarted' | 'onToolFinished' | 'onTurnFinished'>>
    await observer.prepareModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route', request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 100, tools: [{ name: 'lookup', description: 'lookup', inputSchema: { type: 'object' } }] } })
    await typed.onModelChunk({ type: 'text-delta', text: 'hello' })
    await typed.onModelChunk({ type: 'tool-call', toolCallId: 'tool-1', toolName: 'lookup', input: { query: 'q' } })
    await typed.onModelChunk({ type: 'usage', inputTokens: 2, outputTokens: 1 })
    await typed.onModelResponseCommitted({ modelTurn: 1, finishReason: 'tool-calls', usage: { type: 'usage', inputTokens: 2, outputTokens: 1 }, message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], toolCalls: [{ id: 'tool-1', name: 'lookup', input: { query: 'q' } }] } })
    await typed.onToolStarted({ invocationId: 'request-1', toolCallId: 'tool-1', toolName: 'lookup', input: { query: 'q' } })
    await typed.onToolFinished({ invocationId: 'request-1', toolCallId: 'tool-1', toolName: 'lookup', input: { query: 'q' } }, { output: { rows: 1 } })
    await typed.onTurnFinished({ text: 'hello', messages: [], modelTurns: 1, finishReason: 'stop', usage: { inputTokens: 2, outputTokens: 1 } })

    expect(order).toEqual([
      'fact:content-delta:', 'fact:context-projection-updated:', 'session:request_context:',
      'session:assistant_chunk:', 'session:assistant_chunk:', 'session:assistant_chunk:',
      'session:assistant_chunk:', 'session:assistant_chunk:', 'session:assistant_chunk:', 'session:assistant_chunk:',
      'session:assistant_chunk:', 'session:tool_call:tool-1',
      'fact:tool-use:tool-1', 'fact:preview-commit:', 'session:tool_result:tool-1', 'fact:tool-result:tool-1'
    ])
    const sessionEvents = order.filter((entry) => entry.startsWith('session:'))
    expect(sessionEvents.slice(0, 10).map((entry) => entry.split(':')[1])).toEqual(['request_context', ...Array(8).fill('assistant_chunk'), 'tool_call'])
    expect(projectedSessionEvents[5]?.payload.delta).toEqual({ type: 'tool_call_delta', index: 1, partialJson: '' })
    expect(projectedSessionEvents[9]?.payload.args).toEqual({ query: 'q' })
  })

  it('keeps text, tool, thinking, and later text in provider source order in the accepted activity timeline', async () => {
    const facts: AssistantFactEvent[] = []
    const observer = createAgentSdkDesktopObserver({
      requestId: 'ordered-response', sessionId: 'session-1', turnId: 'turn-1',
      emitFactEvent: (event) => facts.push(event)
    })
    const typed = observer as Required<Pick<AgentTurnObserver, 'onModelChunk' | 'onModelResponseCommitted'>>
    await observer.prepareModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route', request: { messages: [{ role: 'user', content: 'question' }], maxTokens: 100 } })
    await typed.onModelChunk({ type: 'text-delta', text: 'before' })
    await typed.onModelChunk({ type: 'tool-call', toolCallId: 'ordered-tool', toolName: 'lookup', input: { query: 'q' } })
    await typed.onModelChunk({ type: 'thinking-delta', text: 'reasoning' })
    await typed.onModelChunk({ type: 'text-delta', text: 'after' })
    await typed.onModelResponseCommitted({
      modelTurn: 1, finishReason: 'tool-calls', usage: { type: 'usage', inputTokens: 3, outputTokens: 2 },
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'before' }, { type: 'thinking', thinking: 'reasoning' }, { type: 'text', text: 'after' }],
        toolCalls: [{ id: 'ordered-tool', name: 'lookup', input: { query: 'q' } }]
      }
    })

    const initial: Message = { id: 'assistant-1', sessionId: 'session-1', role: 'assistant', content: '', timestamp: 0, status: 'streaming', schemaVersion: 1 }
    const projected = facts.reduce((state, fact, index) => reduceAssistantFact(state, fact, { now: index + 1, createId: () => 'hint' }), initial)
    expect(buildAssistantActivityTimeline(projected).map((item) => item.kind)).toEqual(['text', 'tool', 'thinking', 'text'])
  })

  it('starts a new text segment when provider text resumes after a tool proposal', async () => {
    const facts: AssistantFactEvent[] = []
    const observer = createAgentSdkDesktopObserver({ requestId: 'ordered-text', sessionId: 'session-1', turnId: 'turn-1', emitFactEvent: (event) => facts.push(event) })
    const typed = observer as Required<Pick<AgentTurnObserver, 'onModelChunk' | 'onModelResponseCommitted'>>
    await observer.prepareModelRequest?.({ modelTurn: 1, attempt: 1, routeId: 'route', request: { messages: [{ role: 'user', content: 'question' }], maxTokens: 100 } })
    await typed.onModelChunk({ type: 'text-delta', text: 'before' })
    await typed.onModelChunk({ type: 'tool-call', toolCallId: 'ordered-text-tool', toolName: 'lookup', input: { query: 'q' } })
    await typed.onModelChunk({ type: 'text-delta', text: 'after' })
    await typed.onModelResponseCommitted({
      modelTurn: 1, finishReason: 'tool-calls', usage: { type: 'usage', inputTokens: 3, outputTokens: 2 },
      message: { role: 'assistant', content: [{ type: 'text', text: 'before' }, { type: 'text', text: 'after' }], toolCalls: [{ id: 'ordered-text-tool', name: 'lookup', input: { query: 'q' } }] }
    })
    const initial: Message = { id: 'assistant-1', sessionId: 'session-1', role: 'assistant', content: '', timestamp: 0, status: 'streaming', schemaVersion: 1 }
    const projected = facts.reduce((state, fact, index) => reduceAssistantFact(state, fact, { now: index + 1, createId: () => 'hint' }), initial)
    expect(buildAssistantActivityTimeline(projected).map((item) => item.kind)).toEqual(['text', 'tool', 'text'])
    expect(projected.contentSegments?.map((segment) => segment.content)).toEqual(['before', 'after'])
  })

  it('rolls back a provisional preview and never commits tool facts after a failed turn', async () => {
    const emitFactEvent = vi.fn()
    const observer = createAgentSdkDesktopObserver({ requestId: 'r', sessionId: 's', turnId: 't', emitFactEvent })
    await observer.onModelChunk?.({ type: 'text-delta', text: 'partial' })
    await observer.onTurnFailed?.({ error: new Error('provider failed'), status: 'failed' })
    expect(emitFactEvent).toHaveBeenLastCalledWith({ type: 'preview-rollback' })
    expect(emitFactEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'preview-commit' }))
  })

  it('rolls back and clears provisional chunks from a discarded provider attempt before retry', async () => {
    const facts: unknown[] = []
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const observer = createAgentSdkDesktopObserver({
      requestId: 'retry-preview', sessionId: 's', turnId: 't',
      emitFactEvent: (event) => facts.push(event),
      emitSessionEvent: (event) => events.push(event as { type: string; payload: Record<string, unknown> })
    })
    await observer.onModelChunk?.({ type: 'text-delta', text: 'discard this answer' })
    await observer.onModelAttemptDiscarded?.({ attempt: 1, modelTurn: 1, reasonCode: 'SILENT_CONTEXT_OVERFLOW' })
    await observer.onModelRequest?.({ modelTurn: 1, attempt: 2, routeId: 'route', request: { messages: [], maxTokens: 10, tools: [] } })
    await observer.onModelChunk?.({ type: 'text-delta', text: 'keep this answer' })
    await observer.onModelResponseCommitted?.({
      modelTurn: 1, finishReason: 'stop', usage: { type: 'usage', inputTokens: 1, outputTokens: 1 },
      message: { role: 'assistant', content: [{ type: 'text', text: 'keep this answer' }] }
    })

    expect(facts).toEqual(expect.arrayContaining([
      { type: 'preview-rollback' },
      expect.objectContaining({ type: 'content-delta', text: 'keep this answer' }),
      { type: 'preview-commit' }
    ]))
    expect(events.filter((event) => event.type === 'assistant_chunk').some((event) => JSON.stringify(event).includes('discard this answer'))).toBe(false)
    expect(facts.some((fact) => (fact as { type?: string }).type === 'content-delta' && (fact as { text?: string }).text === 'discard this answer')).toBe(true)
    expect(facts.findIndex((fact) => (fact as { type?: string }).type === 'preview-rollback'))
      .toBeGreaterThan(facts.findIndex((fact) => (fact as { type?: string }).text === 'discard this answer'))
  })

  it('does not re-project a host response whose session ledger and facts were already committed', async () => {
    const emitSessionEvent = vi.fn()
    const emitFactEvent = vi.fn()
    const observer = createAgentSdkDesktopObserver({ requestId: 'r', sessionId: 's', turnId: 't', emitSessionEvent, emitFactEvent })

    await observer.onModelResponseCommitted?.({
      modelTurn: 1, finishReason: 'tool-calls', usage: { type: 'usage', inputTokens: 1, outputTokens: 1 },
      message: { role: 'assistant', content: [{ type: 'text', text: 'already projected' }], toolCalls: [{ id: 'already-tool', name: 'lookup', input: {} }] }, alreadyProjected: true
    })

    expect(emitSessionEvent).not.toHaveBeenCalled()
    expect(emitFactEvent).not.toHaveBeenCalled()
    await observer.onToolFinished?.({ invocationId: 'r', toolCallId: 'already-tool', toolName: 'lookup', input: {} }, { output: { success: true } })
    expect(emitSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool_result', payload: expect.objectContaining({ toolUseId: 'already-tool', stepId: 'r:model:1' }) }))
  })

  it('projects executor ToolExecutorResult to the same fact shape as the legacy loop', async () => {
    const ordering: string[] = []
    const emitFactEvent = vi.fn((event) => { ordering.push(`fact:${event.type}`) })
    const notify = vi.fn(() => { ordering.push('notify') })
    const onFileTreeChanged = vi.fn(() => { ordering.push('file-tree') })
    const observer = createAgentSdkDesktopObserver({
      requestId: 'r', sessionId: 's', turnId: 't', emitFactEvent, notify, onFileTreeChanged,
      emitSessionEvent: async (event) => { ordering.push(`session:${event.type}`) }
    })
    await observer.onToolFinished?.(
      { invocationId: 'r', toolCallId: 'write-1', toolName: 'write_file', input: { path: 'a.txt' } },
      { output: { success: true, data: { path: 'a.txt', written: 3 } }, auditRef: 'audit:write-1' }
    )
    expect(emitFactEvent).toHaveBeenCalledWith({ type: 'tool-result', id: 'write-1', result: { success: true, data: { path: 'a.txt', written: 3 }, auditRef: 'audit:write-1' } })
    expect(notify).toHaveBeenCalledWith({ kind: 'tool-result', requestId: 'r', toolUseId: 'write-1' })
    expect(onFileTreeChanged).toHaveBeenCalledWith({ kind: 'paths', relPaths: ['a.txt'] })
    expect(ordering).toEqual(['session:tool_result', 'fact:tool-result', 'file-tree', 'notify'])
  })

  it('correlates Hosted tool results with the invocation request, turn, and lane', async () => {
    const emitSessionEvent = vi.fn()
    const observer = createAgentSdkDesktopObserver({
      requestId: 'trace-request', sessionId: 'trace-session', turnId: 'trace-turn', lane: 'feishu', emitSessionEvent
    } as never)

    await observer.onToolFinished?.(
      { invocationId: 'trace-request', toolCallId: 'trace-call', toolName: 'read_file', input: { path: 'a.txt' } },
      { output: { success: true, data: 'ok' } }
    )

    expect(emitSessionEvent).toHaveBeenCalledWith({
      type: 'tool_result',
      payload: expect.objectContaining({
        requestId: 'trace-request', turnId: 'trace-turn', lane: 'feishu', toolUseId: 'trace-call'
      })
    })
  })
})
