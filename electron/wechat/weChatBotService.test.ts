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

  it('onExpired emits refreshing without clearing QR url', async () => {
    mockBot.login.mockImplementationOnce(async (opts?: { callbacks?: {
      onQrUrl?: (url: string) => void
      onExpired?: () => void
    } }) => {
      opts?.callbacks?.onQrUrl?.('https://login.example/qr')
      opts?.callbacks?.onExpired?.()
      return { accountId: 'acc-1234', userId: 'user@wx' }
    })
    const svc = new WeChatBotService({
      storageDir: '/tmp/wechat',
      appVersion: '0.1.0',
      getWebContents,
      onInbound: vi.fn()
    })
    await svc.loginStart()
    expect(send).toHaveBeenCalledWith('wechat:qr-url', { url: 'https://login.example/qr', expired: false })
    expect(send).toHaveBeenCalledWith('wechat:login-progress', expect.objectContaining({ stage: 'refreshing' }))
    expect(send).not.toHaveBeenCalledWith('wechat:qr-url', expect.objectContaining({ expired: true }))
  })

  it('loginStart force clears storage and passes force to SDK', async () => {
    const svc = new WeChatBotService({
      storageDir: '/tmp/wechat',
      appVersion: '0.1.0',
      getWebContents,
      onInbound: vi.fn()
    })
    await svc.loginStart(10, { force: true })
    expect((mockBot as unknown as { storage: { clear: ReturnType<typeof vi.fn> } }).storage.clear).toHaveBeenCalled()
    expect(mockBot.login).toHaveBeenCalledWith(expect.objectContaining({ force: true }))
  })

  it('submitVerifyCode resolves onVerifyCode waiter', async () => {
    let verifyPromise: Promise<string> | undefined
    mockBot.login.mockImplementationOnce(async (opts?: { callbacks?: {
      onVerifyCode?: (isRetry: boolean) => string | Promise<string>
    } }) => {
      verifyPromise = Promise.resolve(opts?.callbacks?.onVerifyCode?.(false) ?? '')
      const code = await verifyPromise
      expect(code).toBe('482193')
      return { accountId: 'acc-1234', userId: 'user@wx' }
    })
    const svc = new WeChatBotService({
      storageDir: '/tmp/wechat',
      appVersion: '0.1.0',
      getWebContents,
      onInbound: vi.fn()
    })
    const loginPromise = svc.loginStart()
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        'wechat:login-progress',
        expect.objectContaining({ stage: 'verify_code', isRetry: false })
      )
    })
    expect(svc.submitVerifyCode('482193')).toEqual({ ok: true })
    await expect(loginPromise).resolves.toEqual({ ok: true })
  })

  it('session:expired emits session_expired stage', async () => {
    const svc = new WeChatBotService({
      storageDir: '/tmp/wechat',
      appVersion: '0.1.0',
      getWebContents,
      onInbound: vi.fn()
    })
    await svc.loginStart()
    send.mockClear()
    mockBot.emit('session:expired')
    expect(send).toHaveBeenCalledWith(
      'wechat:login-progress',
      expect.objectContaining({ stage: 'session_expired' })
    )
    expect(svc.getStatus().loggedIn).toBe(false)
    expect(svc.getStatus().pollState).toBe('logged_out')
  })
})
