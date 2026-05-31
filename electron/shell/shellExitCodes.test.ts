import { describe, expect, it } from 'vitest'
import { describeExitCode } from './shellExitCodes'

describe('shellExitCodes', () => {
  it('maps common codes', () => {
    expect(describeExitCode(127)).toMatch(/未找到/)
    expect(describeExitCode(0)).toBeUndefined()
  })
})
