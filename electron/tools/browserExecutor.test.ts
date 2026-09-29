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
import { BROWSER_REMOTE_DISABLED_CODE } from '../../src/shared/browserRemotePolicy'
import { ErrorCodes } from '../../src/shared/errorCodes'
import { RateLimitRejectedError, RateLimitWaitTimeoutError } from '../browser/rateLimiter'
import { browserExecutor } from './browserExecutor'
import { createBrowserRegisteredTool } from './browserRegisteredTool'
import { CapabilityRegistry } from '../../packages/agent-sdk/src/capability'
import { InMemoryExecutionAdmissionCoordinator } from '../../packages/agent-sdk/src/executionAdmission'
import { SafetyGate } from '../../packages/agent-sdk/src/safetyGate'
import { InMemorySafetyPermitStore } from '../../packages/agent-sdk/src/safetyPermit'
import { runAgentTurn } from '../../packages/agent-sdk/src/turn'
import { MemoryHistory } from '../../packages/agent-sdk/src/history'
import { ModelProviderRegistry, type StreamChunk } from '../../packages/agent-sdk/src/model'
import { TypedToolRegistry } from './plannedToolRegistry'
import { createRegisteredAgentTurnTools } from './registeredAgentTurnTools'
import { ToolRevocationRegistry } from '../toolRevocationRegistry'

