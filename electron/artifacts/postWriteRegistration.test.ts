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

  it('reports a recoverable audit error when registration fails after the file write', () => {
    expect(() => registerAfterSuccessfulWrite({ success: true, register: () => { throw new Error('database unavailable') } })).toThrow(
      '文件已写入但登记失败'
    )
  })
})
