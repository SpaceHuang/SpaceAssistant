import { createRequire } from 'node:module'
import { importEsmModule } from '../esmDynamicImport'
import { logAgentError } from '../agentLogger/agentLogger'
import type { BrowserConfig } from '../../src/shared/domainTypes'
import type { BrowserDetectResult } from '../../src/shared/browserTypes'
import { toBrowserUserError } from './browserUserErrors'
import {
  detectBrowserDependencies,
  type BrowserDetectContext
} from './browserDependencyDetect'
import { launchPlaywrightBrowserHost } from './playwrightBrowserHost'
import type { StagehandInitModel } from './stagehandModelInit'
const nodeRequire = createRequire(__filename)

export interface StagehandCredentials {
  model: StagehandInitModel
}

export type DetectResult = BrowserDetectResult

type StagehandLike = {
  init: () => Promise<void>
  close: () => Promise<void>
  observe: (instruction?: string, opts?: { selector?: string }) => Promise<unknown>
  extract: (instruction: string, opts?: { selector?: string }) => Promise<unknown>
  act: (instruction: string) => Promise<unknown>
  context: {
    pages: () => Array<PlaywrightPage>
  }
}

type PlaywrightPage = {
  goto: (url: string, opts?: { waitUntil?: string; timeout?: number }) => Promise<unknown>
  reload: (opts?: { timeout?: number }) => Promise<unknown>
  goBack: (opts?: { timeout?: number }) => Promise<unknown>
  goForward: (opts?: { timeout?: number }) => Promise<unknown>
  screenshot: (opts?: { path?: string; fullPage?: boolean; timeout?: number }) => Promise<unknown>
  /** 中止进行中的导航（用户点击聊天「中止」时） */
  evaluate: (pageFunction: () => void) => Promise<unknown>
  url: () => string
  title: () => Promise<string>
}

export interface StagehandSessionState {
  spaceSessionId: string
  stagehand: StagehandLike
  lastUrl?: string
  inferenceCountThisRequest: number
  lastActivityAt: number
  createdAt: number
}

interface InternalSession {
  state: StagehandSessionState
  browserHost?: { close: () => Promise<void> }
  idleTimer?: ReturnType<typeof setTimeout>
  closing: boolean
  failed?: boolean
  crashed?: boolean
}

const DETECT_CACHE_TTL_MS = 30_000

async function loadStagehandCtor(): Promise<new (opts: Record<string, unknown>) => StagehandLike> {
  const mod = await importEsmModule<{ Stagehand: new (opts: Record<string, unknown>) => StagehandLike }>(
    '@browserbasehq/stagehand'
  )
  const Ctor = mod.Stagehand
  if (!Ctor) throw new Error('Stagehand 未正确安装')
  return Ctor
}

export class StagehandService {
  private sessions = new Map<string, InternalSession>()
  private inferenceCounts = new Map<string, number>()
  private detectContext: BrowserDetectContext = {
    isPackaged: false,
    appPath: '',
    devRoot: process.cwd()
  }
  private detectCache: { at: number; result: BrowserDetectResult } | null = null

  configureDetectContext(ctx: BrowserDetectContext): void {
    this.detectContext = ctx
    this.detectCache = null
  }

  invalidateDetectCache(): void {
    this.detectCache = null
  }

  async getOrCreate(
    sessionId: string,
    config: BrowserConfig,
    credentials: StagehandCredentials
  ): Promise<StagehandSessionState> {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      if (existing.closing) {
        await this.waitForClose(sessionId)
        return this.getOrCreate(sessionId, config, credentials)
      }
      if (existing.failed || existing.crashed) {
        await this.closeSession(sessionId)
        return this.getOrCreate(sessionId, config, credentials)
      }
      existing.state.lastActivityAt = Date.now()
      return existing.state
    }

