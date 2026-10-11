import { describe, expect, it } from 'vitest'
import { parseImConfirmReply, formatImConfirmPromptFooter, IM_CONFIRM_USAGE_HINT, IM_CONFIRM_TRUST_MISCLICK_HINT } from './imConfirmReply'

describe('parseImConfirmReply', () => {
  it('requires confirmId — bare Y/N is usage_hint', () => {
    expect(parseImConfirmReply('Y')).toEqual({ kind: 'usage_hint' })
    expect(parseImConfirmReply('yes')).toEqual({ kind: 'usage_hint' })
    expect(parseImConfirmReply('是')).toEqual({ kind: 'usage_hint' })
    expect(parseImConfirmReply('确认')).toEqual({ kind: 'usage_hint' })
    expect(parseImConfirmReply('N')).toEqual({ kind: 'usage_hint' })
    expect(parseImConfirmReply('Y trust')).toEqual({ kind: 'usage_hint' })
    expect(IM_CONFIRM_USAGE_HINT).toMatch(/引用.*确认提示/)
    expect(IM_CONFIRM_TRUST_MISCLICK_HINT).toMatch(/引用.*确认提示/)
  })

  it('approves with confirmId', () => {
    expect(parseImConfirmReply('Y 00')).toEqual({ kind: 'approve', confirmId: '00' })
    expect(parseImConfirmReply('yes 07')).toEqual({ kind: 'approve', confirmId: '07' })
  })

  it('approves and trusts with confirmId', () => {
    expect(parseImConfirmReply('Y 07 TRUST')).toEqual({
      kind: 'approve_and_trust',
      confirmId: '07'
    })
    expect(parseImConfirmReply('yes 07 trust')).toEqual({
      kind: 'approve_and_trust',
      confirmId: '07'
    })
  })

  it('rejects with confirmId', () => {
    expect(parseImConfirmReply('N 99')).toEqual({ kind: 'reject', confirmId: '99' })
    expect(parseImConfirmReply('取消 42')).toEqual({ kind: 'reject', confirmId: '42' })
  })

  it('treats bare 信任 as misclick', () => {
    expect(parseImConfirmReply('信任')).toEqual({ kind: 'trust_misclick' })
  })

  it('ignores unrelated text', () => {
    expect(parseImConfirmReply('hello')).toEqual({ kind: 'not_confirm' })
  })

  it('does not consume async todo verbs in the synchronous confirmation namespace', () => {
    expect(parseImConfirmReply('批准 07')).toEqual({ kind: 'not_confirm' })
    expect(parseImConfirmReply('拒绝 07')).toEqual({ kind: 'not_confirm' })
  })

  it('rejects non-decimal and non-two-digit ids', () => {
    for (const text of ['Y 1', 'Y 123', 'Y 1234', 'Y A1', 'Y Ａ１', 'Y １２']) {
      expect(parseImConfirmReply(text)).not.toMatchObject({ kind: 'approve' })
      expect(parseImConfirmReply(text)).not.toMatchObject({ kind: 'reject' })
      expect(parseImConfirmReply(text)).not.toMatchObject({ kind: 'approve_and_trust' })
    }
  })

  it('rejects trailing or conflicting command tokens instead of executing a partial confirmation', () => {
    for (const text of ['Y 07 maybe', 'N 07 approve', 'Y 07 TRUST later', '记1 07 extra']) {
      const result = parseImConfirmReply(text)
      expect(result.kind).not.toBe('approve')
      expect(result.kind).not.toBe('reject')
      expect(result.kind).not.toBe('approve_and_trust')
      expect(result.kind).not.toBe('remember')
    }
  })

  it('footer includes confirmId', () => {
    expect(formatImConfirmPromptFooter({ confirmId: '00' })).toContain('00')
    expect(formatImConfirmPromptFooter({ confirmId: '00' })).toMatch(/引用.*本条确认提示/)
  })

  it('footer lists memory tiers as N <id> <label>', () => {
    const text = formatImConfirmPromptFooter({
      confirmId: '07',
      memoryTiers: [
        { key: { kind: 'path', path: 'src/a.ts', level: 'file' }, label: '记住 src/a.ts' },
        { key: { kind: 'remote-write', sessionId: 's1' }, label: '记住 本会话写文件' }
      ]
    })
    expect(text).toContain('1 07 记住 src/a.ts')
    expect(text).toContain('2 07 记住 本会话写文件')
    expect(text).toMatch(/引用.*本条确认提示/)
  })

  it('记N <id> / N <id>：确认并记住第 N 档（memoryTiers 编号）', () => {
    expect(parseImConfirmReply('记1 07')).toEqual({ kind: 'remember', confirmId: '07', tier: 1 })
    expect(parseImConfirmReply('记2 07')).toEqual({ kind: 'remember', confirmId: '07', tier: 2 })
    expect(parseImConfirmReply('记12 07')).toEqual({ kind: 'remember', confirmId: '07', tier: 12 })
  })

  it('accepts the numeric tier shorthand N <id> used by IM replies', () => {
    expect(parseImConfirmReply('1 13')).toEqual({ kind: 'remember', confirmId: '13', tier: 1 })
    expect(parseImConfirmReply('2 13')).toEqual({ kind: 'remember', confirmId: '13', tier: 2 })
  })

  it('记N 缺确认码 → not_confirm；裸记 → 非确认', () => {
    expect(parseImConfirmReply('记1')).toEqual({ kind: 'not_confirm' })
    expect(parseImConfirmReply('记')).toEqual({ kind: 'not_confirm' })
  })
})
