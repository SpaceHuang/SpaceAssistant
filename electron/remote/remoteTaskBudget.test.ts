import { describe, expect, it } from 'vitest'
import {
  applyContinueToken,
  checkRemoteTaskBudget,
  createRemoteTaskBudgetState,
  issueContinueToken,
  recordOutboundWrite,
  recordToolCall,
  resetConsecutiveOutboundWrites,
  stopRemoteTaskBudget,
  beginExecution,
  endExecution
} from './remoteTaskBudget'

describe('remoteTaskBudget', () => {
  it('pauses after maxToolCalls', () => {
    const s = createRemoteTaskBudgetState('t1', {
      maxToolCalls: 3,
      maxExecutionWallSec: 900,
      maxConcurrentExecutions: 1,
      maxConsecutiveOutboundWrites: 10
    })
    recordToolCall(s)
    recordToolCall(s)
    recordToolCall(s)
    expect(checkRemoteTaskBudget(s, 'tool_call').ok).toBe(false)
  })

  it('continue token doubles limits once and is task-bound', () => {
    const s = createRemoteTaskBudgetState('task-a', {
      maxToolCalls: 2,
      maxExecutionWallSec: 900,
      maxConcurrentExecutions: 1,
      maxConsecutiveOutboundWrites: 10
    })
    recordToolCall(s)
    recordToolCall(s)
    expect(checkRemoteTaskBudget(s, 'tool_call').ok).toBe(false)
    const token = issueContinueToken(s)
    expect(applyContinueToken(s, 'wrong')).toBe(false)
    expect(applyContinueToken(s, token)).toBe(true)
    expect(checkRemoteTaskBudget(s, 'tool_call').ok).toBe(true)
  })

  it('stop invalidates continue', () => {
    const s = createRemoteTaskBudgetState('t1')
    const token = issueContinueToken(s)
    stopRemoteTaskBudget(s)
    expect(applyContinueToken(s, token)).toBe(false)
    expect(checkRemoteTaskBudget(s, 'tool_call').ok).toBe(false)
  })

  it('asks on 11th consecutive outbound write then resets', () => {
    const s = createRemoteTaskBudgetState('t1', {
      maxToolCalls: 50,
      maxExecutionWallSec: 900,
      maxConcurrentExecutions: 1,
      maxConsecutiveOutboundWrites: 10
    })
    for (let i = 0; i < 10; i++) {
      expect(checkRemoteTaskBudget(s, 'outbound_write').ok).toBe(true)
      recordOutboundWrite(s)
    }
    expect(checkRemoteTaskBudget(s, 'outbound_write').ok).toBe(false)
    resetConsecutiveOutboundWrites(s)
    expect(checkRemoteTaskBudget(s, 'outbound_write').ok).toBe(true)
  })

  it('enforces concurrent executions = 1', () => {
    const s = createRemoteTaskBudgetState('t1')
    expect(checkRemoteTaskBudget(s, 'start_execution').ok).toBe(true)
    beginExecution(s)
    expect(checkRemoteTaskBudget(s, 'start_execution').ok).toBe(false)
    endExecution(s, 100)
    expect(checkRemoteTaskBudget(s, 'start_execution').ok).toBe(true)
  })
})
