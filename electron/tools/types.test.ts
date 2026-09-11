import { describe, expect, it } from 'vitest'
import { validateToolExecutorResult, validateToolExecutorResultForTool } from './types'

describe('validateToolExecutorResult', () => {
  it('将缺少 success 的非法 executor 结果转换为稳定诊断', () => {
    expect(validateToolExecutorResult({})).toMatchObject({
      success: false,
      error: 'SHELL_RESULT_CONTRACT_VIOLATION',
      data: { processResult: null, status: 'result_invalid' }
    })
  })

  it('不修改合法成功结果', () => {
    const result = { success: true, data: { status: 'succeeded' } }
    expect(validateToolExecutorResult(result)).toBe(result)
  })

  it('拒绝 success 与 data.status 矛盾的结果', () => {
    expect(validateToolExecutorResult({ success: false, error: 'bad', data: { status: 'succeeded' } })).toMatchObject({
      error: 'SHELL_RESULT_CONTRACT_VIOLATION',
      data: { status: 'result_invalid' }
    })
  })

  it('只对进程工具应用进程终态校验', () => {
    const result = { success: true, data: { status: 'failed', stdout: 'ticket created', code: 'INC-42' } }
    expect(validateToolExecutorResultForTool('mcp_incident', result)).toBe(result)
    expect(validateToolExecutorResultForTool('run_shell', result)).toMatchObject({
      success: false,
      error: 'SHELL_RESULT_CONTRACT_VIOLATION',
      data: { status: 'result_invalid' }
    })
  })

  it('普通工具缺少错误字段时使用通用结果契约错误', () => {
    expect(validateToolExecutorResultForTool('mcp_incident', { success: false, data: { issueId: 'INC-42' } })).toMatchObject({
      success: false,
      error: 'TOOL_RESULT_CONTRACT_VIOLATION',
      data: { issueId: 'INC-42' }
    })
  })
})
