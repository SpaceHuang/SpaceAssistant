import { describe, expect, it } from 'vitest'
import { parseImConfirmReply, formatImConfirmPromptFooter } from './imConfirmReply'

describe('parseImConfirmReply', () => {
  it('requires confirmId — bare Y/N is usage_hint', () => {
    expect(parseImConfirmReply('Y')).toEqual({ kind: 'usage_hint' })
    expect(parseImConfirmReply('yes')).toEqual({ kind: 'usage_hint' })
    expect(parseImConfirmReply('是')).toEqual({ kind: 'usage_hint' })
    expect(parseImConfirmReply('确认')).toEqual({ kind: 'usage_hint' })
    expect(parseImConfirmReply('N')).toEqual({ kind: 'usage_hint' })
    expect(parseImConfirmReply('Y trust')).toEqual({ kind: 'usage_hint' })
  })

  it('approves with confirmId', () => {
    expect(parseImConfirmReply('Y AB12')).toEqual({ kind: 'approve', confirmId: 'AB12' })
    expect(parseImConfirmReply('yes ab12')).toEqual({ kind: 'approve', confirmId: 'AB12' })
  })

  it('approves and trusts with confirmId', () => {
    expect(parseImConfirmReply('Y AB12 TRUST')).toEqual({
      kind: 'approve_and_trust',
      confirmId: 'AB12'
    })
    expect(parseImConfirmReply('yes ab12 trust')).toEqual({
      kind: 'approve_and_trust',
      confirmId: 'AB12'
    })
  })

  it('rejects with confirmId', () => {
    expect(parseImConfirmReply('N AB12')).toEqual({ kind: 'reject', confirmId: 'AB12' })
    expect(parseImConfirmReply('取消 AB12')).toEqual({ kind: 'reject', confirmId: 'AB12' })
  })

  it('treats bare 信任 as misclick', () => {
    expect(parseImConfirmReply('信任')).toEqual({ kind: 'trust_misclick' })
  })

  it('ignores unrelated text', () => {
    expect(parseImConfirmReply('hello')).toEqual({ kind: 'not_confirm' })
  })

  it('footer includes confirmId', () => {
    expect(formatImConfirmPromptFooter({ confirmId: 'AB12' })).toContain('AB12')
  })

  it('footer lists memory tiers as 记N <id> <label>', () => {
    const text = formatImConfirmPromptFooter({
      confirmId: 'AB12',
      memoryTiers: [
        { key: { kind: 'path', path: 'src/a.ts', level: 'file' }, label: '记住 src/a.ts' },
        { key: { kind: 'remote-write', sessionId: 's1' }, label: '记住 本会话写文件' }
      ]
    })
    expect(text).toContain('记1 AB12 记住 src/a.ts')
    expect(text).toContain('记2 AB12 记住 本会话写文件')
  })

  it('记N <id>：确认并记住第 N 档（memoryTiers 编号）', () => {
    expect(parseImConfirmReply('记1 AB12')).toEqual({ kind: 'remember', confirmId: 'AB12', tier: 1 })
    expect(parseImConfirmReply('记2 ab12')).toEqual({ kind: 'remember', confirmId: 'AB12', tier: 2 })
    expect(parseImConfirmReply('记12 AB12')).toEqual({ kind: 'remember', confirmId: 'AB12', tier: 12 })
  })

  it('记N 缺确认码 → not_confirm；裸记 → 非确认', () => {
    expect(parseImConfirmReply('记1')).toEqual({ kind: 'not_confirm' })
    expect(parseImConfirmReply('记')).toEqual({ kind: 'not_confirm' })
  })
})
