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

export async function detectWeChatSdk(): Promise<WeChatSdkDetectResult> {
  try {
    const mod = await import('@wechatbot/wechatbot')
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
  private displayName?: string
  private botIdSuffix?: string
  private loggedIn = false
  private verifyCodeHint?: string

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

  private buildLoginCallbacks() {
    return {
      onQrUrl: (url: string) => {
        this.emitProgress('waiting')
        this.deps.getWebContents()?.send('wechat:qr-url', { url })
      },
      onScanned: () => this.emitProgress('scanned'),
      onExpired: () => {
        this.emitProgress('expired')
        this.deps.getWebContents()?.send('wechat:qr-url', { url: null, expired: true })
      },
      onVerifyCode: async () => {
        this.emitProgress('verify_code', { code: this.verifyCodeHint })
        return this.verifyCodeHint ?? ''
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
      this.emitProgress('expired')
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

  async loginStart(rateLimitPerMinute = 10): Promise<{ ok: boolean; error?: string }> {
    if (this.loginInProgress) return { ok: true }
    this.loginInProgress = true
    this.pollState = 'connecting'
    try {
      const bot = await this.ensureBot()
      const { rateLimitMiddleware } = await import('@wechatbot/wechatbot')
      bot.use(rateLimitMiddleware({ maxMessages: rateLimitPerMinute, windowMs: 60_000 }))
      const creds = await bot.login({ callbacks: this.buildLoginCallbacks() })
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
      logWeChatCliEvent('warn', 'wechat.login.failed', { lastError: error })
      return { ok: false, error }
    } finally {
      this.loginInProgress = false
    }
  }

  async loginStop(): Promise<void> {
    this.loginInProgress = false
    this.pollState = 'stopped'
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

  setVerifyCodeHint(code: string): void {
    this.verifyCodeHint = code
  }
}
