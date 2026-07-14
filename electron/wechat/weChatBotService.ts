import type { WebContents } from 'electron'
import type { IncomingMessage, WeChatBot } from '@wechatbot/wechatbot'
import type {
  WeChatConnectionStatus,
  WeChatLoginProgress,
  WeChatPollState,
  WeChatSdkDetectResult
} from '../../src/shared/wechatTypes'
import type { WeChatReplyBot } from './weChatReplyService'
import { logWeChatCliEvent } from './weChatCliLogger'

type IncomingHandler = (msg: IncomingMessage) => void | Promise<void>

export type WeChatBotServiceDeps = {
  storageDir: string
  appVersion: string
  getWebContents: () => WebContents | null
  onInbound: IncomingHandler
}

export type WeChatLoginStartOptions = {
  force?: boolean
}

export async function detectWeChatSdk(): Promise<WeChatSdkDetectResult> {
  try {
    await import('@wechatbot/wechatbot')
    return { available: true, version: '2.2.0' }
  } catch (e) {
    return { available: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export class WeChatBotService {
  private bot: WeChatBot | null = null
  private pollState: WeChatPollState = 'stopped'
  private lastError?: string
  private processedCount = 0
  private startedAt?: number
  private loginInProgress = false
  private loginAbort = false
  private displayName?: string
  private botIdSuffix?: string
  private loggedIn = false
  private verifyCodeResolvers: Array<(code: string) => void> = []

  constructor(private deps: WeChatBotServiceDeps) {}

  getStatus(): WeChatConnectionStatus {
    return {
      loggedIn: this.loggedIn,
      botIdSuffix: this.botIdSuffix,
      displayName: this.displayName,
      pollState: this.pollState,
      lastError: this.lastError,
      processedCount: this.processedCount,
      startedAt: this.startedAt
    }
  }

  getBot(): WeChatReplyBot | null {
    if (!this.bot) return null
    return {
      reply: (msg, content) => this.bot!.reply(msg as IncomingMessage, content as never),
      sendTyping: (userId) => this.bot!.sendTyping(userId),
      stopTyping: (userId) => this.bot!.stopTyping(userId)
    }
  }

  getRawBot(): WeChatBot | null {
    return this.bot
  }

  private emitProgress(stage: WeChatLoginProgress, extra?: Record<string, unknown>): void {
    this.deps.getWebContents()?.send('wechat:login-progress', { stage, ...extra })
  }

  private resolveVerifyCodeWaiters(code: string): void {
    const waiters = this.verifyCodeResolvers.splice(0)
    for (const resolve of waiters) resolve(code)
  }

  /** Submit pairing digits shown on the phone (WeChat iLink secondary verify). */
  submitVerifyCode(code: string): { ok: boolean } {
    if (this.verifyCodeResolvers.length === 0) return { ok: false }
    this.resolveVerifyCodeWaiters(code.trim())
    return { ok: true }
  }

  private buildLoginCallbacks() {
    return {
      onQrUrl: (url: string) => {
        if (this.loginAbort) return
        this.emitProgress('waiting')
        this.deps.getWebContents()?.send('wechat:qr-url', { url, expired: false })
      },
      onScanned: () => {
        if (this.loginAbort) return
        this.emitProgress('scanned')
      },
      onExpired: () => {
        if (this.loginAbort) return
        // SDK will request a new QR; keep current URL until onQrUrl.
        this.emitProgress('refreshing')
        logWeChatCliEvent('info', 'wechat.login.qr_refreshing', {})
      },
      onVerifyCode: async (isRetry: boolean) => {
        if (this.loginAbort) return ''
        this.emitProgress('verify_code', { isRetry })
        return new Promise<string>((resolve) => {
          this.verifyCodeResolvers.push(resolve)
        })
      }
    }
  }

  private async ensureBot(): Promise<WeChatBot> {
    if (this.bot) return this.bot
    const { WeChatBot, rateLimitMiddleware } = await import('@wechatbot/wechatbot')
    const bot = new WeChatBot({
      storageDir: this.deps.storageDir,
      logLevel: 'warn',
      botAgent: `SpaceAssistant/${this.deps.appVersion}`
    })
    bot.use(rateLimitMiddleware({ maxMessages: 10, windowMs: 60_000 }))
    bot.on('session:expired', () => {
      this.loggedIn = false
      this.pollState = 'logged_out'
      this.lastError = 'session_expired'
      this.emitProgress('session_expired')
      logWeChatCliEvent('warn', 'wechat.poll.session_expired', {})
    })
    bot.on('error', (err: unknown) => {
      this.lastError = err instanceof Error ? err.message : String(err)
      if (this.pollState === 'polling') this.pollState = 'error'
      logWeChatCliEvent('error', 'wechat.poll.error', { lastError: this.lastError, pollState: this.pollState })
    })
    bot.onMessage((msg) => {
      this.processedCount += 1
      void this.deps.onInbound(msg)
      this.deps.getWebContents()?.send('wechat:polling-stats', {
        processedCount: this.processedCount,
        startedAt: this.startedAt,
        lastInboundAt: Date.now()
      })
    })
    this.bot = bot
    return bot
  }

  async loginStart(
    rateLimitPerMinute = 10,
    opts: WeChatLoginStartOptions = {}
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.loginInProgress) {
      // Force restart is not possible while SDK login is awaiting; caller should stop first.
      return { ok: true }
    }
    this.loginAbort = false
    this.loginInProgress = true
    this.pollState = 'connecting'
    try {
      const bot = await this.ensureBot()
      const { rateLimitMiddleware } = await import('@wechatbot/wechatbot')
      bot.use(rateLimitMiddleware({ maxMessages: rateLimitPerMinute, windowMs: 60_000 }))
      if (opts.force) {
        try {
          await bot.storage.clear()
        } catch {
          /* ignore */
        }
        this.loggedIn = false
        this.displayName = undefined
        this.botIdSuffix = undefined
      }
      const creds = await bot.login({
        force: Boolean(opts.force),
        callbacks: this.buildLoginCallbacks()
      })
      if (this.loginAbort) {
        return { ok: false, error: 'aborted' }
      }
      this.loggedIn = true
      this.pollState = 'stopped'
      this.lastError = undefined
      this.botIdSuffix = creds.accountId?.slice(-4)
      this.displayName = creds.userId?.split('@')[0] ?? creds.accountId
      this.emitProgress('confirmed')
      logWeChatCliEvent('info', 'wechat.login.ok', {
        botIdSuffix: this.botIdSuffix,
        displayName: this.displayName
      })
      return { ok: true }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      this.lastError = error
      this.pollState = 'error'
      if (/QR code expired|qr.?expired|expired/i.test(error)) {
        this.emitProgress('expired')
        this.deps.getWebContents()?.send('wechat:qr-url', { url: null, expired: true })
      }
      logWeChatCliEvent('warn', 'wechat.login.failed', { lastError: error })
      return { ok: false, error }
    } finally {
      this.loginInProgress = false
      this.resolveVerifyCodeWaiters('')
    }
  }

  async loginStop(): Promise<void> {
    this.loginAbort = true
    this.loginInProgress = false
    this.pollState = 'stopped'
    this.resolveVerifyCodeWaiters('')
    this.deps.getWebContents()?.send('wechat:qr-url', { url: null })
  }

  async startPoll(): Promise<WeChatConnectionStatus> {
    const bot = await this.ensureBot()
    this.pollState = 'connecting'
    try {
      const creds = await bot.login(
        this.loggedIn ? {} : { callbacks: this.buildLoginCallbacks() }
      )
      this.loggedIn = true
      this.botIdSuffix = creds.accountId?.slice(-4)
      this.displayName = creds.userId?.split('@')[0] ?? creds.accountId
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e)
      this.pollState = this.loggedIn ? 'error' : 'logged_out'
      logWeChatCliEvent('warn', 'wechat.poll.login_restore_failed', {
        lastError: this.lastError,
        pollState: this.pollState
      })
      return this.getStatus()
    }
    try {
      await bot.start()
      this.pollState = 'polling'
      this.startedAt = this.startedAt ?? Date.now()
      this.lastError = undefined
      logWeChatCliEvent('info', 'wechat.poll.started', {
        processedCount: this.processedCount,
        startedAt: this.startedAt
      })
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e)
      this.pollState = 'error'
      logWeChatCliEvent('error', 'wechat.poll.start_failed', { lastError: this.lastError })
    }
    return this.getStatus()
  }

  async stopPoll(): Promise<WeChatConnectionStatus> {
    if (this.bot) {
      await this.bot.stop()
    }
    this.pollState = 'stopped'
    logWeChatCliEvent('info', 'wechat.poll.stopped', { processedCount: this.processedCount })
    return this.getStatus()
  }

  async logout(): Promise<void> {
    await this.stopPoll()
    if (this.bot) {
      try {
        await this.bot.storage.clear()
      } catch {
        /* ignore */
      }
    }
    this.bot = null
    this.loggedIn = false
    this.displayName = undefined
    this.botIdSuffix = undefined
    this.pollState = 'logged_out'
    this.processedCount = 0
    this.startedAt = undefined
    logWeChatCliEvent('info', 'wechat.logout', {})
  }

  setLoggedInMirror(opts: { loggedIn: boolean; displayName?: string; botIdSuffix?: string }): void {
    this.loggedIn = opts.loggedIn
    if (opts.displayName !== undefined) this.displayName = opts.displayName
    if (opts.botIdSuffix !== undefined) this.botIdSuffix = opts.botIdSuffix
  }
}
