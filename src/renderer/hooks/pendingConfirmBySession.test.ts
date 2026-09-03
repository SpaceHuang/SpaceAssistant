import { describe, expect, it } from 'vitest'
import type { PendingConfirmItem } from '../services/pendingConfirmStore'
import { pendingConfirmBySession } from './pendingConfirmBySession'

const item = (overrides: Partial<PendingConfirmItem> = {}): PendingConfirmItem => ({
  sessionId: 's1', requestId: 'r1', toolUseId: 't1', toolName: 'run_shell', input: {},
  riskLevel: 'medium', createdAt: 10, ...overrides
})

describe('pendingConfirmBySession', () => {
  it('聚合可操作项，按会话去重并保留最早项', () => {
    const result = pendingConfirmBySession(
      [item(), item({ toolUseId: 't2', createdAt: 20 }), item({ sessionId: 's2', requestId: 'r2', createdAt: 5 }), item({ sessionId: 'missing' })],
      [{ id: 's1' }, { id: 's2' }],
      { s1: { requestId: 'r1' }, s2: { requestId: 'r2' } }
    )

    expect(result.get('s1')).toEqual({ count: 2, firstToolUseId: 't1', firstCreatedAt: 10 })
    expect(result.get('s2')).toEqual({ count: 1, firstToolUseId: 't1', firstCreatedAt: 5 })
    expect(result.has('missing')).toBe(false)
  })

  it('忽略不在运行请求集合中的确认项', () => {
    expect(pendingConfirmBySession([item()], [{ id: 's1' }], {})).toEqual(new Map())
  })
})
