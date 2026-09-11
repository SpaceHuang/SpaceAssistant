import { describe, expect, it } from 'vitest'
import { buildCommandRetryKey, isInfrastructureError, shouldStopToolRetry } from './toolErrorRetryPolicy'

describe('shouldStopToolRetry', () => {
  it('命令 retry key 使用不可逆调用指纹，且不包含原始命令', () => {
    const key = buildCommandRetryKey({ toolName: 'run_shell', errorCode: 'SHELL_PROCESS_EXIT', command: 'printf secret-token', cwd: '/tmp/project', planDigest: 'a'.repeat(64) })
    expect(key).not.toContain('secret-token')
    expect(key).toMatch(/^run_shell:SHELL_PROCESS_EXIT:[0-9a-f]{64}$/)
  })

  it('cwd 或命令变化会生成不同的命令级 key', () => {
    const a = buildCommandRetryKey({ toolName: 'run_shell', errorCode: 'SHELL_PROCESS_EXIT', command: 'false', cwd: '/a' })
    const b = buildCommandRetryKey({ toolName: 'run_shell', errorCode: 'SHELL_PROCESS_EXIT', command: 'false', cwd: '/b' })
    expect(a).not.toBe(b)
  })

  it('基础设施错误独立于命令级 process_exit', () => {
    expect(isInfrastructureError('SHELL_SPAWN_ERROR')).toBe(true)
    expect(isInfrastructureError('SHELL_PROCESS_EXIT')).toBe(false)
  })

  it('基础设施错误首次出现即停止通用重试', () => {
    expect(shouldStopToolRetry('run_shell', 'SHELL_SPAWN_ERROR', undefined, false)).toBe(true)
  })
  it('方言错配熔断后立即停止 run_shell 原样重试', () => {
    expect(shouldStopToolRetry('run_shell', 'SHELL_DIALECT_MISMATCH', { retryExhausted: true }, false)).toBe(true)
  })

  it('其他工具错误仍使用通用重复错误策略', () => {
    expect(shouldStopToolRetry('read_file', 'SHELL_DIALECT_MISMATCH', { retryExhausted: true }, false)).toBe(false)
    expect(shouldStopToolRetry('run_shell', 'other', undefined, true)).toBe(true)
  })
})
