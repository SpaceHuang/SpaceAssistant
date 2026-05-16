import { describe, expect, it, beforeEach } from 'vitest'
import {
  registerRunRequest,
  resolveSessionIdForRequest,
  unregisterRunRequest,
  unregisterRunRequestsForSession,
  clearRunRequestIndex
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
})