async function* modelChunks(...chunks: StreamChunk[]) { yield* chunks }

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

  it('rejects a prepared browser action when BrowserConfig changes before dispatch', async () => {
    const registered = createBrowserRegisteredTool(browserExecutor)
    const controller = new AbortController()
    const initialContext = baseCtx({ browserConfig: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowRemoteSessions: false } })
    const handle = await registered.begin(
      { action: 'navigate', mode: 'open', url: 'https://example.com' },
      { requestId: 'browser-config-drift', toolUseId: 'browser-config-drift-call', signal: controller.signal, executionContext: initialContext }
    )
    handle.awaitConfirmation()
    handle.confirm()
    handle.beginValidation()

    await expect(handle.validatePrepared({
      requestId: 'browser-config-drift', toolUseId: 'browser-config-drift-call', signal: controller.signal,
      runtimeContext: baseCtx({ browserConfig: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowRemoteSessions: true } })
    })).rejects.toThrow('BROWSER_PREPARED_POLICY_CHANGED')
    expect(mockGetOrCreate).not.toHaveBeenCalled()
    handle.fail()
    handle.release()
  })

  it('keeps the approved user-confirmation state when validating and executing a prepared browser action', async () => {
    const execute = vi.fn(async () => ({ success: true }))
    const registered = createBrowserRegisteredTool({ name: 'browser', execute } as never)
    const controller = new AbortController()
    const browserConfig = { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowRemoteSessions: true, actRequiresConfirm: true }
    const initialContext = baseCtx({ browserConfig, lane: 'feishu', remoteContext: { source: 'feishu' }, toolUserConfirmed: false })
    const refreshedContext = baseCtx({ browserConfig: { ...browserConfig }, lane: 'feishu', remoteContext: { source: 'feishu' }, toolUserConfirmed: true })
    const handle = await registered.begin(
      { action: 'act', instruction: 'click the submit button' },
      { requestId: 'browser-confirmation-state', toolUseId: 'browser-confirmation-state-call', signal: controller.signal, executionContext: initialContext }
    )
    handle.awaitConfirmation()
    handle.confirm()
    handle.beginValidation()

    await expect(handle.validatePrepared({
      requestId: 'browser-confirmation-state', toolUseId: 'browser-confirmation-state-call', signal: controller.signal,
      runtimeContext: refreshedContext
    })).resolves.toBeUndefined()
    handle.finishValidation()
    await expect(handle.execute({
      requestId: 'browser-confirmation-state', toolUseId: 'browser-confirmation-state-call', signal: controller.signal,
      runtimeContext: refreshedContext
    })).resolves.toEqual({ success: true })
    expect(execute).toHaveBeenCalledWith(
      { action: 'act', instruction: 'click the submit button' },
      expect.objectContaining({ toolUserConfirmed: true })
    )
    handle.release()
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
    await expect(exec).rejects.toMatchObject({ name: 'BrowserExecutionUncertainError' })
  })

  it('Stagehand 操作启动后超时会标记页面结果未知', async () => {
    const observe = vi.fn(() => new Promise<never>(() => {}))
    mockGetOrCreate.mockResolvedValueOnce({
      stagehand: {
        context: { pages: () => [{ url: () => 'https://example.com' }] },
        observe
      }
    })

    await expect(browserExecutor.execute(
      { action: 'observe', instruction: 'inspect page' },
      baseCtx({ sessionId: 'browser-timeout-session', browserConfig: { ...DEFAULT_BROWSER_CONFIG, enabled: true, actionTimeoutSec: 0.01 } })
    )).rejects.toMatchObject({ name: 'BrowserExecutionUncertainError' })
    expect(observe).toHaveBeenCalledOnce()
    expect(mockCloseSession).toHaveBeenCalledWith('browser-timeout-session')
  })

  it.each([
    ['act', 'revoke'], ['act', 'cancel'], ['navigate', 'revoke'], ['navigate', 'cancel']
  ] as const)('Hosted browser %s 在 claim 后 %s 时以 unknown-after-dispatch 收尾且不再次请求模型', async (action, invalidation) => {
    let enteredAction!: () => void
    const atAction = new Promise<void>((resolve) => { enteredAction = resolve })
    const pendingAction = vi.fn(() => {
      enteredAction()
      return new Promise<never>(() => {})
    })
    const page = {
      url: () => 'https://example.com',
      ...(action === 'navigate' ? { goto: pendingAction } : {})
    }
    mockGetOrCreate.mockResolvedValueOnce({
      stagehand: {
        ...(action === 'act' ? { act: pendingAction } : {}),
        context: { pages: () => [page] }
      }
    })
    const requestId = 'browser-hosted-revoke'
    const invocationId = 'browser-hosted-invocation'
    const turnId = 'browser-hosted-turn'
    const admission = new InMemoryExecutionAdmissionCoordinator()
    const permits = new InMemorySafetyPermitStore()
    const revocations = new ToolRevocationRegistry()
    revocations.registerToolRevocationRequest(requestId, 'desktop')
    const registry = new TypedToolRegistry()
    registry.register(createBrowserRegisteredTool(browserExecutor))
    const tools = createRegisteredAgentTurnTools({
      requestId, turnId, registry, permits, admission, toolRevocations: revocations,
      createExecutionContext: (call) => ({
        ...baseCtx({ requestId, toolUseId: call.toolCallId, sessionId: 'browser-hosted-session' }),
        browserConfig: { ...DEFAULT_BROWSER_CONFIG, enabled: true, navigateRequiresConfirm: false, actionTimeoutSec: 0.2 },
        appDatabase: {} as never,
        toolUserConfirmed: true
      } as never),
      resolveAuthorizationVersion: () => 'browser-policy-v1'
    })
    const capabilities = new CapabilityRegistry()
    capabilities.define(invocationId, ['browser'])
    const safetyGate = new SafetyGate({ capabilities, permitStore: permits, policy: {
      evaluate: async (binding) => ({ kind: 'allow', authorizationVersion: binding.authorizationVersion })
    } })
    const route = { routeId: 'browser-hosted-route', protocol: 'anthropic-messages', dialect: 'test-v1', adapterVersion: '1', modelId: 'test-model' }
    const providers = new ModelProviderRegistry()
    const controller = new AbortController()
    let providerCalls = 0
    providers.register(route, { providerId: 'browser-hosted-provider', stream: () => {
        providerCalls += 1
        return modelChunks(
        { type: 'tool-call', toolCallId: `browser-${action}-call`, toolName: 'browser', input: action === 'act'
          ? { action, instruction: 'click the submit button' }
          : { action, mode: 'open', url: 'https://example.com' } },
        { type: 'usage', inputTokens: 1, outputTokens: 1 }, { type: 'finish', reason: 'tool-calls' }
      )
    } })
    const history = new MemoryHistory()
    const turn = runAgentTurn({
      registry: providers, routeId: route.routeId, invocationId, turnId,
      request: { messages: [{ role: 'user', content: 'submit the form' }], maxTokens: 50, signal: controller.signal },
      safetyGate, prepareTool: tools.prepareTool, discardPreparedTool: tools.discardPreparedTool,
      toolExecution: tools.toolExecution, maxModelTurns: 2, history
    })

    await atAction
    expect(pendingAction).toHaveBeenCalledOnce()
    if (invalidation === 'revoke') {
      expect(revocations.revokeToolForLane('desktop', 'browser')).toBe(1)
    } else {
      controller.abort()
    }
    await expect(turn).rejects.toMatchObject({ name: 'ToolExecutionAfterDispatchError' })
    const events = (await history.read(invocationId)).events
    expect(events.at(-1)).toMatchObject({ kind: 'invocation-interrupted', payload: { reason: 'unknown-after-dispatch' } })
    expect(events.some(({ kind }) => kind === 'tool-call-finished')).toBe(false)
    expect(providerCalls).toBe(1)
    expect(admission.activeLeaseCount(requestId, invocationId)).toBe(0)
    expect(mockCloseSession).toHaveBeenCalledWith('browser-hosted-session')
  }, 10_000)

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
          confirmPolicy: 'im_confirm'
        },
        browserConfig: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowRemoteSessions: false }
      })
    )
    expect(r.success).toBe(false)
    expect(r.error).toBe(BROWSER_REMOTE_DISABLED_CODE)
    expect(mockGetOrCreate).not.toHaveBeenCalled()
  })

  it('rejects wechat remote when allowRemoteSessions is false', async () => {
    const r = await browserExecutor.execute(
      { action: 'navigate', mode: 'open', url: 'https://example.com' },
      baseCtx({
        remoteContext: {
          source: 'wechat',
          messageId: 'm1',
          userId: 'u1',
          contextToken: 'c',
          confirmPolicy: 'im_confirm'
        },
        browserConfig: { ...DEFAULT_BROWSER_CONFIG, enabled: true, allowRemoteSessions: false }
      })
    )
    expect(r.success).toBe(false)
    expect(r.error).toBe(BROWSER_REMOTE_DISABLED_CODE)
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
