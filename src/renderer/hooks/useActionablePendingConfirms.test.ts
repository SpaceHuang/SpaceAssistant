import { describe, expect, it } from 'vitest'
import { shouldShowToolConfirm } from './useActionablePendingConfirms'
import type { PendingConfirmItem } from '../services/pendingConfirmStore'
import type { Session } from '../../shared/domainTypes'

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

function session(): Session {
  return {
    id: 's1',
    name: 'test',
    createdAt: 1,
    updatedAt: 1,
    model: 'm',
    temperature: 0.7,
    maxTokens: 4096,
    metadata: {}
  }
}

describe('shouldShowToolConfirm', () => {
  it('shows when session exists and request is active', () => {
    expect(
      shouldShowToolConfirm(item(), {
        sessions: [session()],
        activeRequestIds: new Set(['req-1'])
      })
    ).toBe(true)
  })

  it('hides when request is not active', () => {
    expect(
      shouldShowToolConfirm(item(), {
        sessions: [session()],
        activeRequestIds: new Set()
      })
    ).toBe(false)
  })

  it('hides when session is missing', () => {
    expect(
      shouldShowToolConfirm(item(), {
        sessions: [],
        activeRequestIds: new Set(['req-1'])
      })
    ).toBe(false)
  })
})
