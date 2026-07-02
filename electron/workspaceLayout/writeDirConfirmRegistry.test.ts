import { describe, it, expect } from 'vitest'
import {
  waitForWriteDirConfirm,
  submitWriteDirConfirm,
  cancelAllWriteDirConfirmsForRequest
} from './writeDirConfirmRegistry'

describe('writeDirConfirmRegistry', () => {
  it('resolves with chosen dir when submitted', async () => {
    const p = waitForWriteDirConfirm('r1', 's1')
    submitWriteDirConfirm('r1', 's1', { dir: 'D:/proj' })
    expect(await p).toEqual({ dir: 'D:/proj', confirmedAt: expect.any(Number) })
  })

  it('resolves to null when cancelled', async () => {
    const p = waitForWriteDirConfirm('r2', 's2')
    submitWriteDirConfirm('r2', 's2', null)
    expect(await p).toBeNull()
  })

  it('cancels all pending for a request', async () => {
    const p = waitForWriteDirConfirm('r3', 's3')
    cancelAllWriteDirConfirmsForRequest('r3')
    expect(await p).toBeNull()
  })
})
