import { describe, expect, it } from 'vitest'
import { mergeShellConfig, DEFAULT_SHELL_CONFIG } from '../../src/shared/domainTypes'

describe('mergeShellConfig', () => {
  it('defaults enabled false', () => {
    expect(mergeShellConfig(null).enabled).toBe(false)
    expect(mergeShellConfig(null).shellDefaultTimeoutSec).toBe(DEFAULT_SHELL_CONFIG.shellDefaultTimeoutSec)
    expect(mergeShellConfig(null).outputMode).toBe('terminal')
  })
})
