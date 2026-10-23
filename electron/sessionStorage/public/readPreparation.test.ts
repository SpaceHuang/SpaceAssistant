import { describe, expect, it } from 'vitest'
import { prepareChatBodyForRead } from './readPreparation'

describe('prepareChatBodyForRead', () => {
  it.each(['PROJECTION_PREPARATION_DEFERRED_LARGE', 'PROJECTION_PREPARATION_UNAVAILABLE',
    'PROJECTION_BUILD_DEFERRED:DEFERRED_LARGE', 'PROJECTION_BUILD_CLAIM_UNAVAILABLE'])(
    'continues to the authoritative reader after %s', async (message) => {
      const events: string[] = []
      await prepareChatBodyForRead(async () => { events.push('prepare'); throw new Error(message) }, 'session')
      events.push('read-authority')
      expect(events).toEqual(['prepare', 'read-authority'])
    })

  it('propagates cancellation and non-projection failures', async () => {
    const failure = new Error('PROJECTION_VIEW_CANCELLED')
    await expect(prepareChatBodyForRead(async () => { throw failure }, 'session')).rejects.toBe(failure)
    const storageFailure = new Error('SQLITE_CANTOPEN')
    await expect(prepareChatBodyForRead(async () => { throw storageFailure }, 'session')).rejects.toBe(storageFailure)
  })
})
