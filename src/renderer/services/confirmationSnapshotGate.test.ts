import { describe, expect, it } from 'vitest'
import { canApproveConfirmation, type ConfirmationSnapshot } from './confirmationSnapshotGate'

const display = { sessionId: 's1', turnId: 't1', requestId: 'r1', version: 4, lifecycle: 'awaiting-confirmation' as const, confirmingToolCallId: 'tool-1' }
const snapshot: ConfirmationSnapshot = { sessionId: 's1', turnId: 't1', requestId: 'r1', turnVersion: 4, toolCallId: 'tool-1', confirmation: { complete: true } }

describe('confirmation snapshot gate', () => {
  it('仅允许与最新 display 四元组完全匹配的完整快照批准', () => {
    expect(canApproveConfirmation(display, snapshot)).toBe(true)
    expect(canApproveConfirmation({ ...display, version: 3 }, snapshot)).toBe(false)
    expect(canApproveConfirmation({ ...display, confirmingToolCallId: 'tool-2' }, snapshot)).toBe(false)
  })

  it('非 awaiting、缺失或旧快照始终不可批准', () => {
    expect(canApproveConfirmation({ ...display, lifecycle: 'running' }, snapshot)).toBe(false)
    expect(canApproveConfirmation(display, undefined)).toBe(false)
    expect(canApproveConfirmation(display, { ...snapshot, turnVersion: 5 })).toBe(false)
  })
})
