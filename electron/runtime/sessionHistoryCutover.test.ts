import { describe, expect, it } from 'vitest'
import type { HistorySnapshot } from '../../packages/agent-sdk/src/history'
import type { CanonicalModelMessage } from '../../packages/agent-sdk/src/model'
import type { ClaudeChatMessageWithBlocks } from '../../src/shared/api'
import { resolveCanonicalRequestCutover, resolveSessionHistoryCutover } from './sessionHistoryCutover'

const prior: CanonicalModelMessage[] = [
  { role: 'user', content: 'read a.txt' },
  { role: 'assistant', content: [{ type: 'text', text: 'I will read it.' }], toolCalls: [{ id: 'call-1', name: 'read_file', input: { path: 'a.txt' } }] },
  { role: 'tool', toolCallId: 'call-1', content: 'file body', isError: false },
  { role: 'assistant', content: 'Here is the file.' }
]

const snapshot: HistorySnapshot = {
  invocationId: 'prior-invocation', version: 1, schemaVersion: 1,
  events: [{
    invocationId: 'prior-invocation', turnId: 'prior-turn', sequence: 1, schemaVersion: 1,
    eventId: 'prior-context', idempotencyKey: 'prior-context', kind: 'invocation-context-committed', payload: { messages: prior }
  }]
}

describe('resolveSessionHistoryCutover', () => {
  it('uses canonical History for matched prior transcript and preserves persisted IDs/current attachment message', () => {
    const current: ClaudeChatMessageWithBlocks = {
      id: 'user-current', role: 'user', timestamp: 10,
      content: [{ type: 'text', text: 'look at this' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1n' } }]
    }
    const legacyMessages: ClaudeChatMessageWithBlocks[] = [
      { id: 'user-old', role: 'user', content: 'read a.txt' },
      { id: 'assistant-tool', role: 'assistant', content: [
        { type: 'text', text: 'I will read it.' }, { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'a.txt' } }
      ] },
      { id: 'tool-result', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'file body', is_error: false }] },
      { id: 'assistant-final', role: 'assistant', content: 'Here is the file.' }, current
    ]

    const result = resolveSessionHistoryCutover({ snapshot, legacyMessages, currentUserMessageId: 'user-current' })

    expect(result).toMatchObject({ kind: 'matched', messages: [
      { id: 'user-old', role: 'user', content: 'read a.txt' },
      { id: 'assistant-tool', role: 'assistant' }, { id: 'tool-result', role: 'user' },
      { id: 'assistant-final', role: 'assistant', content: 'Here is the file.' }, current
    ] })
    if (result.kind === 'matched') expect(result.messages.at(-1)).toBe(current)
  })

  it('rejects drift and a missing or non-final current user message', () => {
    expect(resolveSessionHistoryCutover({ snapshot, legacyMessages: [
      { role: 'user', content: 'different transcript' }, { id: 'current', role: 'user', content: 'next' }
    ], currentUserMessageId: 'current' })).toEqual({ kind: 'transcript-mismatch' })
    expect(resolveSessionHistoryCutover({ snapshot, legacyMessages: [], currentUserMessageId: 'missing' })).toEqual({ kind: 'current-user-missing' })
    expect(resolveSessionHistoryCutover({ snapshot, legacyMessages: [
      { id: 'current', role: 'user', content: 'next' }, { role: 'assistant', content: 'extra' }
    ], currentUserMessageId: 'current' })).toEqual({ kind: 'current-user-not-last' })
  })
})

