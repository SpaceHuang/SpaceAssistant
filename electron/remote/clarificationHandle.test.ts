import { describe, expect, it } from 'vitest'
import { formatClarificationHandle, generateClarificationHandle, parseClarificationReply } from './clarificationHandle'

describe('remote clarification handle protocol', () => {
  it('generates 13 Crockford Base32 symbols and formats them as 4-4-5', () => {
    const handle = generateClarificationHandle()
    expect(handle).toMatch(/^[0-9A-HJKMNP-TV-Z]{13}$/)
    expect(formatClarificationHandle(handle)).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{5}$/)
    expect(formatClarificationHandle(handle).replaceAll('-', '')).toBe(handle)
  })

  it('parses only the exact selection syntax and normalizes accepted handle casing', () => {
    const handle = 'ABCD-EFGH-JK345'
    expect(parseClarificationReply(`  选择 ${handle.toLowerCase()} 3  `)).toEqual({
      kind: 'selection', handle: 'ABCDEFGHJK345', option: 3
    })
    expect(parseClarificationReply('选择 ABCD-EFGH-JK345 0')).toEqual({ kind: 'control-like-invalid' })
    expect(parseClarificationReply('选择 ABCD-EFGH-JK345 1 extra')).toEqual({ kind: 'control-like-invalid' })
  })

  it('reserves malformed clarification commands while leaving ordinary text alone', () => {
    expect(parseClarificationReply('选择 1234 1')).toEqual({ kind: 'control-like-invalid' })
    expect(parseClarificationReply('选择性地展开解释')).toEqual({ kind: 'ordinary' })
    expect(parseClarificationReply('请继续查找资料')).toEqual({ kind: 'ordinary' })
  })

  it('recognizes a legacy bare option only when a pending clarification exists', () => {
    expect(parseClarificationReply('1', { reserveLegacyOption: true })).toEqual({ kind: 'control-like-invalid' })
    expect(parseClarificationReply('1')).toEqual({ kind: 'ordinary' })
  })

  it('rejects handles outside the frozen alphabet or non-canonical display length', () => {
    expect(parseClarificationReply('选择 ABCI-EFGH-JK345 1')).toEqual({ kind: 'control-like-invalid' })
    expect(parseClarificationReply('选择 ABCD-EFGH-JK34 1')).toEqual({ kind: 'control-like-invalid' })
  })
})
