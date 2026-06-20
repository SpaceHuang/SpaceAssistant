import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BROWSER_CONFIG } from '../../src/shared/domainTypes'
import type { ToolExecutionContext } from './types'

const mockGetOrCreate = vi.fn()
const mockCloseSession = vi.fn()
const mockIncrementAndCheck = vi.fn()
const mockScheduleIdleClose = vi.fn()
const mockResetInferenceCount = vi.fn()
const mockAcquire = vi.fn()

vi.mock('../browser/stagehandService', () => ({
  stagehandService: {
    getOrCreate: (...args: unknown[]) => mockGetOrCreate(...args),
    closeSession: (...args: unknown[]) => mockCloseSession(...args),
    incrementAndCheck: (...args: unknown[]) => mockIncrementAndCheck(...args),
    scheduleIdleClose: (...args: unknown[]) => mockScheduleIdleClose(...args),
    resetInferenceCount: (...args: unknown[]) => mockResetInferenceCount(...args),
    markCrashed: vi.fn(),
    isPlaywrightCrashError: vi.fn().mockReturnValue(false),
    detectDependencies: vi.fn().mockResolvedValue({
      stagehand: { installed: true, version: '3.0.0' },
      playwright: { installed: true, browsers: ['chromium'] },
      chromium: { ready: true },
      node: { version: 'v22.0.0', meetsRequirement: true },
      canInitialize: true,
      primaryFailure: 'ok',
      errors: [],
      recommendedCwd: '/project',
      installContext: 'development'
    }),
    invalidateDetectCache: vi.fn()
  }
}))

vi.mock('../browser/browserLlmCredentials', () => ({
  resolveStagehandCredentials: vi.fn().mockResolvedValue({
    model: { modelName: 'anthropic/m', apiKey: 'sk' }
  })
}))

vi.mock('../browser/rateLimitService', () => ({
  rateLimitService: {
    acquire: (...args: unknown[]) => mockAcquire(...args)
  }
}))

import { CHAT_CANCELLED_MESSAGE } from '../../src/shared/chatCancel'
import { BROWSER_FEISHU_REMOTE_DISABLED_CODE } from '../../src/shared/browserRemotePolicy'
import { ErrorCodes } from '../../src/shared/errorCodes'
import { RateLimitRejectedError, RateLimitWaitTimeoutError } from '../browser/rateLimiter'
import { browserExecutor } from './browserExecutor'

function baseCtx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    workDir: '/tmp',
    userDataDir: '/tmp/ud',
    requestId: 'r1',
    toolUseId: 't1',
    sessionId: 'sess1',
    sendProgress: vi.fn(),
    signal: new AbortController().signal,
    fileStateCache: {} as ToolExecutionContext['fileStateCache'],
    toolsConfig: {
      enabled: true,
      confirmMode: 'diff',
      allowedTools: [],
      deniedTools: [],
      pythonPath: 'python',
      scriptTimeout: 300,
      fileCheckpointingEnabled: true,
      maxFileSnapshots: 100,
      grepTimeoutSec: 60
    },
    browserConfig: { ...DEFAULT_BROWSER_CONFIG, enabled: true, trustedDomains: ['example.com'] },
    ...overrides
  }
}

