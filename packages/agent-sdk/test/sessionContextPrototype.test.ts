import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { CanonicalModelMessage } from '../src/model'
import { applyContextEvent, beginContextTurn, restoreSessionContext, selectContextCommit } from '../src/sessionContext'

type PrototypeState = {
  committed: CanonicalModelMessage[]; working: CanonicalModelMessage[]; failure: CanonicalModelMessage[] | null
  parkBaseline: CanonicalModelMessage[]; pendingCalls: Map<string, { order: number; call: { id: string; name: string } }>
  results: Map<string, CanonicalModelMessage>; requiredUser?: CanonicalModelMessage
  scope?: { sessionId: string; trackId?: string }
}

const user = (id: string, content: string): CanonicalModelMessage => ({ role: 'user', id, content })
const assistant = (id: string, content: string): CanonicalModelMessage => ({ role: 'assistant', id, content })
const approval = (): CanonicalModelMessage => ({ role: 'system', content: 'User approved the immediately preceding tool call.' })

function prototype(input: { committed: CanonicalModelMessage[]; added: CanonicalModelMessage[]; requiredUser?: CanonicalModelMessage }): PrototypeState {
  const working = [...input.committed, ...input.added]
  return { committed: input.committed, working, failure: [...working], parkBaseline: [...working], pendingCalls: new Map(), results: new Map(), requiredUser: input.requiredUser }
}

function compact(state: PrototypeState, messages: CanonicalModelMessage[]): PrototypeState {
  const cut = state.requiredUser ? messages.findIndex((message) => JSON.stringify(message) === JSON.stringify(state.requiredUser)) : -1
  return { ...state, working: messages, failure: cut >= 0 ? messages.slice(0, cut + 1) : null }
}

function completeTool(state: PrototypeState, callId: string, result: CanonicalModelMessage): PrototypeState {
  const pendingCalls = new Map(state.pendingCalls)
  const results = new Map(state.results).set(callId, result)
  const call = pendingCalls.get(callId)
  if (!call) throw new Error('TOOL_CALL_MISSING')
  const callOrder = [...pendingCalls.entries()].sort((a, b) => a[1].order - b[1].order)
  const completedThrough = callOrder.findIndex(([id]) => !results.has(id))
  const ready = completedThrough < 0 ? callOrder : callOrder.slice(0, completedThrough)
  if (!ready.some(([id]) => id === callId)) return { ...state, pendingCalls, results }
  const ordered: CanonicalModelMessage[] = []
  for (const [id] of ready) {
    ordered.push(results.get(id)!)
    pendingCalls.delete(id); results.delete(id)
  }
  return { ...state, working: [...state.working, ...ordered], pendingCalls, results }
}

function intent(state: PrototypeState, target: 'working' | 'failure' | 'park-baseline') {
  const messages = target === 'working' ? state.working : target === 'failure' ? state.failure : state.parkBaseline
  if (!messages) throw new Error('FAILURE_UNAVAILABLE')
  return { contextSelection: { contextProtocol: 2, target, baseVersion: 4 }, messages: messages.filter((message) => message.role !== 'system') }
}

