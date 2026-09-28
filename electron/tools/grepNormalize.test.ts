import { describe, expect, it } from 'vitest'

import { normalizeGrepArgs, validateGrepInput } from './builtinExecutors'

describe('normalizeGrepArgs（R7 单一入口：校验与执行同源）', () => {
  it('T-R7-1：等价默认值不报错——count + context:0 / files_with_matches + show_line_number:true / multiline:false 全部通过', () => {
    expect(normalizeGrepArgs({ pattern: 'x', output_mode: 'count', context: 0 }).ok).toBe(true)
    expect(
      normalizeGrepArgs({ pattern: 'x', output_mode: 'files_with_matches', show_line_number: true }).ok
    ).toBe(true)
    expect(normalizeGrepArgs({ pattern: 'x', output_mode: 'count', multiline: false }).ok).toBe(true)
    // show_line_number 在非 content 模式下任意取值均无效果 → 通过（评审 P2-1）
    expect(
      normalizeGrepArgs({ pattern: 'x', output_mode: 'count', show_line_number: false }).ok
    ).toBe(true)
  })

  it('T-R7-2：有实际效果的冲突仍报错——count + context:3 / content 之外的 multiline:true', () => {
    const r = normalizeGrepArgs({ pattern: 'x', output_mode: 'count', context: 3 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('param-conflict')
      expect(r.error.field).toBe('context=3')
      expect(r.error.mode).toBe('count')
      expect(r.error.allowed).toContain('content')
      expect(r.error.suggestedWrite).toBeTruthy()
    }
    const r2 = normalizeGrepArgs({ pattern: 'x', output_mode: 'files_with_matches', multiline: true })
    expect(r2.ok).toBe(false)
  })

  it('参数域校验保持：output_mode 枚举 / context 0～1000 整数 / head_limit', () => {
    expect(normalizeGrepArgs({ pattern: 'x', output_mode: 'bogus' }).ok).toBe(false)
    expect(normalizeGrepArgs({ pattern: 'x', output_mode: 'content', context: 1001 }).ok).toBe(false)
    expect(normalizeGrepArgs({ pattern: 'x', output_mode: 'content', context: -1 }).ok).toBe(false)
    expect(normalizeGrepArgs({ pattern: 'x', head_limit: -5 }).ok).toBe(false)
  })

  it('T-R7-3：生效值默认填充——执行器只读 result.args（含默认 headLimit=100、includeIgnored=false）', () => {
    const r = normalizeGrepArgs({ pattern: 'x', output_mode: 'content', context: 2 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.args).toMatchObject({
        outputMode: 'content',
        context: 2,
        headLimit: 100,
        includeIgnored: false,
        showLineNumber: true
      })
      expect(r.effectful).toContain('context=2')
    }
    // 非 content 模式：context/multiline/show_line_number 归一为无效果
    const r2 = normalizeGrepArgs({ pattern: 'x', output_mode: 'count', context: 0, multiline: true })
    if (r2.ok) {
      expect(r2.args.context).toBeUndefined()
      expect(r2.args.multiline).toBe(false)
    }
  })

  it('validateGrepInput 薄壳与 normalizeGrepArgs 判定一致（等价默认值不再报错）', () => {
    expect(validateGrepInput({ output_mode: 'count', context: 0 })).toBeNull()
    expect(validateGrepInput({ output_mode: 'count', show_line_number: true })).toBeNull()
    expect(validateGrepInput({ output_mode: 'count', context: 3 })).toBeTruthy()
    expect(validateGrepInput({ output_mode: 'bogus' })).toBeTruthy()
  })
})