    const Stagehand = await loadStagehandCtor()
    const browserHost = await launchPlaywrightBrowserHost(config.headless)
    const opts: Record<string, unknown> = {
      env: 'LOCAL',
      headless: config.headless,
      model: credentials.model as Record<string, unknown>,
      localBrowserLaunchOptions: {
        cdpUrl: browserHost.cdpUrl,
        headless: config.headless
      }
    }

    const stagehand = new Stagehand(opts)
    const state: StagehandSessionState = {
      spaceSessionId: sessionId,
      stagehand,
      inferenceCountThisRequest: 0,
      lastActivityAt: Date.now(),
      createdAt: Date.now()
    }
    const internal: InternalSession = { state, browserHost, closing: false }
    this.sessions.set(sessionId, internal)

    try {
      await stagehand.init()
    } catch (e) {
      internal.failed = true
      this.sessions.delete(sessionId)
      try {
        await browserHost.close()
      } catch {
        /* ignore */
      }
      const userErr = toBrowserUserError(e, 'init')
      logAgentError('browser.error', { sessionId, phase: 'init' }, e, userErr)
      throw Object.assign(new Error(userErr), { userFacing: true as const })
    }

    return state
  }

  private waitForClose(sessionId: string, maxMs = 5000): Promise<void> {
    const start = Date.now()
    return new Promise((resolve) => {
      const tick = () => {
        const s = this.sessions.get(sessionId)
        if (!s || !s.closing) {
          resolve()
          return
        }
        if (Date.now() - start > maxMs) {
          resolve()
          return
        }
        setTimeout(tick, 50)
      }
      tick()
    })
  }

  async closeSession(sessionId: string): Promise<void> {
    const internal = this.sessions.get(sessionId)
    if (!internal) return
    if (internal.idleTimer) {
      clearTimeout(internal.idleTimer)
      internal.idleTimer = undefined
    }
    internal.closing = true
    try {
      await internal.state.stagehand.close()
    } catch {
      /* ignore */
    }
    if (internal.browserHost) {
      try {
        await internal.browserHost.close()
      } catch {
        /* ignore */
      }
    }
    this.sessions.delete(sessionId)
  }

  async closeAll(): Promise<void> {
    const ids = [...this.sessions.keys()]
    await Promise.all(ids.map((id) => this.closeSession(id)))
  }

  resetInferenceCount(sessionId: string): void {
    this.inferenceCounts.set(sessionId, 0)
    const internal = this.sessions.get(sessionId)
    if (internal) internal.state.inferenceCountThisRequest = 0
  }

  incrementAndCheck(sessionId: string, max: number): void {
    const next = (this.inferenceCounts.get(sessionId) ?? 0) + 1
    this.inferenceCounts.set(sessionId, next)
    const internal = this.sessions.get(sessionId)
    if (internal) internal.state.inferenceCountThisRequest = next
    if (next > max) {
      throw new Error('推理次数已达上限')
    }
  }

  scheduleIdleClose(sessionId: string, timeoutSec: number): void {
    const internal = this.sessions.get(sessionId)
    if (!internal) return
    if (internal.idleTimer) clearTimeout(internal.idleTimer)
    internal.idleTimer = setTimeout(() => {
      void this.closeSession(sessionId)
    }, timeoutSec * 1000)
  }

  markCrashed(sessionId: string): void {
    const internal = this.sessions.get(sessionId)
    if (internal) internal.crashed = true
  }

  isPlaywrightCrashError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err)
    return /Target closed|Protocol error|Browser closed|context was destroyed/i.test(msg)
  }

  async detectDependencies(force = false): Promise<BrowserDetectResult> {
    const now = Date.now()
    if (!force && this.detectCache && now - this.detectCache.at < DETECT_CACHE_TTL_MS) {
      return this.detectCache.result
    }
    const result = await detectBrowserDependencies(this.detectContext)
    this.detectCache = { at: now, result }
    return result
  }
}

export const stagehandService = new StagehandService()
