import { describe, expect, it } from 'vitest'
import { mergeShellConfig, DEFAULT_SHELL_CONFIG } from '../../src/shared/domainTypes'

describe('mergeShellConfig', () => {
  it('桌面安装后的默认 shell 配置为开启', () => {
    expect(mergeShellConfig(null).enabled).toBe(true)
    expect(mergeShellConfig(null).shellDefaultTimeoutSec).toBe(DEFAULT_SHELL_CONFIG.shellDefaultTimeoutSec)
    expect(mergeShellConfig(null).outputMode).toBe('terminal')
  })
})
