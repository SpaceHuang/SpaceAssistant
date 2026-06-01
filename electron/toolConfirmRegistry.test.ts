import { describe, expect, it } from 'vitest'
import { submitToolConfirmResponse, waitForToolConfirm } from './toolConfirmRegistry'

describe('toolConfirmRegistry', () => {
  it('defers confirm resolve to the next event-loop turn', async () => {
    let resolvedSync = false
    const pending = waitForToolConfirm('req-defer', 'tool-1')
    void pending.then(() => {
      resolvedSync = true
    })
    submitToolConfirmResponse('req-defer', 'tool-1', true)
    expect(resolvedSync).toBe(false)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(resolvedSync).toBe(true)
    await expect(pending).resolves.toBe('approved')
  })
})
