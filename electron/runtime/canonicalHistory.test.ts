import { describe, expect, it } from 'vitest'
import { commitCompactionAcrossStores, toCanonicalModelMessages } from './canonicalHistory'
import { rebuildClaudeMessagesFromHistory } from './canonicalHistory'
import type { HistoryEvent } from '../../packages/agent-sdk/src/history'
import { buildClaudeToolChatMessages } from '../../src/shared/claudeToolHistory'
import type { Message } from '../../src/shared/domainTypes'
import { runAgentTurn } from '../../packages/agent-sdk/src/turn'
import { ModelProviderRegistry, type StreamChunk } from '../../packages/agent-sdk/src/model'
import { CapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import { InMemorySafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import { SafetyGate } from '../../packages/agent-sdk/src/safetyGate'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import { createPermitBoundToolExecutionPort } from '../../packages/agent-sdk/src/toolExecutionPort'
import { MemoryHistory } from '../../packages/agent-sdk/src/history'

describe('commitCompactionAcrossStores', () => {
  it('marks a canonical-first partial commit as uncertain when the legacy ledger fails', async () => {
    const order: string[] = []
    const error = new Error('session event disk failure')

    await expect(commitCompactionAcrossStores({
      compactionId: 'compact-1',
      appendCanonical: async () => { order.push('canonical') },
      appendLegacy: async () => { order.push('legacy'); throw error }
    })).rejects.toMatchObject({ name: 'CanonicalCompactionCommitUncertainError', compactionId: 'compact-1', cause: error })
    expect(order).toEqual(['canonical', 'legacy'])
  })
})

describe('toCanonicalModelMessages', () => {
  it('projects canonical user images, assistant thinking/tool calls, and tool results in order', () => {
    const messages = toCanonicalModelMessages([
      { role: 'user', id: 'u1', timestamp: 1, content: [
        { type: 'text', text: 'inspect this' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1n' } }
      ] },
      { role: 'assistant', id: 'a1', timestamp: 2, content: [
        { type: 'thinking', thinking: 'checking', signature: 'sig-1' },
        { type: 'text', text: 'I will inspect it.' },
        { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'a.txt' } }
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tool-1', content: '{"data":"ok"}', is_error: false }
      ] }
    ] as never)

    expect(messages).toEqual([
      { role: 'user', timestamp: 1, content: [
        { type: 'text', text: 'inspect this' }, { type: 'image', mimeType: 'image/png', data: 'aW1n' }
      ] },
      { role: 'assistant', timestamp: 2, content: [
        { type: 'thinking', thinking: 'checking', thinkingSignature: 'sig-1' }, { type: 'text', text: 'I will inspect it.' }
      ], toolCalls: [{ id: 'tool-1', name: 'read_file', input: { path: 'a.txt' } }] },
      { role: 'tool', toolCallId: 'tool-1', content: '{"data":"ok"}', isError: false }
    ])
  })

  it('preserves redacted thinking blocks and rejects unsupported image media types', () => {
    expect(toCanonicalModelMessages([
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'opaque' }] }
    ] as never)).toEqual([{ role: 'assistant', content: [{ type: 'thinking', thinking: '', thinkingSignature: 'opaque', redacted: true }] }])

    expect(() => toCanonicalModelMessages([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/bmp', data: 'aW1n' } }] }
    ] as never)).toThrow('unsupported canonical image MIME type: image/bmp')
  })

  it('projects the real persisted-message rebuild output without changing tool pairing', () => {
    const source: Message[] = [
      { id: 'user-1', sessionId: 's', role: 'user', content: 'read a.txt', timestamp: 1, status: 'completed' },
      { id: 'assistant-1', sessionId: 's', role: 'assistant', content: 'I will read it.', timestamp: 2, status: 'completed', toolCalls: [{
        id: 'call-1', toolName: 'read_file', input: { path: 'a.txt' }, status: 'completed', riskLevel: 'low',
        result: { success: true, data: { content: 'file body' } }
      }] }
    ]
    const rebuilt = buildClaudeToolChatMessages(source)
    const projected = toCanonicalModelMessages(rebuilt)

    expect(projected).toMatchObject([
      { role: 'user', content: 'read a.txt' },
      { role: 'assistant', toolCalls: [{ id: 'call-1', name: 'read_file', input: { path: 'a.txt' } }] },
      { role: 'tool', toolCallId: 'call-1', isError: false }
    ])
  })
})

