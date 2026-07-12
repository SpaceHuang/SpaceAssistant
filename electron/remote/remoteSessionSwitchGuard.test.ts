import { afterEach, describe, expect, it } from 'vitest'
import {
  beginLlm,
  beginTool,
  endTool,
  resetRemoteSessionSwitchStateForTests
} from './remoteSessionSwitchState'
import { canSwitchRemoteSession } from './remoteSessionSwitchGuard'
import {
  REMOTE_SESSION_SWITCH_BUSY_CALLER,
  REMOTE_SESSION_SWITCH_BUSY_TARGET
} from './remoteSessionGuardMessages'
import {
  releaseRemoteSession,
  resetRunningRemoteAgentRegistryForTests,
  tryClaimRemoteSession
} from '../feishu/runningRemoteAgentRegistry'

const defaultOpts = {
  callerRequestId: 'req-1',
  hasPendingConfirm: () => false
}

describe('canSwitchRemoteSession', () => {
  afterEach(() => {
    resetRemoteSessionSwitchStateForTests()
    resetRunningRemoteAgentRegistryForTests()
  })

  it('allows when both sessions idle', () => {
    expect(canSwitchRemoteSession('a', 'b', defaultOpts)).toEqual({ allowed: true })
  })

  it('allows when caller only registry-claimed (no blockers)', () => {
    tryClaimRemoteSession('a', 4)
    expect(canSwitchRemoteSession('a', 'b', { ...defaultOpts, callerRequestId: 'req-inbound' })).toEqual({
      allowed: true
    })
    releaseRemoteSession('a')
  })

  it('rejects when caller has tool in-flight (T14)', () => {
    beginTool('a', 'req-1', 'read_file')
    const result = canSwitchRemoteSession('a', 'b', defaultOpts)
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.code).toBe('caller_busy')
      expect(result.blockers).toContain('tool_in_flight')
      expect(result.error).toBe(REMOTE_SESSION_SWITCH_BUSY_CALLER)
    }
  })

  it('rejects when target has tool in-flight (T15)', () => {
    beginTool('b', 'req-2', 'grep')
    const result = canSwitchRemoteSession('a', 'b', defaultOpts)
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.code).toBe('target_busy')
      expect(result.blockers).toContain('tool_in_flight')
      expect(result.error).toBe(REMOTE_SESSION_SWITCH_BUSY_TARGET)
    }
  })

  it('rejects when caller has pending confirm', () => {
    const result = canSwitchRemoteSession('a', 'b', {
      callerRequestId: 'req-1',
      hasPendingConfirm: (id) => id === 'a'
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.blockers).toContain('pending_confirm')
    }
  })

  it('allows switch-only LLM in-flight on caller request', () => {
    beginLlm('a', 'req-1')
    expect(canSwitchRemoteSession('a', 'b', defaultOpts)).toEqual({ allowed: true })
  })

  it('rejects when caller ran non-switch tool with LLM still in-flight', () => {
    beginLlm('a', 'req-1')
    beginTool('a', 'req-1', 'list_directory')
    endTool('a', 'req-1', 'list_directory')
    const result = canSwitchRemoteSession('a', 'b', defaultOpts)
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.blockers).toContain('llm_in_flight')
    }
  })

  it('allows idempotent switch to same session when idle', () => {
    expect(canSwitchRemoteSession('a', 'a', defaultOpts)).toEqual({ allowed: true })
  })
})
