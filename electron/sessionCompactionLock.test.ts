import { describe, expect, it } from 'vitest'
import { isSessionContextCompacting, isSessionContextCompactionLocked, withSessionContextCompactionLock, withSessionTurnAdmission } from './sessionCompactionLock'

describe('session compaction lock', () => {
  it('allows one transaction per session and releases its lock after success or failure', async () => {
    let release!: () => void
    const firstPromise = withSessionContextCompactionLock('s1', () => new Promise<void>((resolve) => { release = resolve }))
    await Promise.resolve()
    expect(isSessionContextCompacting('s1')).toBe(true)
    expect(isSessionContextCompactionLocked('s1')).toBe(true)
    await expect(withSessionContextCompactionLock('s1', async () => 'duplicate')).resolves.toEqual({ status: 'busy' })
    await expect(withSessionContextCompactionLock('s2', async () => 'parallel')).resolves.toEqual({ status: 'ran', value: 'parallel' })
    release()
    await expect(firstPromise).resolves.toEqual({ status: 'ran', value: undefined })
    expect(isSessionContextCompacting('s1')).toBe(false)
    await expect(withSessionTurnAdmission('s1', () => 'admitted')).resolves.toBe('admitted')
    await expect(withSessionContextCompactionLock('s1', async () => { throw new Error('failed') })).rejects.toThrow('failed')
    expect(isSessionContextCompacting('s1')).toBe(false)
  })

  it('serializes turn admission and compaction admission for the same session', async () => {
    let release!: () => void
    const preparing = withSessionTurnAdmission('s3', () => new Promise<void>((resolve) => { release = resolve }))
    await Promise.resolve()
    await expect(withSessionContextCompactionLock('s3', async () => 'not-allowed')).resolves.toEqual({ status: 'busy' })
    release()
    await expect(preparing).resolves.toBeUndefined()
  })
})
