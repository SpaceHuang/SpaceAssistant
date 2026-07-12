import { afterEach, describe, expect, it } from 'vitest'
import {
  beginLlm,
  beginTool,
  clearRequest,
  endLlm,
  endTool,
  getSessionSwitchBlockers,
  resetRemoteSessionSwitchStateForTests
} from './remoteSessionSwitchState'

describe('remoteSessionSwitchState', () => {
  afterEach(() => {
    resetRemoteSessionSwitchStateForTests()
  })

  it('returns empty blockers when idle', () => {
    expect(getSessionSwitchBlockers('s1')).toEqual([])
  })

  it('tracks tool_in_flight per session', () => {
    beginTool('s1', 'r1', 'read_file')
    expect(getSessionSwitchBlockers('s1')).toContain('tool_in_flight')
    endTool('s1', 'r1', 'read_file')
    expect(getSessionSwitchBlockers('s1')).toEqual([])
  })

  it('tracks llm_in_flight per session', () => {
    beginLlm('s1', 'r1')
    expect(getSessionSwitchBlockers('s1')).toContain('llm_in_flight')
    endLlm('s1', 'r1')
    expect(getSessionSwitchBlockers('s1')).toEqual([])
  })

  it('exempts caller llm when switch-only request', () => {
    beginLlm('s1', 'r1')
    expect(getSessionSwitchBlockers('s1', { exemptRequestId: 'r1' })).toEqual([])
  })

  it('does not exempt llm after non-switch tool on same request', () => {
    beginLlm('s1', 'r1')
    beginTool('s1', 'r1', 'list_directory')
    endTool('s1', 'r1', 'list_directory')
    expect(getSessionSwitchBlockers('s1', { exemptRequestId: 'r1' })).toContain('llm_in_flight')
  })

  it('switch_session tool does not mark nonSwitchTool', () => {
    beginLlm('s1', 'r1')
    beginTool('s1', 'r1', 'switch_session')
    endTool('s1', 'r1', 'switch_session')
    expect(getSessionSwitchBlockers('s1', { exemptRequestId: 'r1' })).toEqual([])
  })

  it('includes pending_confirm from callback', () => {
    expect(
      getSessionSwitchBlockers('s1', { hasPendingConfirm: (id) => id === 's1' })
    ).toEqual(['pending_confirm'])
  })

  it('clearRequest removes request-scoped state', () => {
    beginLlm('s1', 'r1')
    beginTool('s1', 'r1', 'grep')
    clearRequest('r1')
    expect(getSessionSwitchBlockers('s1')).toEqual([])
  })

  it('isolates concurrent requests on same session', () => {
    beginTool('s1', 'r1', 'read_file')
    expect(getSessionSwitchBlockers('s1', { exemptRequestId: 'r2' })).toContain('tool_in_flight')
  })
})
