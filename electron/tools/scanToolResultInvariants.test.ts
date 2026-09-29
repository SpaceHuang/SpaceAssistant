import { describe, expect, it } from 'vitest'

import {
  collectViolations,
  isEnvelopeLike,
  scanJsonlText,
} from '../../scripts/scan-tool-result-invariants.mjs'

describe('scan-tool-result-invariants（R4 历史事件流扫描）', () => {
  it('T-R4-4：干净事件流零矛盾', () => {
    const jsonl = [
      JSON.stringify({ event: 'tool.result', toolUseId: 't1', success: true, data: { exitCode: 0, terminationReason: 'process_exit', status: 'succeeded' } }),
      JSON.stringify({ event: 'tool.result', toolUseId: 't2', success: false, error: 'TOOL_EXEC_FAILED', data: { exitCode: 2, terminationReason: 'process_exit', status: 'failed' } }),
      JSON.stringify({ event: 'tool.result', toolUseId: 't3', success: false, error: 'POLICY_NOT_EXECUTED', notExecuted: true, notExecutedReason: 'policy_denied' }),
      '',
      'not-json-line',
    ].join('\n')
    expect(scanJsonlText(jsonl, 'sample.jsonl')).toEqual([])
  })

  it('T-R4-4：I2 矛盾（exitCode=0 被判失败）被检出', () => {
    const jsonl = [
      JSON.stringify({ type: 'tool_result', payload: { toolUseId: 't1', result: { success: false, error: 'SHELL_PROCESS_EXIT', data: { exitCode: 0, terminationReason: 'process_exit', status: 'succeeded' } } } }),
    ].join('\n')
    const violations = scanJsonlText(jsonl, 'sample.jsonl')
    expect(violations.some((v) => v.invariant === 'I2')).toBe(true)
    expect(violations[0].at).toContain('sample.jsonl:1')
  })

  it('T-R4-4：I4 矛盾（非零退出被判成功）被检出', () => {
    const violations = collectViolations(
      { success: true, data: { exitCode: 127, terminationReason: 'process_exit', status: 'failed' } },
      'x:1'
    )
    expect(violations.some((v) => v.invariant === 'I4')).toBe(true)
  })

  it('非信封形状节点不误报', () => {
    expect(isEnvelopeLike({ success: 'yes' })).toBe(false)
    expect(isEnvelopeLike({ data: { status: 'succeeded' } })).toBe(false)
    expect(isEnvelopeLike(null)).toBe(false)
    expect(collectViolations({ foo: { bar: 1 }, list: [{ success: true, data: { content: 'text' } }] }, 'x')).toEqual([])
  })

  it('I1（成功带 error）与 I3（notExecuted 缺原因）被检出', () => {
    const violations = collectViolations(
      [
        { success: true, error: 'X', data: { status: 'succeeded' } },
        { success: false, notExecuted: true },
      ],
      'x'
    )
    expect(violations.some((v) => v.invariant === 'I1')).toBe(true)
    expect(violations.some((v) => v.invariant === 'I3')).toBe(true)
  })
})