describe('browserExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAcquire.mockResolvedValue(undefined)
    mockIncrementAndCheck.mockImplementation(() => {})
    mockGetOrCreate.mockResolvedValue({
      stagehand: {
        observe: vi.fn().mockResolvedValue([{ description: 'btn' }]),
        extract: vi.fn().mockResolvedValue({ extraction: 'hello world' }),
        act: vi.fn().mockResolvedValue({}),
        context: {
          pages: () => [
            {
              goto: vi.fn().mockResolvedValue(undefined),
              reload: vi.fn(),
              goBack: vi.fn(),
              goForward: vi.fn(),
              screenshot: vi.fn().mockResolvedValue(Buffer.from('')),
              url: () => 'https://example.com',
              title: vi.fn().mockResolvedValue('Title')
            }
          ]
        }
      }
    })
  })

  it('rejects when browser disabled', async () => {
    const r = await browserExecutor.execute(
      { action: 'observe' },
      baseCtx({ browserConfig: { ...DEFAULT_BROWSER_CONFIG, enabled: false } })
    )
    expect(r.success).toBe(false)
    expect(r.error).toContain('未启用')
  })

  it('rejects invalid action', async () => {
    const r = await browserExecutor.execute({ action: 'invalid' }, baseCtx())
    expect(r.error).toContain('无效的 action')
  })

  it('rejects denied action', async () => {
    const r = await browserExecutor.execute(
      { action: 'act', instruction: 'click' },
      baseCtx({ browserConfig: { ...DEFAULT_BROWSER_CONFIG, enabled: true, deniedActions: ['act'] } })
    )
    expect(r.error).toContain('已被禁用')
  })

  it('navigate open calls goto', async () => {
    const r = await browserExecutor.execute(
      { action: 'navigate', mode: 'open', url: 'https://example.com' },
      baseCtx()
    )
    expect(r.success).toBe(true)
    expect(mockGetOrCreate).toHaveBeenCalled()
  })

  it('aborts navigate when user signal is cancelled', async () => {
    const ac = new AbortController()
    const goto = vi.fn(() => new Promise<void>(() => {}))
    mockGetOrCreate.mockResolvedValueOnce({
      stagehand: {
        context: {
          pages: () => [
            {
              goto,
              evaluate: vi.fn().mockResolvedValue(undefined),
              url: () => 'https://example.com',
              title: vi.fn()
            }
          ]
        }
      }
    })
    const exec = browserExecutor.execute(
      { action: 'navigate', mode: 'open', url: 'https://example.com' },
      baseCtx({ signal: ac.signal })
    )
    for (let i = 0; i < 30 && goto.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(goto).toHaveBeenCalled()
    ac.abort()
    const r = await exec
    expect(r.success).toBe(false)
    expect(r.error).toBe(CHAT_CANCELLED_MESSAGE)
  })

  it('rejects unconfirmed url when navigate requires confirm', async () => {
    const r = await browserExecutor.execute(
      { action: 'navigate', mode: 'open', url: 'https://evil.com' },
      baseCtx()
    )
    expect(r.success).toBe(false)
    expect(r.error).toContain('尚未授权')
  })

  it('rejects feishu remote when allowRemoteSessions is false', async () => {
    const r = await browserExecutor.execute(
      { action: 'navigate', mode: 'open', url: 'https://example.com' },
      baseCtx({
        remoteContext: {
          source: 'feishu',
          messageId: 'om_test',
          confirmPolicy: 'feishu_confirm'
        },
        browserConfig: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowRemoteSessions: false }
      })
    )
    expect(r.success).toBe(false)
    expect(r.error).toBe(BROWSER_FEISHU_REMOTE_DISABLED_CODE)
    expect(mockGetOrCreate).not.toHaveBeenCalled()
  })

  it('allows navigate after user confirm', async () => {
    const r = await browserExecutor.execute(
      { action: 'navigate', mode: 'open', url: 'https://sohu.com/page' },
      baseCtx({
        toolUserConfirmed: true,
        browserConfig: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowedDomains: [] }
      })
    )
    expect(r.success).toBe(true)
  })

  it('close calls closeSession', async () => {
    const r = await browserExecutor.execute({ action: 'close' }, baseCtx())
    expect(r.success).toBe(true)
    expect(mockCloseSession).toHaveBeenCalledWith('sess1')
  })

  it('classifies 401 as credential error', async () => {
    mockGetOrCreate.mockResolvedValueOnce({
      stagehand: {
        extract: vi.fn().mockRejectedValue(new Error('401 Unauthorized')),
        context: {
          pages: () => [{ url: () => 'https://example.com' }]
        }
      }
    })
    const r = await browserExecutor.execute(
      { action: 'extract', instruction: 'get text' },
      baseCtx()
    )
    expect(r.error).toContain('凭证无效')
  })

  it('returns rate limit rejected error', async () => {
    mockAcquire.mockRejectedValueOnce(new RateLimitRejectedError('minute', 20))
    const r = await browserExecutor.execute(
      { action: 'observe' },
      baseCtx({ toolUserConfirmed: true })
    )
    expect(r.success).toBe(false)
    expect(r.error).toContain(ErrorCodes.BROWSER_RATE_LIMIT_REJECTED)
  })

  it('calls acquire and succeeds in wait mode', async () => {
    const r = await browserExecutor.execute(
      { action: 'observe' },
      baseCtx()
    )
    expect(r.success).toBe(true)
    expect(mockAcquire).toHaveBeenCalled()
  })

  it('returns rate limit wait timeout error', async () => {
    mockAcquire.mockRejectedValueOnce(new RateLimitWaitTimeoutError(30))
    const r = await browserExecutor.execute(
      { action: 'extract', instruction: 'get title' },
      baseCtx()
    )
    expect(r.success).toBe(false)
    expect(r.error).toContain(ErrorCodes.BROWSER_RATE_LIMIT_WAIT_TIMEOUT)
  })

  it('returns cancelled when rate limit wait is aborted', async () => {
    mockAcquire.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))
    const r = await browserExecutor.execute(
      { action: 'act', instruction: 'click' },
      baseCtx()
    )
    expect(r.success).toBe(false)
    expect(r.error).toBe(CHAT_CANCELLED_MESSAGE)
  })

  it('act captures actions count and navigated flag', async () => {
    const page = {
      goto: vi.fn(),
      reload: vi.fn(),
      goBack: vi.fn(),
      goForward: vi.fn(),
      screenshot: vi.fn(),
      url: vi
        .fn()
        .mockReturnValueOnce('https://example.com/a')
        .mockReturnValueOnce('https://example.com/b'),
      title: vi.fn()
    }
    mockGetOrCreate.mockResolvedValueOnce({
      stagehand: {
        act: vi.fn().mockResolvedValue({
          success: true,
          actions: [{ method: 'click', selector: '#btn', description: 'Submit' }]
        }),
        context: { pages: () => [page] }
      }
    })
    const r = await browserExecutor.execute({ action: 'act', instruction: 'click submit' }, baseCtx())
    expect(r.success).toBe(true)
    expect(r.data).toMatchObject({ acted: true, navigated: true, actions: 1 })
  })

  it('does not call acquire for close', async () => {
    await browserExecutor.execute({ action: 'close' }, baseCtx())
    expect(mockAcquire).not.toHaveBeenCalled()
  })

  it('does not call acquire for screenshot', async () => {
    const r = await browserExecutor.execute({ action: 'screenshot' }, baseCtx())
    expect(r.success).toBe(true)
    expect(mockAcquire).not.toHaveBeenCalled()
  })

  it('returns dependencyError when chromium missing', async () => {
    const { stagehandService } = await import('../browser/stagehandService')
    vi.mocked(stagehandService.detectDependencies).mockResolvedValueOnce({
      stagehand: { installed: true, version: '3.0.0' },
      playwright: { installed: true, browsers: ['chromium'] },
      chromium: { ready: false },
      node: { version: 'v22.0.0', meetsRequirement: true },
      canInitialize: false,
      primaryFailure: 'chromium_missing',
      errors: ['Chromium 浏览器未安装'],
      recommendedCwd: 'E:\\Develop\\SpaceAssistant',
      installContext: 'development'
    })
    const r = await browserExecutor.execute(
      { action: 'navigate', mode: 'open', url: 'https://example.com/' },
      baseCtx({ toolUserConfirmed: true })
    )
    expect(r.success).toBe(false)
    expect(r.dependencyError?.errorCode).toBe('chromium_missing')
    expect(mockGetOrCreate).not.toHaveBeenCalled()
  })
})
