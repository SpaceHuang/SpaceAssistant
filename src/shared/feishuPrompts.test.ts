import { describe, expect, it } from 'vitest'
import { buildFeishuRemoteSystemAppendix } from './feishuPrompts'

describe('feishuPrompts shared IM policy wording', () => {
  it('describes the actual common policy gate and omits the old channel policy field', () => {
    const appendix = buildFeishuRemoteSystemAppendix({
      messageId: 'message-1',
      policySnapshot: {
        domain: 'im', policyBehaviorVersion: 'im-standard-v2', revision: 9,
        snapshot: { selectedPackage: 'standard', enabled: false }
      }
    } as never)
    expect(appendix).toContain('im-standard-v2')
    expect(appendix).toContain('standard')
    expect(appendix).toContain('自动审核未启用')
    expect(appendix).not.toContain('remoteConfirmPolicy=')
    expect(appendix).not.toContain('feishu_confirm')
  })

  it('does not expose inbound IDs or desktop-oriented reply instructions to the model', () => {
    const appendix = buildFeishuRemoteSystemAppendix({ messageId: 'internal-message-id' })
    expect(appendix).not.toContain('internal-message-id')
    expect(appendix).not.toContain('message_id=')
    expect(appendix).not.toContain('桌面')
  })
})
