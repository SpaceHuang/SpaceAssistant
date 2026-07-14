import { describe, expect, it } from 'vitest'
import { WECHAT_REMOTE_SKILL_HINT, buildWeChatRemoteSystemAppendix } from './wechatPrompts'

describe('wechatPrompts outbound wording', () => {
  it('skill hint says send immediately without confirm', () => {
    expect(WECHAT_REMOTE_SKILL_HINT).toContain('调用即发送')
    expect(WECHAT_REMOTE_SKILL_HINT).not.toContain('需用户确认')
  })

  it('system appendix does not require outbound confirm', () => {
    const appendix = buildWeChatRemoteSystemAppendix({
      userId: 'u1',
      confirmPolicy: 'always'
    })
    expect(appendix).not.toContain('需用户确认')
    expect(appendix).not.toContain('出站需确认')
  })
})
