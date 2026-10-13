import { describe, expect, it } from 'vitest'
import { WECHAT_REMOTE_SKILL_HINT, buildWeChatRemoteSystemAppendix } from './wechatPrompts'

describe('wechatPrompts outbound wording', () => {
  it('skill hint does not tell the model that calling an outbound tool sends immediately', () => {
    expect(WECHAT_REMOTE_SKILL_HINT).not.toContain('调用即发送')
  })

  it('remote guidance does not ask for desktop-only follow-up or internal session IDs', () => {
    const appendix = buildWeChatRemoteSystemAppendix({ userId: 'u1' })
    expect(appendix).not.toMatch(/sessionId|requestId|会话\$/i)
    expect(appendix).not.toContain('请打开 SpaceAssistant')
    expect(WECHAT_REMOTE_SKILL_HINT).not.toContain('桌面')
  })

  it('system appendix does not require outbound confirm', () => {
    const appendix = buildWeChatRemoteSystemAppendix({
      userId: 'u1'
    })
    expect(appendix).not.toContain('需用户确认')
    expect(appendix).not.toContain('出站需确认')
  })

  it('uses the common policy version and disabled gate instead of channel-owned confirmation settings', () => {
    const appendix = buildWeChatRemoteSystemAppendix({
      userId: 'u1',
      policySnapshot: {
        domain: 'im', policyBehaviorVersion: 'im-standard-v2', revision: 4,
        snapshot: { selectedPackage: 'standard', enabled: false }
      }
    } as never)
    expect(appendix).toContain('im-standard-v2')
    expect(appendix).toContain('standard')
    expect(appendix).toContain('自动审核未启用')
    expect(appendix).not.toContain('wechat.remoteConfirmPolicy')
    expect(appendix).not.toContain('remoteConfirmPolicy=')
  })
})
