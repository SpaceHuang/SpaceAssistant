import { describe, expect, it } from 'vitest'
import { shouldShowToolConfirm } from './useActionablePendingConfirms'
import type { PendingConfirmItem } from '../services/pendingConfirmStore'
import type { Session } from '../../shared/domainTypes'
import { SESSION_META_PLAN, SESSION_META_PLAN_EXECUTION } from '../../shared/planTypes'

function item(over: Partial<PendingConfirmItem> = {}): PendingConfirmItem {
  return {
    sessionId: 's1',
    requestId: 'req-1',
    toolUseId: 'tool-1',
    toolName: 'write_file',
    input: {},
    riskLevel: 'medium',
    createdAt: Date.now(),
    ...over
  }
}

function session(metadata: Record<string, unknown>): Session {
  return {
    id: 's1',
    name: 'test',
    createdAt: 1,
    updatedAt: 1,
    model: 'm',
    temperature: 0.7,
    maxTokens: 4096,
    metadata
  }
}

describe('shouldShowToolConfirm', () => {
  it('filters write confirm during plan auto run', () => {
    const sess = session({
      [SESSION_META_PLAN]: {
        planId: 'p1',
        status: 'executing',
        planFilePath: 'a.md',
        currentStepIndex: 0,
        stepsTotal: 3,
        version: 1,
        createdAt: 1,
        approvedAt: 1,
        cancelledAt: null,
        envSnapshot: { gitHead: null, timestamp: 1 }
      },
      [SESSION_META_PLAN_EXECUTION]: {
        runState: 'running',
        executionMode: 'auto',
        toolConfirmPolicy: 'confirm_high_risk',
        startedAt: 1,
        pausedAt: null,
        activeRunRequestId: 'req-1'
      }
    })
    expect(
      shouldShowToolConfirm(item(), {
        sessions: [sess],
        activeRequestIds: new Set(['req-1'])
      })
    ).toBe(false)
  })

  it('keeps run_script confirm during plan run', () => {
    const sess = session({
      [SESSION_META_PLAN]: {
        planId: 'p1',
        status: 'executing',
        planFilePath: 'a.md',
        currentStepIndex: 0,
        stepsTotal: 3,
        version: 1,
        createdAt: 1,
        approvedAt: 1,
        cancelledAt: null,
        envSnapshot: { gitHead: null, timestamp: 1 }
      },
      [SESSION_META_PLAN_EXECUTION]: {
        runState: 'running',
        executionMode: 'auto',
        toolConfirmPolicy: 'confirm_high_risk',
        startedAt: 1,
        pausedAt: null
      }
    })
    expect(
      shouldShowToolConfirm(item({ toolName: 'run_script' }), {
        sessions: [sess],
        activeRequestIds: new Set(['req-1'])
      })
    ).toBe(true)
  })
})
