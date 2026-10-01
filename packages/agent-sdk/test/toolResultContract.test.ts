import { describe, expect, it } from 'vitest'

import {
  LEGACY_TOOL_ERROR_CODE_MAP,
  TOOL_ERROR_CODES,
  isToolErrorCode,
  normalizeToolResultEnvelope,
} from '../src/toolResultContract'
import { TOOL_ENVELOPE_KNOWN_ERROR_CODES } from '../../../src/shared/errorCodes'

describe('ToolErrorCode 闭合枚举', () => {
  it('五类失败码齐备且可判', () => {
    expect([...TOOL_ERROR_CODES]).toEqual([
      'TOOL_EXEC_FAILED',
      'TOOL_EXECUTOR_ERROR',
      'POLICY_NOT_EXECUTED',
      'TOOL_USER_CANCELLED',
      'TOOL_INVALID_INPUT'
    ])
    expect(isToolErrorCode('TOOL_EXEC_FAILED')).toBe(true)
    expect(isToolErrorCode('SHELL_PROCESS_EXIT')).toBe(false)
  })

  it('旧码映射表覆盖 run_shell 现网 5 个 SHELL_* 码（长期保留）', () => {
    expect(LEGACY_TOOL_ERROR_CODE_MAP).toEqual({
      SHELL_PROCESS_EXIT: 'TOOL_EXEC_FAILED',
      SHELL_SPAWN_ERROR: 'TOOL_EXECUTOR_ERROR',
      SHELL_TIMEOUT: 'TOOL_EXEC_FAILED',
      SHELL_CANCELLED: 'TOOL_USER_CANCELLED',
      SHELL_ARTIFACT_PATH_INVALID: 'TOOL_EXECUTOR_ERROR'
    })
  })
})

