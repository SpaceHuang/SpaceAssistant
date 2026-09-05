import { describe, expect, it } from 'vitest'
import { validateShellExecutionConfig } from './shellExecutionConfigValidation'

const base = { enabled: true, shellDefaultTimeoutSec: 300 }

describe('validateShellExecutionConfig', () => {
  it.each([
    [{ ...base, shellDefaultTimeoutSec: 0 }, 'SHELL_TIMEOUT_CONFIG_INVALID'],
    [{ ...base, shellDefaultTimeoutSec: Number.NaN }, 'SHELL_TIMEOUT_CONFIG_INVALID'],
    [{ ...base, maxInlineOutputBytes: 0 }, 'SHELL_OUTPUT_LIMIT_CONFIG_INVALID'],
    [{ ...base, executable: '   ' }, 'SHELL_EXECUTABLE_CONFIG_INVALID'],
    [{ ...base, argsPrefix: ['-c', 1] }, 'SHELL_ARGS_CONFIG_INVALID']
  ])('拒绝无效配置 %#', (config, error) => {
    expect(validateShellExecutionConfig(config as never)).toBe(error)
  })

  it('接受默认配置和显式 executable', () => {
    expect(validateShellExecutionConfig({ ...base, executable: '/bin/bash', argsPrefix: ['-lc'] })).toBeUndefined()
    expect(validateShellExecutionConfig(undefined)).toBeUndefined()
  })
})
