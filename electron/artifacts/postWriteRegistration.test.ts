import { describe, expect, it } from 'vitest'
import { registerAfterSuccessfulWrite } from './postWriteRegistration'

describe('registerAfterSuccessfulWrite', () => {
  it('does not create an artifact record for a failed write', () => {
    let calls = 0
    registerAfterSuccessfulWrite({ success: false, register: () => { calls += 1 } })
    expect(calls).toBe(0)
  })

  it('registers only after a successful write', () => {
    let calls = 0
    registerAfterSuccessfulWrite({ success: true, register: () => { calls += 1 } })
    expect(calls).toBe(1)
  })
})
