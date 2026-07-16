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
})
