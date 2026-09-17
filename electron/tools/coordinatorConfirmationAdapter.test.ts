import { describe, expect, it } from 'vitest'
import {
  coordinatorConfirmHook,
  mapLegacyConfirmation,
  migrateLegacyRejectReason
} from './coordinatorConfirmationAdapter'

describe('coordinatorConfirmationAdapter', () => {
  it.each([
    [{ outcome: 'approved', needsConfirm: true }, { approved: true }],
    [{ outcome: 'timeout', needsConfirm: true }, { approved: false, errorCode: 'CONFIRM_TIMEOUT' }],
    [
      { outcome: 'rejected', needsConfirm: true, rejectReason: 'policy', policyCode: 'authorization_revoked' },
      { approved: false, errorCode: 'AUTHORIZATION_REVOKED' }
    ],
    [
      { outcome: 'rejected', needsConfirm: true, rejectReason: 'policy', policyCode: 'remote_read_only' },
      { approved: false, errorCode: 'REMOTE_READ_ONLY' }
    ],
    [{ outcome: 'rejected', needsConfirm: true, rejectReason: 'policy' }, { approved: false, errorCode: 'INVOCATION_NOT_CONFIRMED' }],
    [{ outcome: 'rejected', needsConfirm: true, rejectReason: 'user' }, { approved: false, errorCode: 'INVOCATION_NOT_CONFIRMED' }],
    [{ outcome: 'rejected', needsConfirm: true, rejectReason: 'agent' }, { approved: false, errorCode: 'INVOCATION_NOT_CONFIRMED' }],
    [{ outcome: 'rejected', needsConfirm: true, rejectReason: 'no-answerer' }, { approved: false, errorCode: 'INVOCATION_NOT_CONFIRMED' }]
  ] as const)('映射 %o 为 %o', (snapshot, expected) => {
    expect(mapLegacyConfirmation(snapshot)).toEqual(expected)
  })

  it('P1-2 旧值迁移映射（评审 N2）：user→user；remote_read_only/authorization_revoked→policy', () => {
    expect(migrateLegacyRejectReason('user')).toBe('user')
    expect(migrateLegacyRejectReason('remote_read_only')).toBe('policy')
    expect(migrateLegacyRejectReason('authorization_revoked')).toBe('policy')
  })

  it('只把适配后的 approved 结果暴露给 coordinator confirm hook', async () => {
    await expect(coordinatorConfirmHook({ outcome: 'approved', needsConfirm: true })({} as never)).resolves.toBe(true)
    await expect(coordinatorConfirmHook({ outcome: 'timeout', needsConfirm: true })({} as never)).resolves.toBe(false)
  })
})