describe('normalizeToolResultEnvelope', () => {
  it('I0：结构损坏（缺 success 布尔）→ TOOL_EXECUTOR_ERROR + violation', () => {
    const { envelope, violations } = normalizeToolResultEnvelope({ data: { status: 'succeeded' } })
    expect(envelope.success).toBe(false)
    expect(envelope.error).toBe('TOOL_EXECUTOR_ERROR')
    expect(violations.some((v) => v.invariant === 'I0')).toBe(true)
  })

  it('I1/I2：exitCode=0 + process_exit 的成功事实不得被判失败（归一为成功并告警）', () => {
    // 今天的病根：矛盾时把成功改判失败
    const raw = {
      success: false,
      error: 'SHELL_PROCESS_EXIT',
      notExecuted: true,
      notExecutedReason: 'tool_error_threshold',
      data: { exitCode: 0, terminationReason: 'process_exit', status: 'succeeded' }
    }
    const { envelope, violations } = normalizeToolResultEnvelope(raw)
    expect(envelope.success).toBe(true)
    expect(envelope.error).toBeUndefined()
    expect(envelope.notExecuted).toBeUndefined()
    expect(envelope.notExecutedReason).toBeUndefined()
    expect(violations.some((v) => v.invariant === 'I2')).toBe(true)
  })

  it('I2 保护范围：output_limit / timeout / user_cancel 不受保护（exitCode=0 也不得归一为成功）', () => {
    for (const terminationReason of ['output_limit', 'timeout', 'user_cancel'] as const) {
      const raw = {
        success: false,
        error: 'OUTPUT_LIMIT_REACHED',
        data: { exitCode: 0, terminationReason, status: 'output_limited' }
      }
      const { envelope } = normalizeToolResultEnvelope(raw)
      expect(envelope.success).toBe(false)
    }
  })

  it('I4：非零退出码不得被判成功（归一为失败）', () => {
    const raw = {
      success: true,
      data: { exitCode: 127, terminationReason: 'process_exit', status: 'failed' }
    }
    const { envelope, violations } = normalizeToolResultEnvelope(raw)
    expect(envelope.success).toBe(false)
    expect(envelope.error).toBe('TOOL_EXEC_FAILED')
    expect(violations.some((v) => v.invariant === 'I4')).toBe(true)
  })

  it('I4：用户取消（status=cancelled）不得被判成功', () => {
    const raw = {
      success: true,
      data: { exitCode: null, terminationReason: 'user_cancel', status: 'cancelled' }
    }
    const { envelope } = normalizeToolResultEnvelope(raw)
    expect(envelope.success).toBe(false)
  })

  it('I1：成功分支携带 error → 清除并告警', () => {
    const raw = {
      success: true,
      error: 'SOMETHING_ODD',
      data: { exitCode: 0, terminationReason: 'process_exit', status: 'succeeded' }
    }
    const { envelope, violations } = normalizeToolResultEnvelope(raw)
    expect(envelope.success).toBe(true)
    expect(envelope.error).toBeUndefined()
    expect(violations.some((v) => v.invariant === 'I1')).toBe(true)
  })

  it('I3：notExecuted 必须伴随 success=false 与原因', () => {
    const raw = {
      success: true,
      notExecuted: true,
      data: undefined
    }
    const { envelope, violations } = normalizeToolResultEnvelope(raw)
    expect(envelope.success).toBe(false)
    expect(envelope.notExecuted).toBe(true)
    expect(violations.some((v) => v.invariant === 'I3')).toBe(true)
  })

  it('正常成功信封：零告警直通', () => {
    const raw = {
      success: true,
      data: { exitCode: 0, terminationReason: 'process_exit', status: 'succeeded', stdout: 'ok' }
    }
    const { envelope, violations } = normalizeToolResultEnvelope(raw)
    expect(envelope).toEqual(raw)
    expect(violations).toEqual([])
  })

  it('正常失败信封（非零退出）：零告警直通', () => {
    const raw = {
      success: false,
      error: 'SHELL_PROCESS_EXIT',
      data: { exitCode: 2, terminationReason: 'process_exit', status: 'failed' }
    }
    const { envelope, violations } = normalizeToolResultEnvelope(raw)
    expect(envelope).toEqual(raw)
    expect(violations).toEqual([])
  })

  it('I5：旧码在映射表内视为合法（映射仅服务历史回显，归一不改写）', () => {
    const raw = {
      success: false,
      error: 'SHELL_SPAWN_ERROR',
      data: { status: 'spawn_failed' }
    }
    const { envelope, violations } = normalizeToolResultEnvelope(raw)
    expect(envelope.error).toBe('SHELL_SPAWN_ERROR')
    expect(violations).toEqual([])
  })

  it('I5：未知错误码（不在闭合枚举与映射表）→ 保留原值但告警', () => {
    const raw = {
      success: false,
      error: 'TOTALLY_UNKNOWN_CODE',
      data: { status: 'failed' }
    }
    const { envelope, violations } = normalizeToolResultEnvelope(raw)
    expect(envelope.error).toBe('TOTALLY_UNKNOWN_CODE')
    expect(violations.some((v) => v.invariant === 'I5')).toBe(true)
  })

  it('F3（评审 2026-09-28）：SCRIPT_*/LARK_* 业务失败码在已知集合内，不再记契约违规', () => {
    for (const code of ['SCRIPT_TIMEOUT', 'SCRIPT_CANCELLED', 'SCRIPT_SPAWN_ERROR', 'LARK_RUNNER_UNAVAILABLE']) {
      const r = normalizeToolResultEnvelope({ success: false, error: code, data: undefined }, { knownErrorCodes: TOOL_ENVELOPE_KNOWN_ERROR_CODES })
      expect(r.violations, code).toEqual([])
    }
  })

  it('knownErrorCodes 注入：调用方扩展合法码集后不再告警', () => {
    const raw = { success: false, error: 'FILE_NOT_FOUND', data: undefined }
    const strict = normalizeToolResultEnvelope(raw)
    expect(strict.violations.some((v) => v.invariant === 'I5')).toBe(true)
    const relaxed = normalizeToolResultEnvelope(raw, {
      knownErrorCodes: new Set([...TOOL_ERROR_CODES, 'FILE_NOT_FOUND'])
    })
    expect(relaxed.violations).toEqual([])
  })

  it('非 run_shell 信封（无 data 事实）：保持原值，不做事实归一', () => {
    const raw = { success: true, data: { content: 'file body' } }
    const { envelope, violations } = normalizeToolResultEnvelope(raw)
    expect(envelope).toEqual(raw)
    expect(violations).toEqual([])
  })
})
