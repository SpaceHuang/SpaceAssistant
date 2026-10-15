import { describe, expect, it } from 'vitest'
import type { HistorySnapshot } from '../../packages/agent-sdk/src/history'
import { approveOneTimeUnknownEffectRetry, findOneTimeUnknownEffectRetryApproval, isUnknownEffectDecisionCurrent, readUnknownEffectRecoveryState, recordUnknownEffectRiskAcceptance } from './unknownEffectRecovery'

function snapshot(unresolvedEffects: unknown): HistorySnapshot {
  return { invocationId: 'target', version: 1, schemaVersion: 1, events: [{
    invocationId: 'target', turnId: 'turn', sequence: 1, schemaVersion: 1, eventId: 'context', idempotencyKey: 'context',
    kind: 'invocation-context-committed', payload: { messages: [], unresolvedEffects }
  }] }
}

describe('unknown effect recovery state', () => {
  it('fails closed with a visible unavailable status when no reviewed read-only checker exists', () => {
    const state = readUnknownEffectRecoveryState(snapshot([{ id: 'origin:write-1', originInvocationId: 'origin', toolCallId: 'write-1', toolName: 'write_file' }]))
    expect(state).toMatchObject({ mode: 'verify-only', verification: 'unavailable', checkerAvailable: false, reason: 'NO_REVIEWED_READ_ONLY_CAPABILITY' })
  })

  it('does not clear a newly dispatched tool whose result is still unknown', () => {
    const source = snapshot([])
    source.events.push(
      { invocationId: 'target', turnId: 'turn', sequence: 2, schemaVersion: 1, eventId: 'started', idempotencyKey: 'started', kind: 'tool-call-started', payload: { toolCallId: 'new-id', toolName: 'mcp_write', inputHash: 'hash' } },
      { invocationId: 'target', turnId: 'turn', sequence: 3, schemaVersion: 1, eventId: 'finished', idempotencyKey: 'finished', kind: 'tool-call-finished', payload: { toolCallId: 'new-id', executionOutcome: 'unknown-after-dispatch' } }
    )
    const state = readUnknownEffectRecoveryState(source)
    expect(state.mode).toBe('verify-only')
    expect(state.unresolvedEffects).toContainEqual(expect.objectContaining({ id: 'target:new-id' }))
  })

  it('only accepts a risk decision bound to the current complete unknown set and target invocation', () => {
    const state = readUnknownEffectRecoveryState(snapshot([
      { id: 'origin:a', originInvocationId: 'origin', toolCallId: 'a' },
      { id: 'origin:b', originInvocationId: 'origin', toolCallId: 'b' }
    ]))
    expect(isUnknownEffectDecisionCurrent(state, 'target', ['origin:a', 'origin:b'])).toBe(true)
    expect(isUnknownEffectDecisionCurrent(state, 'target', ['origin:a'])).toBe(false)
    expect(isUnknownEffectDecisionCurrent(state, 'child', ['origin:a', 'origin:b'])).toBe(false)
  })

  it('persists a structured risk decision on the target invocation and does not inherit it to a child', async () => {
    const source = snapshot([{ id: 'origin:a', originInvocationId: 'origin', toolCallId: 'a' }])
    let current = source
    const history = {
      read: async () => current,
      appendBatch: async (events: readonly HistorySnapshot['events'][number][], expectedVersion: number) => {
        expect(expectedVersion).toBe(current.version)
        current = { ...current, version: expectedVersion + events.length, events: [...current.events, ...events] }
        return { version: current.version, duplicate: false }
      }
    }
    await recordUnknownEffectRiskAcceptance({ history, targetInvocationId: 'target', acceptedIds: ['origin:a'], now: 42 })
    expect(readUnknownEffectRecoveryState(current).mode).toBe('risk-accepted')
    const child = snapshot([{ id: 'origin:a', originInvocationId: 'origin', toolCallId: 'a' }])
    child.invocationId = 'child'
    expect(readUnknownEffectRecoveryState(child).mode).toBe('verify-only')
  })

  it('offers a one-time retry only for the exact unresolved tool and input hash', async () => {
    let current = snapshot([{ id: 'origin:a', originInvocationId: 'origin', toolCallId: 'a', toolName: 'write_file', inputHash: 'abc' }])
    const history = {
      read: async () => current,
      appendBatch: async (events: readonly HistorySnapshot['events'][number][], expectedVersion: number) => {
        current = { ...current, version: expectedVersion + events.length, events: [...current.events, ...events] }
        return { version: current.version, duplicate: false }
      }
    }
    await approveOneTimeUnknownEffectRetry({ history, targetInvocationId: 'target', unknownEffectId: 'origin:a', now: 10 })
    expect(await findOneTimeUnknownEffectRetryApproval({ history, targetInvocationId: 'target', toolName: 'edit_file', inputHash: 'abc' })).toBeUndefined()
    expect(await findOneTimeUnknownEffectRetryApproval({ history, targetInvocationId: 'target', toolName: 'write_file', inputHash: 'changed' })).toBeUndefined()
    const approvalEventId = await findOneTimeUnknownEffectRetryApproval({ history, targetInvocationId: 'target', toolName: 'write_file', inputHash: 'abc' })
    expect(approvalEventId).toBeDefined()
    current = { ...current, events: [...current.events,
      { invocationId: 'target', turnId: 'turn', sequence: 3, schemaVersion: 1, eventId: 'consumed', idempotencyKey: 'consumed', kind: 'unknown-effect-retry-consumed', payload: { targetInvocationId: 'target', approvalEventId, consumedAt: 11 } },
      { invocationId: 'target', turnId: 'turn', sequence: 4, schemaVersion: 1, eventId: 'started', idempotencyKey: 'started', kind: 'tool-call-started', payload: { toolCallId: 'retry', toolName: 'write_file', inputHash: 'abc' } }
    ] }
    expect(await findOneTimeUnknownEffectRetryApproval({ history, targetInvocationId: 'target', toolName: 'write_file', inputHash: 'abc' })).toBeUndefined()
  })
})
