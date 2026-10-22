import { afterEach, describe, expect, it, vi } from 'vitest'

const { showMessageBox, getMainWindow } = vi.hoisted(() => ({
  showMessageBox: vi.fn(async () => ({ response: 0 })),
  getMainWindow: vi.fn(() => ({ id: 4 }))
}))

vi.mock('electron', () => ({ dialog: { showMessageBox } }))
vi.mock('../windowRef', () => ({ getMainWindow }))

import { requestImExposureApproval, requestImIngressApproval } from './imIngressApprovalPrompt'

afterEach(() => vi.clearAllMocks())

describe('IM local owner approval prompts', () => {
  it('binds ingress approval prompt details to the exact source message and uses reject as the safe default', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    expect(await requestImIngressApproval({ channel: 'wechat', senderId: 'sender-1', messageId: 'msg-7',
      ruleId: 'ingress-direct-other-ask', messageText: 'please run this' })).toBe(true)
    const [parent, options] = showMessageBox.mock.calls[0]!
    expect(parent).toEqual({ id: 4 })
    expect(options).toMatchObject({ defaultId: 1, cancelId: 1, buttons: ['批准并继续处理此消息', '拒绝'] })
    expect(options.detail).toContain('msg-7')
    expect(options.detail).toContain('please run this')
  })

  it('keeps an exposure target unavailable unless the exact local approval dialog is accepted', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    expect(await requestImExposureApproval({ lane: 'feishu', toolName: 'wechat_send', ruleId: 'im-no-wechat-send' })).toBe(false)
    const [, options] = showMessageBox.mock.calls[0]!
    expect(options).toMatchObject({ defaultId: 1, cancelId: 1, buttons: ['批准并开放此工具', '拒绝'] })
    expect(options.detail).toContain('wechat_send')
  })
})
