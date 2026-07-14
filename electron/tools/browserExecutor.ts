import fs from 'fs/promises'
import path from 'path'
import { logAgentError, logAgentEvent } from '../agentLogger/agentLogger'
import { DEFAULT_BROWSER_CONFIG, type BrowserConfig } from '../../src/shared/domainTypes'
import { assertSafeInstruction } from '../browser/instructionGuards'
import {
  browserActionConsumesInference,
  browserActionNeedsRateLimit,
  resolveRateLimitDomain,
  type BrowserAction
} from '../browser/browserActionPolicy'
import { rateLimitService } from '../browser/rateLimitService'
import { RateLimitRejectedError, RateLimitWaitTimeoutError } from '../browser/rateLimiter'
import { browserErrorKindFromAction, mapErrorToFailureCode, shouldAttachDependencyRecovery, toBrowserDependencyToolError, toBrowserUserError } from '../browser/browserUserErrors'
import { isChromiumRecoveryFailure } from '../browser/browserDependencyDetect'
import { toToolUserError } from './toolUserErrors'
import { resolveStagehandCredentials } from '../browser/browserLlmCredentials'
import { stagehandService } from '../browser/stagehandService'
import { validateUrl } from '../browser/urlSecurity'
import { CHAT_CANCELLED_MESSAGE } from '../../src/shared/chatCancel'
import { BROWSER_REMOTE_DISABLED_CODE } from '../../src/shared/browserRemotePolicy'
import { isUserAbortError, raceWithUserAbort, throwIfAborted } from './toolExecutionResource'
import type { ToolExecutor, ToolExecutionContext, ToolExecutorResult } from './types'

const BROWSER_ACTIONS: readonly BrowserAction[] = [
  'navigate',
  'observe',
  'extract',
  'act',
  'screenshot',
  'close'
]

function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars)
}

function truncateJson(value: unknown, maxChars: number): unknown {
  const s = JSON.stringify(value)
  if (s.length <= maxChars) return value
  return { truncated: true, preview: s.slice(0, maxChars) }
}