describe('resolveCanonicalRequestCutover', () => {
  it('keeps retained tool calls and results paired while excluding earlier context', () => {
    const excluded = { role: 'user' as const, content: 'older excluded question' }
    const withExcluded: HistorySnapshot = { ...snapshot, events: [{ ...snapshot.events[0]!, payload: { messages: [excluded, ...prior] } }] }
    const system = { role: 'system' as const, content: 'current system' }
    const current = { role: 'user' as const, content: 'current input' }
    const retained = prior.slice(1)
    const result = resolveCanonicalRequestCutover({ snapshot: withExcluded, requestMessages: [system, ...retained, current], requiredUserMessage: current })

    expect(result).toEqual({ kind: 'matched', messages: [system, ...prior.slice(1), current] })
    if (result.kind === 'matched') {
      expect(result.messages.find((message) => message.role === 'assistant' && message.toolCalls?.some(({ id }) => id === 'call-1'))).toBeTruthy()
      expect(result.messages.find((message) => message.role === 'tool' && message.toolCallId === 'call-1')).toMatchObject({ content: 'file body', isError: false })
    }
    expect(resolveCanonicalRequestCutover({
      snapshot: withExcluded,
      requestMessages: [system, ...retained.slice(0, 1), { ...retained[1]!, content: 'tampered result' }, ...retained.slice(2), current],
      requiredUserMessage: current
    })).toEqual({ kind: 'transcript-mismatch' })
  })

  it('uses the canonical ordered subset when the current turn excludes prior context', () => {
    const history: HistorySnapshot = { invocationId: 'prior-invocation', version: 1, schemaVersion: 1, events: [{
      invocationId: 'prior-invocation', turnId: 'prior-turn', sequence: 1, schemaVersion: 1,
      eventId: 'prior-context', idempotencyKey: 'prior-context', kind: 'invocation-context-committed',
      payload: { messages: [
        { role: 'user', content: 'excluded user' }, { role: 'assistant', content: 'excluded answer' },
        { role: 'user', content: 'retained user' }, { role: 'assistant', content: 'retained answer' }
      ] }
    }] }
    const retained: CanonicalModelMessage[] = [{ role: 'user', content: 'retained user' }, { role: 'assistant', content: 'retained answer' }]
    const system = { role: 'system' as const, content: 'current system' }
    const current = { role: 'user' as const, content: 'current input' }
    expect(resolveCanonicalRequestCutover({ snapshot: history, requestMessages: [system, ...retained, current], requiredUserMessage: current }))
      .toEqual({ kind: 'matched', messages: [system, ...retained, current] })
  })

  it('does not bind a duplicate transcript occurrence by value when its canonical timestamp identity differs', () => {
    const duplicate = { role: 'user' as const, content: 'same question', timestamp: 10 }
    const laterDuplicate = { role: 'user' as const, content: 'same question', timestamp: 20 }
    const history: HistorySnapshot = { invocationId: 'duplicates', version: 1, schemaVersion: 1, events: [{
      invocationId: 'duplicates', turnId: 'old', sequence: 1, schemaVersion: 1,
      eventId: 'context', idempotencyKey: 'context', kind: 'invocation-context-committed',
      payload: { messages: [duplicate, { role: 'assistant', content: 'first answer' }, laterDuplicate, { role: 'assistant', content: 'second answer' }] }
    }] }
    const current = { role: 'user' as const, content: 'new question' }
    const request = { role: 'user' as const, content: 'same question', timestamp: 15 }
    const result = resolveCanonicalRequestCutover({ snapshot: history, requestMessages: [request, current], requiredUserMessage: current })
    expect(result).toEqual({ kind: 'transcript-mismatch' })

    const matchedOccurrence = { role: 'user' as const, content: 'same question', timestamp: 20 }
    expect(resolveCanonicalRequestCutover({ snapshot: history, requestMessages: [matchedOccurrence, current], requiredUserMessage: current }))
      .toEqual({ kind: 'matched', messages: [matchedOccurrence, current] })
    const duplicateRequired = { ...current }
    expect(resolveCanonicalRequestCutover({ snapshot: history, requestMessages: [matchedOccurrence, current, duplicateRequired], requiredUserMessage: current }))
      .toEqual({ kind: 'required-user-missing' })
  })
})
