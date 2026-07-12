import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createMockWeChatBot } from './__mocks__/wechatBotMock'

const mockBot = createMockWeChatBot()

vi.mock('@wechatbot/wechatbot', () => ({
  WeChatBot: class MockWeChatBot {
    constructor() {
      return mockBot
    }
  },
  rateLimitMiddleware: vi.fn(() => (next: (msg: unknown) => unknown) => next)
}))

import { WeChatBotService } from './weChatBotService'

describe('WeChatBotService', () => {
  const send = vi.fn()
  const getWebContents = () => ({ send }) as never

  beforeEach(() => {
    vi.clearAllMocks()
    mockBot._state = { loggedIn: false, pollState: 'stopped' }
  })

  it('loginStart sets loggedIn and displayName', async () => {
    const svc = new WeChatBotService({
      storageDir: '/tmp/wechat',
      appVersion: '0.1.0',
      getWebContents,
      onInbound: vi.fn()
    })
    const result = await svc.loginStart()
    expect(result.ok).toBe(true)
    const status = svc.getStatus()
    expect(status.loggedIn).toBe(true)
    expect(status.displayName).toBeTruthy()
    expect(send).toHaveBeenCalledWith('wechat:login-progress', expect.objectContaining({ stage: 'confirmed' }))
  })

  it('startPoll transitions to polling', async () => {
    const svc = new WeChatBotService({
      storageDir: '/tmp/wechat',
      appVersion: '0.1.0',
      getWebContents,
      onInbound: vi.fn()
    })
    await svc.loginStart()
    const status = await svc.startPoll()
    expect(status.pollState).toBe('polling')
    expect(mockBot.start).toHaveBeenCalled()
  })

  it('startPoll restores credentials when loggedIn mirror is set', async () => {
    const svc = new WeChatBotService({
      storageDir: '/tmp/wechat',
      appVersion: '0.1.0',
      getWebContents,
      onInbound: vi.fn()
    })
    svc.setLoggedInMirror({ loggedIn: true, displayName: 'test', botIdSuffix: '1234' })
    mockBot.login.mockClear()
    mockBot.start.mockClear()
    const status = await svc.startPoll()
    expect(mockBot.login).toHaveBeenCalledWith({})
    expect(mockBot.start).toHaveBeenCalled()
    expect(status.pollState).toBe('polling')
    expect(status.loggedIn).toBe(true)
  })

  it('logout clears credentials mirror', async () => {
    const svc = new WeChatBotService({
      storageDir: '/tmp/wechat',
      appVersion: '0.1.0',
      getWebContents,
      onInbound: vi.fn()
    })
    await svc.loginStart()
    await svc.logout()
    const status = svc.getStatus()
    expect(status.loggedIn).toBe(false)
    expect(status.displayName).toBeUndefined()
  })
})
