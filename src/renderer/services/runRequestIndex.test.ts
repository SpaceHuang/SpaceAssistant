import { describe, expect, it, beforeEach } from 'vitest'
import {
  registerRunRequest,
  resolveSessionIdForRequest,
  unregisterRunRequest,
  unregisterRunRequestsForSession,
  clearRunRequestIndex,
  resolveRunRequest
} from './runRequestIndex'

describe('runRequestIndex', () => {
  beforeEach(() => {
    clearRunRequestIndex()
  })

  it('maps request to session', () => {
    registerRunRequest('s1', 'req-1')
    expect(resolveSessionIdForRequest('req-1')).toBe('s1')
  })

  it('unregisters by session', () => {
    registerRunRequest('s1', 'r1')
    registerRunRequest('s1', 'r2')
    registerRunRequest('s2', 'r3')
    unregisterRunRequestsForSession('s1')
    expect(resolveSessionIdForRequest('r1')).toBeUndefined()
    expect(resolveSessionIdForRequest('r3')).toBe('s2')
  })

  it('unregisters single request', () => {
    registerRunRequest('s1', 'r1')
    unregisterRunRequest('r1')
    expect(resolveSessionIdForRequest('r1')).toBeUndefined()
  })

  it('isolates sessions that share requestId and unregisters by both request and owner', () => {
    registerRunRequest('session-a', 'shared-request', 'turn-a')
    registerRunRequest('session-b', 'shared-request', 'turn-b')
    expect(resolveSessionIdForRequest('shared-request')).toBeUndefined()
    expect(resolveRunRequest('session-a', 'shared-request')).toEqual({ sessionId: 'session-a', requestId: 'shared-request', turnId: 'turn-a' })
    expect(resolveRunRequest('session-b', 'shared-request')).toEqual({ sessionId: 'session-b', requestId: 'shared-request', turnId: 'turn-b' })

    unregisterRunRequest('shared-request', 'session-a')
    expect(resolveSessionIdForRequest('shared-request')).toBe('session-b')
    expect(resolveRunRequest('session-a', 'shared-request')).toBeUndefined()
    expect(resolveRunRequest('session-b', 'shared-request')).toEqual({ sessionId: 'session-b', requestId: 'shared-request', turnId: 'turn-b' })
  })
})
