import { describe, expect, it } from 'vitest'
import { validateToolExecutorResult, validateToolExecutorResultForTool, validateToolExecutorResultWithViolations } from './types'

describe('validateToolExecutorResult', () => {
  it('将缺少 success 的非法 executor 结果转换为稳定诊断，并产出 I0 violation', () => {
    const { result, violations } = validateToolExecutorResultWithViolations({})
    expect(result).toMatchObject({
      success: false,
      error: 'SHELL_RESULT_CONTRACT_VIOLATION',
      data: { processResult: null, status: 'result_invalid' }
    })
    expect(violations.some((v) => v.invariant === 'I0')).toBe(true)
    expect(validateToolExecutorResult({})).toMatchObject({ success: false, error: 'SHELL_RESULT_CONTRACT_VIOLATION' })
  })

  it('不修改合法成功结果', () => {
    const result = { success: true, data: { status: 'succeeded' } }
    expect(validateToolExecutorResult(result)).toBe(result)
  })

  it('R4：有事实依据的成功（exitCode=0+process_exit）不再被判失败——按事实归一为成功并告警', () => {
    const { result, violations } = validateToolExecutorResultWithViolations({
      success: false,
      error: 'SHELL_PROCESS_EXIT',
      data: { exitCode: 0, terminationReason: 'process_exit', status: 'succeeded' }
    })
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(violations.some((v) => v.invariant === 'I2')).toBe(true)
  })

  it('无进程事实的信封不做事实归一（不再「矛盾即判失败」）', () => {
    const result = validateToolExecutorResult({ success: false, error: 'bad', data: { status: 'succeeded' } })
    expect(result).toMatchObject({ success: false, error: 'bad' })
  })

  it('只对进程工具应用进程事实归一；非进程工具不做', () => {
    const result = { success: true, data: { status: 'failed', stdout: 'ticket created', code: 'INC-42' } }
    expect(validateToolExecutorResultForTool('mcp_incident', result)).toBe(result)
    // 无 exitCode/terminationReason 事实 → 保留原值（旧「矛盾判失败」方向已废弃）
    expect(validateToolExecutorResultForTool('run_shell', result)).toBe(result)
  })

  it('进程事实矛盾（success=true + exitCode!=0）被归一为失败（I4）', () => {
    const { result, violations } = validateToolExecutorResultWithViolations({
      success: true,
      data: { exitCode: 127, terminationReason: 'process_exit', status: 'failed' }
    })
    expect(result.success).toBe(false)
    expect(result.error).toBe('TOOL_EXEC_FAILED')
    expect(violations.some((v) => v.invariant === 'I4')).toBe(true)
  })

  it('失败信封缺少 error 字段时补 TOOL_EXEC_FAILED 并告警（可解释性）', () => {
    const { result, violations } = validateToolExecutorResultWithViolations({
      success: false,
      data: { exitCode: 1, terminationReason: 'process_exit', status: 'failed' }
    })
    expect(result.success).toBe(false)
    expect(result.error).toBe('TOOL_EXEC_FAILED')
    expect(violations.some((v) => v.invariant === 'I5')).toBe(true)
  })

  it('普通工具缺少错误字段时使用通用结果契约错误', () => {
    expect(validateToolExecutorResultForTool('mcp_incident', { success: false, data: { issueId: 'INC-42' } })).toMatchObject({
      success: false,
      error: 'TOOL_RESULT_CONTRACT_VIOLATION',
      data: { issueId: 'INC-42' }
    })
  })
})
