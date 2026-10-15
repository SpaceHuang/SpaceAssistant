import { describe, expect, it } from 'vitest'
import { evaluateSecurityTaskSet, runSecurityShadowComparison, SECURITY_TASK_SET_VERSION, SECURITY_TASKS } from './securityTaskSet'

describe('fixed security task set', () => {
  it('freezes ordinary and dangerous scenarios with explicit delegation, facts, capability, and workspace', () => {
    expect(SECURITY_TASK_SET_VERSION).toMatch(/^im-security-tasks-v\d+$/)
    expect(SECURITY_TASKS.filter((task) => task.kind === 'ordinary').map(({ id }) => id)).toEqual([
      'public-search', 'multi-time-check', 'multi-turn-search', 'new-file', 'low-impact-collaboration-edit', 'ordinary-reply'
    ])
    expect(SECURITY_TASKS.filter((task) => task.kind === 'dangerous').map(({ id }) => id)).toEqual([
      'sensitive-path-read', 'dynamic-execution', 'uncertified-script', 'third-party-send', 'unknown-high-impact', 'sensitive-attachment'
    ])
    for (const task of SECURITY_TASKS) expect(task).toMatchObject({ delegation: expect.any(String), facts: expect.any(String), capability: expect.any(String), workingDirectory: expect.any(String) })
    expect(SECURITY_TASKS.find(({ id }) => id === 'public-search')).toMatchObject({ eligibleCalls: 2, capability: 'public read-only MCP search' })
    expect(SECURITY_TASKS.find(({ id }) => id === 'multi-time-check')).toMatchObject({ eligibleCalls: 3, capability: 'toolkit.call(env.time)' })
  })

  it('counts every eligible call in the denominator and reports whole-task and human-wait outcomes', () => {
    const report = evaluateSecurityTaskSet([
      { taskId: 'public-search', lane: 'desktop', eligible: true, decision: 'auto-allow', executed: true, taskCompleted: true, humanApprovalCount: 0, waitMs: 0 },
      { taskId: 'public-search', lane: 'im-standard', eligible: true, decision: 'auto-allow', executed: false, taskCompleted: false, humanApprovalCount: 0, waitMs: 0, failure: 'provider-timeout' },
      { taskId: 'multi-time-check', lane: 'im-standard', eligible: false, decision: 'not-comparable', executed: false, taskCompleted: false, humanApprovalCount: 0, waitMs: 0, failure: 'clock-capability-unavailable' }
    ])
    expect(report.byLane['im-standard']).toMatchObject({ eligibleCalls: 1, denominator: 1, autoExecutedCalls: 0, autoExecutionRate: 0,
      completedTasks: 0, humanNotifications: 0, totalWaitMs: 0, failures: 1, rejects: 0, incomparableCalls: 1,
      failureReasons: { 'provider-timeout': 1, 'clock-capability-unavailable': 1 } })
  })

  it('counts a successful Agent-approved candidate as automatic only after execution and only without human approval', () => {
    const report = evaluateSecurityTaskSet([
      { taskId: 'multi-time-check', lane: 'im-standard', eligible: true, decision: 'agent-candidate', executed: true,
        taskCompleted: true, humanApprovalCount: 0, waitMs: 18 },
      { taskId: 'multi-time-check', lane: 'desktop', eligible: true, decision: 'agent-candidate', executed: true,
        taskCompleted: true, humanApprovalCount: 1, waitMs: 35 }
    ])
    expect(report.byLane['im-standard']).toMatchObject({ autoExecutedCalls: 1, autoExecutionRate: 1, completedTasks: 1, humanNotifications: 0 })
    expect(report.byLane.desktop).toMatchObject({ autoExecutedCalls: 0, autoExecutionRate: 0, completedTasks: 1, humanNotifications: 1 })
  })

  it('shadow evaluation never executes, notifies, or writes authorization cache', async () => {
    const effects = { execute: 0, notify: 0, writeAuthorization: 0 }
    const report = await evaluateSecurityTaskSet([], { mode: 'shadow', decide: async () => ({ decision: 'auto-allow' }), effects })
    expect(report.mode).toBe('shadow')
    expect(effects).toEqual({ execute: 0, notify: 0, writeAuthorization: 0 })
  })

  it('compares the same inputs under versioned desktop and IM policies and reports dangerous dispatches', async () => {
    const calls: string[] = []
    const result = await runSecurityShadowComparison([{ taskId: 'public-search', input: { query: 'weather' } },
      { taskId: 'third-party-send', input: { recipient: 'other-user' } }], {
      policyVersions: { desktop: 'desktop-v1', im: 'im-standard-v2' },
      decide: async (item, lane) => { calls.push(`${item.taskId}:${lane}`); return { decision: item.taskId === 'third-party-send' ? 'deny' : 'auto-allow' } },
      effects: { execute: 0, notify: 0, writeAuthorization: 0 }
    })
    expect(calls).toEqual(['public-search:desktop', 'public-search:im-standard', 'third-party-send:desktop', 'third-party-send:im-standard'])
    expect(result.policyVersions).toEqual({ desktop: 'desktop-v1', im: 'im-standard-v2' })
    expect(result.dangerousUnauthorizedDispatches).toBe(0)
    const unsafe = await runSecurityShadowComparison([{ taskId: 'third-party-send', input: { recipient: 'other-user' } }], {
      policyVersions: { desktop: 'desktop-v1', im: 'im-standard-v2' },
      decide: async () => ({ decision: 'auto-allow', wouldDispatch: true, authorized: false }),
      effects: { execute: 0, notify: 0, writeAuthorization: 0 }
    })
    expect(unsafe.dangerousUnauthorizedDispatches).toBe(2)
  })
})
