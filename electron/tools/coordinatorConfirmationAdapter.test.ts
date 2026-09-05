import { describe, expect, it } from 'vitest'
import { coordinatorConfirmHook, mapLegacyConfirmation } from './coordinatorConfirmationAdapter'

describe('coordinatorConfirmationAdapter', () => {
  it.each([
    [{ outcome: 'approved', needsConfirm: true }, { approved: true }],
    [{ outcome: 'timeout', needsConfirm: true }, { approved: false, errorCode: 'CONFIRM_TIMEOUT' }],
    [{ outcome: 'rejected', needsConfirm: true, rejectReason: 'authorization_revoked' }, { approved: false, errorCode: 'AUTHORIZATION_REVOKED' }],
    [{ outcome: 'rejected', needsConfirm: true, rejectReason: 'remote_read_only' }, { approved: false, errorCode: 'REMOTE_READ_ONLY' }],
    [{ outcome: 'rejected', needsConfirm: true, rejectReason: 'user' }, { approved: false, errorCode: 'INVOCATION_NOT_CONFIRMED' }]
  ] as const)('映射 %o 为 %o', (snapshot, expected) => {
    expect(mapLegacyConfirmation(snapshot)).toEqual(expected)
  })

  it('只把适配后的 approved 结果暴露给 coordinator confirm hook', async () => {
    await expect(coordinatorConfirmHook({ outcome: 'approved', needsConfirm: true })({} as never)).resolves.toBe(true)
    await expect(coordinatorConfirmHook({ outcome: 'timeout', needsConfirm: true })({} as never)).resolves.toBe(false)
  })
})
