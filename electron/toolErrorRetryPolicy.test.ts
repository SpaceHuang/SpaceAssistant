import { describe, expect, it } from 'vitest'
import { shouldStopToolRetry } from './toolErrorRetryPolicy'

describe('shouldStopToolRetry', () => {
  it('方言错配熔断后立即停止 run_shell 原样重试', () => {
    expect(shouldStopToolRetry('run_shell', 'SHELL_DIALECT_MISMATCH', { retryExhausted: true }, false)).toBe(true)
  })

  it('其他工具错误仍使用通用重复错误策略', () => {
    expect(shouldStopToolRetry('read_file', 'SHELL_DIALECT_MISMATCH', { retryExhausted: true }, false)).toBe(false)
    expect(shouldStopToolRetry('run_shell', 'other', undefined, true)).toBe(true)
  })
})