describe('rebuildClaudeMessagesFromHistory', () => {
  it('preserves canonical message timestamps when rebuilding a transcript for session cutover', () => {
    const events = [{
      eventId: 'timestamp-context', idempotencyKey: 'timestamp-context', invocationId: 'timestamp-invocation', turnId: 'timestamp-turn',
      sequence: 1, schemaVersion: 1, kind: 'invocation-context-committed',
      payload: { messages: [
        { role: 'user', content: 'same text', timestamp: 1 },
        { role: 'user', content: 'same text', timestamp: 2 }
      ] }
    }] as HistoryEvent[]

    expect(rebuildClaudeMessagesFromHistory(events)).toEqual([
      { role: 'user', content: 'same text', timestamp: 1 },
      { role: 'user', content: 'same text', timestamp: 2 }
    ])
  })

  it('round-trips an SDK tool turn into Electron canonical provider history', async () => {
    const route = { routeId: 'history-roundtrip', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
    const registry = new ModelProviderRegistry()
    const responses: StreamChunk[][] = [
      [
        { type: 'tool-call', toolCallId: 'tc-roundtrip', toolName: 'lookup', input: { query: 'q' } },
        { type: 'tool-call', toolCallId: 'tc-error-roundtrip', toolName: 'lookup', input: { query: 'missing' } },
        { type: 'usage', inputTokens: 2, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
      ],
      [{ type: 'text-delta', text: 'done' }, { type: 'usage', inputTokens: 3, outputTokens: 1 }, { type: 'finish', reason: 'stop' }]
    ]
    const providerRequests: unknown[][] = []
    registry.register(route, { providerId: 'fake', stream: async function* (call) { providerRequests.push([...call.request.messages]); yield* responses.shift()! } })
    const capabilities = new CapabilityRegistry()
    capabilities.define('invocation-roundtrip', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const history = new MemoryHistory()
    const binding = {
      requestId: 'request-roundtrip', turnId: 'turn-roundtrip', invocationId: 'invocation-roundtrip',
      toolCallId: 'tc-roundtrip', capabilityId: 'lookup', inputSnapshotHash: 'input', planDigest: 'plan',
      factsDigest: 'facts', authorizationVersion: 'auth-v1', phase: 'recheck' as const
    }
    const execution = createPermitBoundToolExecutionPort({
      permits, admission: new InMemoryExecutionAdmissionCoordinator(),
      resolveExpected: async (call) => ({ ...binding, invocationId: call.invocationId, toolCallId: call.toolCallId, capabilityId: call.toolName }),
      execute: async (call) => {
        if (call.toolCallId === 'tc-roundtrip') await new Promise((resolve) => setTimeout(resolve, 15))
        return call.toolCallId === 'tc-error-roundtrip'
          ? { output: { errorCode: 'NOT_FOUND' }, replayContent: 'record not found', isError: true }
          : { output: { safeFact: 'structured' }, replayContent: 'authorized replay text', isError: false }
      }
    })
    await runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'invocation-roundtrip', turnId: 'turn-roundtrip',
      request: { messages: [{ role: 'user', content: 'request' }], maxTokens: 50 }, currentUserMessageId: 'user-current',
      requiredUserMessage: { id: 'user-current', message: { role: 'user', content: 'request' } }, history,
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (current) => ({ kind: 'allow', authorizationVersion: current.authorizationVersion }) } }),
      prepareTool: async (call, stage) => ({ ...binding, toolCallId: call.toolCallId, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: execution, maxModelTurns: 2,
      toolResourceKeys: (call) => [`read:${call.toolCallId}`]
    })

    const snapshot = await history.read('invocation-roundtrip')
    expect(snapshot.events.filter(({ kind }) => kind === 'tool-call-finished').map(({ payload }) => (payload as { toolCallId: string }).toolCallId))
      .toEqual(['tc-error-roundtrip', 'tc-roundtrip'])
    expect(snapshot.events[0]).toMatchObject({
      kind: 'invocation-context-committed',
      payload: { requiredUserMessage: { id: 'user-current', message: { role: 'user', content: 'request' } } }
    })
    expect(rebuildClaudeMessagesFromHistory(snapshot.events)).toEqual([
      { role: 'user', content: 'request', id: 'user-current' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'tc-roundtrip', name: 'lookup', input: { query: 'q' } },
        { type: 'tool_use', id: 'tc-error-roundtrip', name: 'lookup', input: { query: 'missing' } }
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tc-roundtrip', content: 'authorized replay text', is_error: false },
        { type: 'tool_result', tool_use_id: 'tc-error-roundtrip', content: 'record not found', is_error: true }
      ] },
      { role: 'assistant', content: 'done' }
    ])
    const rebuiltCanonical = toCanonicalModelMessages(rebuildClaudeMessagesFromHistory(snapshot.events))
    expect(rebuiltCanonical.filter((message) => message.role === 'tool')).toEqual(
      providerRequests[1]?.filter((message): message is Extract<typeof message, { role: 'tool' }> => (message as { role?: string }).role === 'tool')
    )
  })

  it('replays a mixed successful and policy-rejected tool batch in declaration order', async () => {
    const route = { routeId: 'history-mixed-batch', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
    const registry = new ModelProviderRegistry()
    registry.register(route, { providerId: 'fake', stream: async function* () {
      yield { type: 'tool-call', toolCallId: 'tc-first-success', toolName: 'lookup', input: { query: 'slow' } }
      yield { type: 'tool-call', toolCallId: 'tc-second-denied', toolName: 'lookup', input: { query: 'denied' } }
      yield { type: 'usage', inputTokens: 1, outputTokens: 1 }
      yield { type: 'finish', reason: 'tool-calls' }
    } })
    const capabilities = new CapabilityRegistry()
    capabilities.define('inv-mixed-batch', ['lookup'])
    const permits = new InMemorySafetyPermitStore()
    const history = new MemoryHistory()
    const binding = {
      requestId: 'req-mixed-batch', turnId: 'turn-mixed-batch', invocationId: 'inv-mixed-batch',
      toolCallId: '', capabilityId: 'lookup', inputSnapshotHash: 'input', planDigest: 'plan',
      factsDigest: 'facts', authorizationVersion: 'auth-v1', phase: 'initial-compat' as const
    }
    const execution = createPermitBoundToolExecutionPort({
      permits, admission: new InMemoryExecutionAdmissionCoordinator(),
      resolveExpected: async (call) => ({ ...binding, invocationId: call.invocationId, toolCallId: call.toolCallId, phase: 'recheck' as const }),
      execute: async (call) => {
        if (call.toolCallId === 'tc-first-success') await new Promise((resolve) => setTimeout(resolve, 15))
        return { output: `${call.toolCallId}-result` }
      }
    })
    await expect(runAgentTurn({
      registry, routeId: route.routeId, invocationId: 'inv-mixed-batch', history,
      request: { messages: [{ role: 'user', content: 'run mixed batch' }], maxTokens: 80 },
      safetyGate: new SafetyGate({ capabilities, permitStore: permits, policy: { evaluate: async (current) =>
        current.phase === 'recheck' && current.toolCallId === 'tc-second-denied'
          ? { kind: 'deny', reasonCode: 'POLICY_DENY' }
          : { kind: 'allow', authorizationVersion: current.authorizationVersion }
      } }),
      prepareTool: async (call, stage) => ({ ...binding, toolCallId: call.toolCallId, phase: stage.kind === 'initial' ? 'initial-compat' : 'recheck' }),
      toolExecution: execution, maxModelTurns: 2, maxConcurrentTools: 2,
      toolResourceKeys: (call) => [`tool:${call.toolCallId}`]
    })).rejects.toMatchObject({ code: 'TOOL_DENIED', reasonCode: 'POLICY_DENY' })

    const snapshot = await history.read('inv-mixed-batch')
    expect(snapshot.events.filter(({ kind }) => kind === 'tool-call-not-dispatched').map(({ payload }) => (payload as { toolCallId: string }).toolCallId))
      .toEqual(['tc-second-denied'])
    expect(snapshot.events.filter(({ kind }) => kind === 'tool-call-finished').map(({ payload }) => (payload as { toolCallId: string }).toolCallId))
      .toEqual(['tc-first-success'])
    expect(rebuildClaudeMessagesFromHistory(snapshot.events).at(-1)).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tc-first-success', content: 'tc-first-success-result', is_error: false },
      { type: 'tool_result', tool_use_id: 'tc-second-denied', content: 'Tool call was not dispatched (POLICY_DENY).', is_error: true }
    ] })
  })

  it('rebuilds committed assistant and grouped tool results in provider order', () => {
    const events = [
      { kind: 'model-response-committed', payload: { message: { role: 'assistant', content: [{ type: 'text', text: 'checking' }], toolCalls: [
        { id: 'tool-1', name: 'read_file', input: { path: 'a.txt' } },
        { id: 'tool-2', name: 'read_file', input: { path: 'b.txt' } }
      ] } } },
      { kind: 'tool-call-finished', payload: { toolCallId: 'tool-1', replayContent: 'first body', isError: false } },
      { kind: 'tool-call-finished', payload: { toolCallId: 'tool-2', replayContent: 'second body', isError: true } },
      { kind: 'model-response-committed', payload: { message: { role: 'assistant', content: 'finished' } } }
    ].map((event, index) => ({
      ...event, eventId: `e${index + 1}`, idempotencyKey: `i${index + 1}`, invocationId: 'inv', turnId: 'turn',
      sequence: index + 1, schemaVersion: 1
    })) as HistoryEvent[]

    expect(rebuildClaudeMessagesFromHistory(events)).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'checking' },
        { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'a.txt' } },
        { type: 'tool_use', id: 'tool-2', name: 'read_file', input: { path: 'b.txt' } }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'first body', is_error: false },
        { type: 'tool_result', tool_use_id: 'tool-2', content: 'second body', is_error: true }
      ] },
      { role: 'assistant', content: 'finished' }
    ])
  })

  it('reorders concurrently committed tool results to the provider declaration order on replay', () => {
    const events = [
      { kind: 'model-response-committed', payload: { message: { role: 'assistant', toolCalls: [
        { id: 'tool-first', name: 'lookup', input: { q: 'first' } },
        { id: 'tool-second', name: 'lookup', input: { q: 'second' } }
      ] } } },
      { kind: 'tool-call-finished', payload: { toolCallId: 'tool-second', replayContent: 'second result', isError: false } },
      { kind: 'tool-call-finished', payload: { toolCallId: 'tool-first', replayContent: 'first result', isError: false } }
    ].map((event, index) => ({
      ...event, eventId: `parallel-${index + 1}`, idempotencyKey: `parallel-key-${index + 1}`, invocationId: 'inv', turnId: 'turn',
      sequence: index + 1, schemaVersion: 1
    })) as HistoryEvent[]
    expect(rebuildClaudeMessagesFromHistory(events).at(-1)).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tool-first', content: 'first result', is_error: false },
      { type: 'tool_result', tool_use_id: 'tool-second', content: 'second result', is_error: false }
    ] })
  })

  it('replays denied and cancelled calls as error tool results instead of empty successes', () => {
    const events = [
      { kind: 'model-response-committed', payload: { message: { role: 'assistant', toolCalls: [
        { id: 'tool-denied', name: 'write_file', input: { path: 'secret.txt' } },
        { id: 'tool-cancelled', name: 'run_script', input: { script: 'echo no' } }
      ] } } },
      { kind: 'tool-call-not-dispatched', payload: { toolCallId: 'tool-denied', reason: 'POLICY_DENY' } },
      { kind: 'tool-call-not-dispatched', payload: { toolCallId: 'tool-cancelled', reason: 'REQUEST_CANCELLED' } }
    ].map((event, index) => ({
      ...event, eventId: `denied-${index + 1}`, idempotencyKey: `denied-key-${index + 1}`, invocationId: 'inv', turnId: 'turn',
      sequence: index + 1, schemaVersion: 1
    })) as HistoryEvent[]

    expect(rebuildClaudeMessagesFromHistory(events)).toEqual([
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'tool-denied', name: 'write_file', input: { path: 'secret.txt' } },
        { type: 'tool_use', id: 'tool-cancelled', name: 'run_script', input: { script: 'echo no' } }
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tool-denied', content: 'Tool call was not dispatched (POLICY_DENY).', is_error: true },
        { type: 'tool_result', tool_use_id: 'tool-cancelled', content: 'Tool call was not dispatched (REQUEST_CANCELLED).', is_error: true }
      ] }
    ])
  })

  it('rejects an unfinished tool pair so an interrupted dispatch cannot be replayed', () => {
    const events = [{
      eventId: 'e1', idempotencyKey: 'i1', invocationId: 'inv', turnId: 'turn', sequence: 1, schemaVersion: 1,
      kind: 'model-response-committed', payload: { message: { role: 'assistant', toolCalls: [{ id: 'tool-pending', name: 'write_file', input: {} }] } }
    }] as HistoryEvent[]
    expect(() => rebuildClaudeMessagesFromHistory(events)).toThrow('history contains unresolved tool calls: tool-pending')
  })

  it('uses the committed compacted transcript as the new replay base', () => {
    const events = [
      { kind: 'model-response-committed', payload: { message: { role: 'assistant', content: 'large prior answer' } } },
      { kind: 'transcript-compacted', payload: {
        messages: [{ role: 'user', content: 'current request only' }],
        requiredUserMessage: { id: 'required-current', message: { role: 'user', content: 'current request only' } },
        sessionLedger: {
          start: { compactionId: 'compact-1', windowId: 'window-1', inputSurfaceFingerprint: 'input' },
          summary: { compactionId: 'compact-1', windowId: 'window-1', outputWindowId: 'window-2', outputSurfaceFingerprint: 'output' }
        }
      } },
      { kind: 'model-response-committed', payload: { message: { role: 'assistant', content: 'answer after compaction' } } }
    ].map((event, index) => ({
      ...event, eventId: `compact-${index + 1}`, idempotencyKey: `compact-key-${index + 1}`, invocationId: 'inv', turnId: 'turn',
      sequence: index + 1, schemaVersion: 1
    })) as HistoryEvent[]

    expect(rebuildClaudeMessagesFromHistory(events)).toEqual([
      { role: 'user', content: 'current request only', id: 'required-current' },
      { role: 'assistant', content: 'answer after compaction' }
    ])
  })
})