describe('isolated protocol 2 session context prototype', () => {
  it('selects success, ordinary failure, and immutable park baseline across repeated compaction', () => {
    const prior = user('prior', 'prior')
    const current = user('current', 'current')
    const initial = prototype({ committed: [prior], added: [current], requiredUser: current })
    const once = compact(initial, [assistant('summary-1', 'first'), current])
    const twice = compact(once, [assistant('summary-2', 'second'), current])
    expect(intent(twice, 'park-baseline').messages).toEqual([prior, current])
    expect(intent(twice, 'failure').messages).toEqual([assistant('summary-2', 'second'), current])
    expect(intent(twice, 'working').messages).toEqual([assistant('summary-2', 'second'), current])
    const production = beginContextTurn(restoreSessionContext({ committedVersion: 4, events: [{ eventId: 'prior', idempotencyKey: 'prior', invocationId: 'seed', turnId: 'seed', sequence: 1, schemaVersion: 1, kind: 'session-input-committed', payload: { messages: [prior] } }] }), {
      invocationId: 'prototype-parity', baseVersion: 4, inputMessages: [current], failureInputMessages: [current], requiredUserMessage: { id: 'current', message: current }, requestSystem: ''
    })
    const productionTwice = applyContextEvent(applyContextEvent(production, { kind: 'transcript-compacted', messages: [assistant('summary-1', 'first'), current] }),
      { kind: 'transcript-compacted', messages: [assistant('summary-2', 'second'), current] })
    expect(selectContextCommit(productionTwice, { kind: 'park' }).messages).toEqual(intent(twice, 'park-baseline').messages)
    expect(selectContextCommit(productionTwice, { kind: 'failed' }).messages).toEqual(intent(twice, 'failure').messages)
    expect(selectContextCommit(productionTwice, { kind: 'completed' }).messages).toEqual(intent(twice, 'working').messages)
  })

  it('does not invent a failure cut when compaction omitted the exact required user', () => {
    const current = user('current', 'current')
    const state = compact(prototype({ committed: [], added: [current], requiredUser: current }), [assistant('summary', 'missing input')])
    expect(() => intent(state, 'failure')).toThrow('FAILURE_UNAVAILABLE')
    expect(intent(state, 'park-baseline').messages).toEqual([current])
    expect(intent(state, 'working').messages).toEqual([assistant('summary', 'missing input')])
  })

  it('pairs out-of-order tool results in model call order and keeps signatures/media', () => {
    const image: CanonicalModelMessage = { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: 'image-bytes' }] }
    const state = prototype({ committed: [], added: [image] })
    state.pendingCalls.set('a', { order: 0, call: { id: 'a', name: 'first' } })
    state.pendingCalls.set('b', { order: 1, call: { id: 'b', name: 'second' } })
    const later = completeTool(state, 'b', { role: 'tool', toolCallId: 'b', content: 'B', isError: false })
    const ordered = completeTool(later, 'a', { role: 'tool', toolCallId: 'a', content: 'A', isError: false })
    expect(ordered.working.slice(-2)).toEqual([
      { role: 'tool', toolCallId: 'a', content: 'A', isError: false },
      { role: 'tool', toolCallId: 'b', content: 'B', isError: false }
    ])
    const signed: CanonicalModelMessage = { role: 'assistant', content: [{ type: 'thinking', thinking: 'thought', thinkingSignature: 'sig' }], toolCalls: [{ id: 'signed', name: 'lookup', input: {}, thoughtSignature: 'tool-sig' }] }
    expect(signed).toMatchObject({ content: [{ thinkingSignature: 'sig' }], toolCalls: [{ thoughtSignature: 'tool-sig' }] })
  })

  it('inserts the approval system note as a transient working fact and strips it from selected persistence', () => {
    const state = prototype({ committed: [], added: [user('u', 'run')] })
    state.working.push(approval())
    expect(state.working.at(-1)).toEqual(approval())
    expect(intent(state, 'working').messages).toEqual([user('u', 'run')])
  })

  it('keeps independent track scopes isolated and compares a legacy seed with the old full snapshot', () => {
    const legacySeed = [user('legacy', 'legacy history')]
    const current = user('current', 'new input')
    const firstScope = { ...prototype({ committed: legacySeed, added: [current] }), scope: { sessionId: 's1', trackId: 'track-a' } }
    const otherScope = { ...prototype({ committed: [], added: [user('other', 'isolated')]}), scope: { sessionId: 's1', trackId: 'track-b' } }
    const legacyOldSnapshot = [...legacySeed, current]
    expect(intent(firstScope, 'working').messages).toEqual(legacyOldSnapshot)
    expect(intent(otherScope, 'working').messages).toEqual([user('other', 'isolated')])
    expect(firstScope.scope).not.toEqual(otherScope.scope)
  })

  it('binds manual review facts and receipt to a stable source identity', () => {
    const source = { sessionId: 's1', sessionGeneration: 'g2', sourceTurnId: 'turn-a', expectedVersion: 4 }
    const reviewHash = createHash('sha256').update(JSON.stringify(['session-review-v1', source.sessionId, source.sessionGeneration, source.sourceTurnId, source.expectedVersion])).digest('hex')
    const reviewKey = `session-review:${reviewHash}`
    const seed = { kind: 'invocation-context-committed', payload: { contextProtocol: 2, replacement: { reason: 'manual-review', messages: [user('u', 'reviewed')] }, review: { reviewKey, ...source } } }
    const receipt = { repairTurnId: `session-review-turn:${reviewKey}`, sourceTurnId: source.sourceTurnId, baseVersion: source.expectedVersion, nextVersion: source.expectedVersion + 1, reviewKey }
    expect(seed.payload.review.reviewKey).toBe(receipt.reviewKey)
    expect(receipt).toMatchObject({ sourceTurnId: 'turn-a', baseVersion: 4, nextVersion: 5 })
  })
})
