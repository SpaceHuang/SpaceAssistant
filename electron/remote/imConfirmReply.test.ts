import { describe, expect, it } from 'vitest'
import { parseImConfirmReply } from './imConfirmReply'

describe('parseImConfirmReply', () => {
  it('approves once', () => {
    expect(parseImConfirmReply('Y')).toEqual({ kind: 'approve' })
    expect(parseImConfirmReply('yes')).toEqual({ kind: 'approve' })
    expect(parseImConfirmReply('是')).toEqual({ kind: 'approve' })
    expect(parseImConfirmReply('确认')).toEqual({ kind: 'approve' })
  })

  it('approves and trusts', () => {
    expect(parseImConfirmReply('Y trust')).toEqual({ kind: 'approve_and_trust' })
    expect(parseImConfirmReply('yes trust')).toEqual({ kind: 'approve_and_trust' })
    expect(parseImConfirmReply('确认并信任')).toEqual({ kind: 'approve_and_trust' })
  })

  it('rejects', () => {
    expect(parseImConfirmReply('N')).toEqual({ kind: 'reject' })
    expect(parseImConfirmReply('取消')).toEqual({ kind: 'reject' })
  })

  it('treats bare 信任 as misclick', () => {
    expect(parseImConfirmReply('信任')).toEqual({ kind: 'trust_misclick' })
  })

  it('ignores unrelated text', () => {
    expect(parseImConfirmReply('hello')).toEqual({ kind: 'not_confirm' })
  })
})
