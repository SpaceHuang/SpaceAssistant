import { describe, expect, it, vi } from 'vitest'
import type { HistoryEvent, HistorySnapshot } from '../../packages/agent-sdk/src/history'
import type { SessionHistoryPort } from '../sessionStorage/contracts'
import { createTrackScopedHistoryPort, createCrossSessionTrackScopedHistoryPort } from './trackScopedHistoryPort'

function snapshot(invocationId: string): HistorySnapshot {
  return { invocationId, version: 0, schemaVersion: 1, events: [] }
}

function makeHistory(): SessionHistoryPort {
  return {
    appendBatch: vi.fn(async () => ({ version: 1, duplicate: false })),
    read: vi.fn(async (invocationId: string) => snapshot(invocationId)),
    readLatestInvocationForSession: vi.fn(async () => ({ kind: 'completed' as const, snapshot: snapshot('turn-b') }))
  }
}

describe('Track-scoped HistoryPort', () => {
  it('permits reads and appends only for invocations in the frozen view', async () => {
    const history = makeHistory()
    const scoped = createTrackScopedHistoryPort(history, {
      sessionId: 'session-1', allowedInvocationIds: ['turn-a1', 'turn-a2']
    })
    await expect(scoped.read('turn-a1')).resolves.toMatchObject({ invocationId: 'turn-a1' })
    await expect(scoped.read('turn-b1')).rejects.toThrow('TRACK_HISTORY_INVOCATION_OUT_OF_SCOPE')
    const event: HistoryEvent = { eventId: 'e1', idempotencyKey: 'i1', invocationId: 'turn-b1', turnId: 'turn-b1', sequence: 1, schemaVersion: 1, kind: 'invocation-context-committed', payload: {} }
    await expect(scoped.appendBatch([event], 0)).rejects.toThrow('TRACK_HISTORY_INVOCATION_OUT_OF_SCOPE')
    expect(history.appendBatch).not.toHaveBeenCalled()
  })

  it('rejects transcript commits from another session', async () => {
    const history = makeHistory()
    const scoped = createTrackScopedHistoryPort(history, { sessionId: 'session-1', allowedInvocationIds: ['turn-a'] })
    const event: HistoryEvent = { eventId: 'e1', idempotencyKey: 'i1', invocationId: 'turn-a', turnId: 'turn-a', sequence: 1, schemaVersion: 1, kind: 'invocation-context-committed', payload: {} }
    await expect(scoped.appendBatch([event], 0, { sessionId: 'session-2', baseVersion: 0, outcome: 'completed', messages: [] }))
      .rejects.toThrow('TRACK_HISTORY_SESSION_MISMATCH')
  })

  it('does not expose a latest invocation outside the Track allowlist', async () => {
    const history = makeHistory()
    const scoped = createTrackScopedHistoryPort(history, { sessionId: 'session-1', allowedInvocationIds: ['turn-a'] })
    await expect(scoped.readLatestInvocationForSession('session-1')).resolves.toEqual({ kind: 'none' })
    await expect(scoped.readLatestInvocationForSession('other')).rejects.toThrow('TRACK_HISTORY_SESSION_MISMATCH')
  })

  it('does not disclose an unavailable invocation outside the Track allowlist', async () => {
    const history = makeHistory()
    history.readLatestInvocationForSession = vi.fn(async () => ({ kind: 'unavailable' as const, invocationId: 'turn-b' }))
    const scoped = createTrackScopedHistoryPort(history, { sessionId: 'session-1', allowedInvocationIds: ['turn-a'] })
    await expect(scoped.readLatestInvocationForSession('session-1')).resolves.toEqual({ kind: 'none' })
  })

  it('passes through an allowlisted latest invocation and enforces the exact session', async () => {
    const history = makeHistory()
    history.readLatestInvocationForSession = vi.fn(async () => ({ kind: 'completed' as const, snapshot: snapshot('turn-a') }))
    const scoped = createTrackScopedHistoryPort(history, { sessionId: 'session-1', allowedInvocationIds: ['turn-a'] })
    await expect(scoped.readLatestInvocationForSession('session-1')).resolves.toMatchObject({ kind: 'completed', snapshot: { invocationId: 'turn-a' } })
  })

  it('routes cross-session invocation reads by the frozen session map and keeps writes session-local', async () => {
    const origin = makeHistory()
    const current = makeHistory()
    const scoped = createCrossSessionTrackScopedHistoryPort((sessionId) => sessionId === 'origin' ? origin : current, {
      currentSessionId: 'current', allowedInvocationIds: ['origin-turn', 'current-turn'],
      invocationSessionMap: { 'origin-turn': 'origin', 'current-turn': 'current' }
    })
    await expect(scoped.read('origin-turn')).resolves.toMatchObject({ invocationId: 'origin-turn' })
    expect(origin.read).toHaveBeenCalledWith('origin-turn')
    expect(current.read).not.toHaveBeenCalled()
    const event: HistoryEvent = { eventId: 'current-event', idempotencyKey: 'current-event', invocationId: 'current-turn', turnId: 'current-turn', sequence: 1, schemaVersion: 1, kind: 'invocation-context-committed', payload: {} }
    await scoped.appendBatch([event], 0, { sessionId: 'current', baseVersion: 0, outcome: 'completed', messages: [] })
    expect(current.appendBatch).toHaveBeenCalledOnce()
    const crossSession: HistoryEvent = { ...event, invocationId: 'origin-turn', turnId: 'origin-turn' }
    await expect(scoped.appendBatch([event, crossSession], 0)).rejects.toThrow('TRACK_HISTORY_APPEND_CROSSES_SESSIONS')
    await expect(scoped.read('foreign')).rejects.toThrow('TRACK_HISTORY_INVOCATION_OUT_OF_SCOPE')
  })
})
