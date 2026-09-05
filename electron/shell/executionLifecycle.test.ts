import { describe, expect, it } from 'vitest'
import { ExecutionLifecycle } from './executionLifecycle'

describe('ExecutionLifecycle', () => {
  it('只允许更高优先级终态替换较低优先级竞态结果', () => {
    const lifecycle = new ExecutionLifecycle<string>()
    expect(lifecycle.finalize('process_exit', 'exit')).toBe(true)
    expect(lifecycle.finalize('transport_error', 'transport')).toBe(false)
    expect(lifecycle.finalize('timeout', 'timeout')).toBe(true)
    expect(lifecycle.finalize('user_cancel', 'cancel')).toBe(true)
    expect(lifecycle.state).toEqual({ reason: 'user_cancel', value: 'cancel' })
  })

  it('同一终态及低优先级重复结算均被忽略', () => {
    const lifecycle = new ExecutionLifecycle<number>()
    expect(lifecycle.settled).toBe(false)
    expect(lifecycle.finalize('timeout', 1)).toBe(true)
    expect(lifecycle.finalize('timeout', 2)).toBe(false)
    expect(lifecycle.finalize('process_exit', 3)).toBe(false)
    expect(lifecycle.state?.value).toBe(1)
  })

  it.each([
    ['user_cancel', 'timeout'],
    ['user_cancel', 'output_limit'],
    ['user_cancel', 'process_exit'],
    ['user_cancel', 'transport_error'],
    ['timeout', 'output_limit'],
    ['timeout', 'process_exit'],
    ['timeout', 'transport_error'],
    ['output_limit', 'process_exit'],
    ['output_limit', 'transport_error'],
    ['process_exit', 'transport_error']
  ] as const)('%s 优先于 %s', (higher, lower) => {
    const lifecycle = new ExecutionLifecycle<string>()
    expect(lifecycle.finalize(lower, lower)).toBe(true)
    expect(lifecycle.finalize(higher, higher)).toBe(true)
    expect(lifecycle.state).toEqual({ reason: higher, value: higher })
  })

  it('同一事件窗口内 abort/timeout/output-limit/close/spawn-error 只保留最高优先级', () => {
    const lifecycle = new ExecutionLifecycle<string>()
    const events = [
      ['process_exit', 'close'],
      ['transport_error', 'spawn-error'],
      ['output_limit', 'output-limit'],
      ['timeout', 'timeout'],
      ['user_cancel', 'abort']
    ] as const
    for (const [reason, value] of events) lifecycle.finalize(reason, value)
    expect(lifecycle.state).toEqual({ reason: 'user_cancel', value: 'abort' })
    expect(lifecycle.finalize('process_exit', 'late-close')).toBe(false)
  })
})
