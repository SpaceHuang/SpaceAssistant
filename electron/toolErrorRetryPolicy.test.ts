import { describe, expect, it } from 'vitest'
import { buildCommandRetryKey, isInfrastructureError, normalizeFileToolIdentity, normalizeToolErrorClass, SemanticToolRetryTracker, shouldStopToolRetry } from './toolErrorRetryPolicy'

describe('shouldStopToolRetry', () => {
  it('普通执行失败不会因重复计数终止 Turn', () => {
    expect(shouldStopToolRetry('edit_file', 'READ_REQUIRED', {})).toBe(false)
    expect(shouldStopToolRetry('run_shell', 'SHELL_PROCESS_EXIT', {})).toBe(false)
  })
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
    expect(isInfrastructureError('TOOL_EXECUTOR_ERROR')).toBe(true)
    expect(isInfrastructureError('SHELL_PROCESS_EXIT')).toBe(false)
  })

  it('基础设施错误首次出现即停止通用重试', () => {
    expect(shouldStopToolRetry('run_shell', 'SHELL_SPAWN_ERROR', undefined)).toBe(true)
  })
  it('方言错配熔断后立即停止 run_shell 原样重试', () => {
    expect(shouldStopToolRetry('run_shell', 'SHELL_DIALECT_MISMATCH', { retryExhausted: true })).toBe(true)
  })

  it('其他工具错误仍使用通用重复错误策略', () => {
    expect(shouldStopToolRetry('read_file', 'SHELL_DIALECT_MISMATCH', { retryExhausted: true })).toBe(false)
    expect(shouldStopToolRetry('run_shell', 'other', undefined)).toBe(false)
  })

  it('同一模型响应中的兄弟调用不累计为重试，不同文件身份相互独立', () => {
    const tracker = new SemanticToolRetryTracker(3)
    for (const [toolCallId, identity] of [['a', 'edit_file:/a'], ['b', 'edit_file:/b'], ['c', 'edit_file:/c'], ['d', 'edit_file:/a']]) {
      tracker.recordFailure({ response: 1, toolCallId, identity, errorClass: 'READ_REQUIRED' })
    }
    expect(tracker.observe({ response: 2, toolCallId: 'e', identity: 'edit_file:/a', errorClass: 'READ_REQUIRED' })).toBe(false)
  })

  it('相同语义操作仅在收到结果后的后续模型响应再次提出时达到阈值', () => {
    const tracker = new SemanticToolRetryTracker(3)
    tracker.recordFailure({ response: 1, toolCallId: 'a', identity: 'edit_file:/a', errorClass: 'READ_REQUIRED' })
    expect(tracker.observe({ response: 2, toolCallId: 'b', identity: 'edit_file:/a', errorClass: 'READ_REQUIRED' })).toBe(false)
    tracker.recordFailure({ response: 2, toolCallId: 'b', identity: 'edit_file:/a', errorClass: 'READ_REQUIRED' })
    expect(tracker.observe({ response: 3, toolCallId: 'c', identity: 'edit_file:/a', errorClass: 'READ_REQUIRED' })).toBe(false)
    tracker.recordFailure({ response: 3, toolCallId: 'c', identity: 'edit_file:/a', errorClass: 'READ_REQUIRED' })
    expect(tracker.observe({ response: 4, toolCallId: 'd', identity: 'edit_file:/a', errorClass: 'READ_REQUIRED' })).toBe(true)
  })

  it('同一错误响应中的重复 toolCallId 只计一次，且错误类别彼此独立', () => {
    const tracker = new SemanticToolRetryTracker(2)
    tracker.recordFailure({ response: 1, toolCallId: 'a', identity: 'write:/a', errorClass: 'READ_REQUIRED' })
    tracker.recordFailure({ response: 1, toolCallId: 'b', identity: 'write:/a', errorClass: 'READ_REQUIRED' })
    expect(tracker.observe({ response: 2, toolCallId: 'c', identity: 'write:/a', errorClass: 'READ_REQUIRED' })).toBe(false)
    expect(tracker.observe({ response: 2, toolCallId: 'c', identity: 'write:/a', errorClass: 'TARGET_NOT_FOUND' })).toBe(false)
  })

  it('文件路径身份规范化并屏蔽原始路径，错误文本映射为稳定类别', () => {
    expect(normalizeFileToolIdentity('edit_file', { path: 'docs\\./a.md' })).toBe(normalizeFileToolIdentity('edit_file', { path: 'docs/a.md' }))
    expect(normalizeFileToolIdentity('edit_file', { path: 'docs/a.md' })).toBe(normalizeFileToolIdentity('edit_file', { file_path: 'docs/a.md' }))
    expect(normalizeFileToolIdentity('edit_file', { path: 'docs/a.md' })).toBe(normalizeFileToolIdentity('edit_file', { filePath: 'docs/a.md' }))
    expect(normalizeFileToolIdentity('edit_file', { path: 'docs/a.md' })).not.toBe(normalizeFileToolIdentity('edit_file', { path: 'docs/b.md' }))
    expect(normalizeFileToolIdentity('edit_file', { path: 'docs/a.md', oldText: 'one', newText: 'two' })).not.toBe(normalizeFileToolIdentity('edit_file', { path: 'docs/a.md', oldText: 'one', newText: 'three' }))
    expect(normalizeFileToolIdentity('edit_file', { path: 'secret/path.md' })).not.toContain('secret')
    expect(normalizeFileToolIdentity('write_file', { path: 'secret/path.md', content: 'secret contents' })).not.toContain('secret contents')
    expect(normalizeToolErrorClass('文件尚未在本会话中通过 read_file 读取')).toBe('READ_REQUIRED')
  })
})