function parseAction(input: Record<string, unknown>): BrowserAction | null {
  const a = input.action
  if (typeof a !== 'string') return null
  return (BROWSER_ACTIONS as readonly string[]).includes(a) ? (a as BrowserAction) : null
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} 超时`)), ms)
    promise
      .then((v) => {
        clearTimeout(t)
        resolve(v)
      })
      .catch((e) => {
        clearTimeout(t)
        reject(e)
      })
  })
}

function logBrowserToolError(
  ctx: ToolExecutionContext,
  action: string,
  err: unknown,
  phase: string
): void {
  const kind = browserErrorKindFromAction(action)
  const userMsg = toBrowserUserError(err, kind)
  logAgentError(
    'browser.error',
    {
      requestId: ctx.requestId,
      sessionId: ctx.sessionId,
      toolUseId: ctx.toolUseId,
      action,
      phase
    },
    err,
    userMsg
  )
}

async function handlePlaywrightCrash(
  sessionId: string,
  err: unknown
): Promise<ToolExecutorResult | null> {
  if (stagehandService.isPlaywrightCrashError(err)) {
    stagehandService.markCrashed(sessionId)
    await stagehandService.closeSession(sessionId).catch(() => {})
    return { success: false, error: '浏览器实例已崩溃，请重试' }
  }
  return null
}

async function resolveDependencyFailure(started: number): Promise<ToolExecutorResult | null> {
  const detect = await stagehandService.detectDependencies()
  if (detect.canInitialize) return null
  if (!shouldAttachDependencyRecovery(detect)) {
    return {
      success: false,
      error: detect.errors[0] ?? '浏览器依赖未就绪',
      duration: Date.now() - started
    }
  }
  const dep = toBrowserDependencyToolError(detect)
  return {
    success: false,
    error: dep.errorMessage,
    dependencyError: dep,
    duration: Date.now() - started
  }
}

async function dependencyFailureFromInitError(
  err: unknown,
  started: number
): Promise<ToolExecutorResult | null> {
  const failureCode = mapErrorToFailureCode(err, 'init')
  if (!failureCode || !isChromiumRecoveryFailure(failureCode)) return null
  stagehandService.invalidateDetectCache()
  const detect = await stagehandService.detectDependencies(true)
  const dep = toBrowserDependencyToolError({
    ...detect,
    primaryFailure: detect.primaryFailure === 'ok' ? failureCode : detect.primaryFailure
  })
  return {
    success: false,
    error: dep.errorMessage,
    dependencyError: dep,
    duration: Date.now() - started
  }
}

export const browserExecutor: ToolExecutor = {
  name: 'browser',
  async execute(input, ctx): Promise<ToolExecutorResult> {
    const started = Date.now()
    throwIfAborted(ctx.signal)
    const cfg: BrowserConfig = ctx.browserConfig ?? { ...DEFAULT_BROWSER_CONFIG, enabled: false }

    if (!cfg.enabled) {
      return { success: false, error: '浏览器工具未启用', duration: Date.now() - started }
    }

    if (ctx.remoteContext && !cfg.allowRemoteSessions) {
      return {
        success: false,
        error: BROWSER_REMOTE_DISABLED_CODE,
        duration: Date.now() - started
      }
    }

    const action = parseAction(input)
    if (!action) {
      return { success: false, error: '无效的 action', duration: Date.now() - started }
    }

    if (cfg.deniedActions.includes(action)) {
      return { success: false, error: `${action} 已被禁用`, duration: Date.now() - started }
    }

    const navTimeout = cfg.actionTimeoutSec * 1000
    const shortTimeout = 30 * 1000

    if (action === 'navigate') {
      const mode = typeof input.mode === 'string' ? input.mode : 'open'
      if (mode === 'open' && (typeof input.url !== 'string' || !input.url.trim())) {
        return { success: false, error: 'navigate open 缺少 url', duration: Date.now() - started }
      }
    }
    if (action === 'extract' && (typeof input.instruction !== 'string' || !input.instruction.trim())) {
      return { success: false, error: 'extract 缺少 instruction', duration: Date.now() - started }
    }
    if (action === 'act' && (typeof input.instruction !== 'string' || !input.instruction.trim())) {
      return { success: false, error: 'act 缺少 instruction', duration: Date.now() - started }
    }

    try {
      if (browserActionConsumesInference(action)) {
        stagehandService.incrementAndCheck(ctx.sessionId, cfg.maxInferencesPerRequest)
      }
    } catch (e) {
      return {
        success: false,
        error: toToolUserError(e, { toolName: 'browser', browserKind: 'generic' }),
        duration: Date.now() - started
      }
    }

    if (action === 'close') {
      await stagehandService.closeSession(ctx.sessionId)
      return { success: true, data: { closed: true }, duration: Date.now() - started }
    }

    const credentials = await resolveStagehandCredentials(ctx.appDatabase, cfg)
    if (!credentials) {
      return {
        success: false,
        error: 'Stagehand 模型凭证无效，请在设置中检查 API Key 或切换模型',
        duration: Date.now() - started
      }
    }

    const dependencyBlock = await resolveDependencyFailure(started)
    if (dependencyBlock) return dependencyBlock

    let sessionState
    try {
      sessionState = await raceWithUserAbort(
        stagehandService.getOrCreate(ctx.sessionId, cfg, credentials),
        ctx.signal
      )
    } catch (e) {
      if (isUserAbortError(e) || ctx.signal.aborted) {
        return { success: false, error: CHAT_CANCELLED_MESSAGE, duration: Date.now() - started }
      }
      const depFailure = await dependencyFailureFromInitError(e, started)
      if (depFailure) return depFailure
      const userErr = toBrowserUserError(e, 'init')
      logAgentError(
        'browser.error',
        {
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
          toolUseId: ctx.toolUseId,
          phase: 'init'
        },
        e,
        userErr
      )
      return {
        success: false,
        error: userErr,
        duration: Date.now() - started
      }
    }

    stagehandService.scheduleIdleClose(ctx.sessionId, cfg.idleTimeoutSec)

    const { stagehand } = sessionState
    const pages = stagehand.context.pages()
    const page = pages[0]
    if (!page) {
      return { success: false, error: '浏览器实例未就绪', duration: Date.now() - started }
    }

    if (cfg.rateLimitEnabled && browserActionNeedsRateLimit(action)) {
      const host = resolveRateLimitDomain(action, input, sessionState.lastUrl, page.url())
      try {
        await rateLimitService.acquire(ctx.sessionId, cfg, host, ctx.signal, (waitMs) => {
          const waitSec = Math.ceil(waitMs / 1000)
          ctx.sendProgress('rate_limiting', `等待请求槽位可用...（预计 ${waitSec} 秒）`)
        })
      } catch (e) {
        if (isUserAbortError(e) || ctx.signal.aborted) {
          return { success: false, error: CHAT_CANCELLED_MESSAGE, duration: Date.now() - started }
        }
        if (e instanceof RateLimitRejectedError || e instanceof RateLimitWaitTimeoutError) {
          return { success: false, error: e.message, duration: Date.now() - started }
        }
        throw e
      }
    }

    try {
      if (action === 'navigate') {
        const mode = typeof input.mode === 'string' ? input.mode : 'open'
        if (mode === 'open') {
          const url = String(input.url)
          const validated = validateUrl(url, cfg, {
            userConfirmedNavigate: ctx.toolUserConfirmed === true,
            sessionId: ctx.sessionId
          })
          if (!validated.valid) {
            return { success: false, error: validated.error, duration: Date.now() - started }
          }
          ctx.sendProgress('navigating', `正在打开 ${validated.normalizedUrl}...`)
          const stopNavigation = () => {
            void page.evaluate(() => window.stop()).catch(() => {})
          }
          await raceWithUserAbort(
            withTimeout(
              page.goto(validated.normalizedUrl, {
                waitUntil:
                  (typeof input.wait_until === 'string' ? input.wait_until : 'domcontentloaded') as
                    | 'load'
                    | 'domcontentloaded'
                    | 'networkidle',
                timeout: navTimeout
              }),
              navTimeout,
              '打开页面'
            ),
            ctx.signal,
            stopNavigation
          )
          sessionState.lastUrl = validated.normalizedUrl
          const title = await page.title().catch(() => undefined)
          logAgentEvent('info', 'browser.action', {
            requestId: ctx.requestId,
            sessionId: ctx.sessionId,
            toolUseId: ctx.toolUseId,
            action: 'navigate',
            url: validated.normalizedUrl,
            result: 'success',
            durationMs: Date.now() - started
          })
          return {
            success: true,
            data: { url: validated.normalizedUrl, title },
            duration: Date.now() - started
          }
        }
        if (mode === 'refresh') {
          await raceWithUserAbort(
            withTimeout(page.reload({ timeout: shortTimeout }), shortTimeout, '刷新'),
            ctx.signal,
            () => {
              void page.evaluate(() => window.stop()).catch(() => {})
            }
          )
        } else if (mode === 'back') {
          await raceWithUserAbort(
            withTimeout(page.goBack({ timeout: shortTimeout }), shortTimeout, '后退'),
            ctx.signal,
            () => {
              void page.evaluate(() => window.stop()).catch(() => {})
            }
          )
        } else if (mode === 'forward') {
          await raceWithUserAbort(
            withTimeout(page.goForward({ timeout: shortTimeout }), shortTimeout, '前进'),
            ctx.signal,
            () => {
              void page.evaluate(() => window.stop()).catch(() => {})
            }
          )
        }
        return {
          success: true,
          data: { url: page.url() },
          duration: Date.now() - started
        }
      }

      if (action === 'observe' || action === 'extract' || action === 'act') {
        const instruction =
          typeof input.instruction === 'string' ? input.instruction : ''
        try {
          assertSafeInstruction(instruction || undefined, action)
        } catch (e) {
          return {
            success: false,
            error: toToolUserError(e, {
              toolName: 'browser',
              browserKind: browserErrorKindFromAction(action)
            }),
            duration: Date.now() - started
          }
        }
        const selector = typeof input.selector === 'string' ? input.selector : undefined
        const opts = selector ? { selector } : undefined

        if (action === 'observe') {
          ctx.sendProgress('observing', '正在分析页面元素…')
          const result = await raceWithUserAbort(
            withTimeout(stagehand.observe(instruction, opts), navTimeout, 'observe'),
            ctx.signal
          )
          const json = truncateJson(result, cfg.maxOutputChars)
          return { success: true, data: { actions: json }, duration: Date.now() - started }
        }

        if (action === 'extract') {
          ctx.sendProgress('extracting', '正在提取页面内容…')
          const result = await raceWithUserAbort(
            withTimeout(stagehand.extract(instruction, opts), navTimeout, 'extract'),
            ctx.signal
          )
          let extraction = ''
          if (result && typeof result === 'object' && 'extraction' in result) {
            extraction = String((result as { extraction: unknown }).extraction)
          } else {
            extraction = typeof result === 'string' ? result : JSON.stringify(result)
          }
          extraction = truncateOutput(extraction, cfg.maxOutputChars)
          return { success: true, data: { extraction }, duration: Date.now() - started }
        }

        ctx.sendProgress('acting', instruction.slice(0, 120))
        const urlBefore = page.url()
        const actResult = (await raceWithUserAbort(
          withTimeout(stagehand.act(instruction), navTimeout, 'act'),
          ctx.signal
        )) as { success?: boolean; actions?: Array<{ method?: string; selector?: string; description?: string; arguments?: string }> } | undefined
        const urlAfter = page.url()
        const navigated = urlAfter !== urlBefore
        logAgentEvent('info', 'browser.action', {
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
          toolUseId: ctx.toolUseId,
          action: 'act',
          instruction: instruction.slice(0, 200),
          actedActions: (actResult?.actions ?? []).map((a) => ({
            method: a.method,
            selector: a.selector,
            description: a.description?.slice(0, 80)
          })),
          navigated,
          ...(navigated ? { urlAfter } : {}),
          result: 'success',
          durationMs: Date.now() - started
        })
        return {
          success: true,
          data: { acted: true, navigated, actions: actResult?.actions?.length ?? 0 },
          duration: Date.now() - started
        }
      }

      if (action === 'screenshot') {
        const capDir = path.join(
          ctx.userDataDir,
          cfg.captureSubdir,
          ctx.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
        )
        await fs.mkdir(capDir, { recursive: true })
        const filePath = path.join(capDir, `${Date.now()}.png`)
        const fullPage = input.full_page === true
        await raceWithUserAbort(
          withTimeout(
            page.screenshot({ path: filePath, fullPage, timeout: shortTimeout }),
            shortTimeout,
            'screenshot'
          ),
          ctx.signal
        )
        return {
          success: true,
          data: { path: filePath, width: 0, height: 0 },
          duration: Date.now() - started
        }
      }

      return { success: false, error: '无效的 action', duration: Date.now() - started }
    } catch (e) {
      if (isUserAbortError(e) || ctx.signal.aborted) {
        return { success: false, error: CHAT_CANCELLED_MESSAGE, duration: Date.now() - started }
      }

      const crash = await handlePlaywrightCrash(ctx.sessionId, e)
      if (crash) return { ...crash, duration: Date.now() - started }

      logBrowserToolError(ctx, action, e, 'execute')
      return {
        success: false,
        error: toBrowserUserError(e, browserErrorKindFromAction(action)),
        duration: Date.now() - started
      }
    }
  }
}
