import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'

const mockGetCachedMemoryContent = vi.fn(() => null)

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn(),
  logAgentError: vi.fn()
}))

vi.mock('./projectMemory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./projectMemory')>()
  return { ...actual, getCachedMemoryContent: () => mockGetCachedMemoryContent() }
})

// 每用例重建：registerChatCancel 返回真实 AbortController.signal（1b 的 abort 监听与
// llm.cancel 计时都挂在它上面）；signalChatCancel 语义由测试直接 abort 模拟
let chatCancelController = new AbortController()

vi.mock('./chatCancelRegistry', () => ({
  registerChatCancel: vi.fn(() => chatCancelController.signal),
  clearChatCancel: vi.fn(),
  throwIfChatCancelled: vi.fn(),
  ChatCancelledError: class ChatCancelledError extends Error {},
  // A2(偏差 18)：runtime 工厂经本模块取类构造实例
  ChatCancelRegistry: class ChatCancelRegistry {
    register = vi.fn(() => new AbortController().signal)
    signalChatCancel = vi.fn()
    clear = vi.fn()
    throwIfCancelled = vi.fn()
    cancelAllActiveChats = vi.fn()
  }
}))

vi.mock('./sessionTitleSuggest', () => ({
  scheduleSessionTitleSuggestion: vi.fn(),
  countVisibleTitleMessagesForSuggest: vi.fn(() => 0),
  reachedCumulativeMessagesForTitleSuggest: vi.fn(() => false)
}))

vi.mock('./tools/builtinExecutors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/builtinExecutors')>()
  return { ...actual, getRegisteredTool: vi.fn(() => undefined), getToolExecutor: vi.fn(() => undefined) }
})

vi.mock('./browser/stagehandService', () => ({
  stagehandService: { resetInferenceCount: vi.fn() }
}))

vi.mock('./toolConfirmRegistry', () => ({
  registerToolCancel: vi.fn(),
  clearToolCancel: vi.fn(),
  cancelAllToolConfirmsForRequest: vi.fn(),
  prepareToolConfirm: vi.fn(),
  waitForToolConfirm: vi.fn(async () => 'approved')
}))

vi.mock('./mcp/mcpToolRegistry', () => ({
  buildSnapshotFromDb: vi.fn(() => ({ entries: new Map(), budgetDropped: [] })),
  snapshotEntriesToAnthropicTools: vi.fn(() => []),
  sanitizeMcpSnapshotForExecutors: vi.fn((snapshot: unknown) => snapshot)
}))

vi.mock('./mcp/mcpConfigStore', () => ({
  listProfiles: vi.fn(() => [])
}))

vi.mock('./database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./database')>()
  return { ...actual, getSession: vi.fn(() => undefined) }
})

import { runToolChatSession } from './toolChatLoop'
import { assembleInvocation } from './testSupport/invocationAssembler'
import { createMemoryAppDb } from './database/testHelpers'
import { logAgentEvent } from './agentLogger/agentLogger'
import { createAgentRuntime } from './runtime/agentRuntime'
import { getDefaultAgentRuntime, setDefaultAgentRuntime } from './runtime/agentRuntimeDefaults'
import { ToolRevocationRegistry } from './toolRevocationRegistry'
import { TypedToolRegistry } from './tools/plannedToolRegistry'
import { createHostedTurnHandoff } from './runtime/hostedTurnHandoff'
import { MemoryHistory } from '../packages/agent-sdk/src/history'

const PROVIDER_ROUTE_ID = 'desktop-anthropic:abort-signal'
const REQUEST_ID = 'req-abort-hosted'
const SESSION_ID = 'sess-abort-hosted'

/**
 * hosted 路径的中止测试装配（R1 口径：产品只有 hosted 一条执行路径）。
 * provider 流产出 text + usage 后挂起在「signal abort 才拒绝」的间隔上，
 * 模拟 SDK RequestOptions.signal 的 fetch 层中断语义；返回句柄供用例控制与断言。
 */
function startHostedSession() {
  const previousRuntime = getDefaultAgentRuntime()
  const runtime = createAgentRuntime({ builtinRegistry: new TypedToolRegistry() as never, toolRevocations: new ToolRevocationRegistry() })
  setDefaultAgentRuntime(runtime)
  let releaseGap!: () => void
  const inGap = new Promise<void>((resolve) => { releaseGap = resolve })
  runtime.modelProviders.register({
    routeId: PROVIDER_ROUTE_ID, protocol: 'anthropic-messages', dialect: 'anthropic-messages-2023-06-01',
    adapterVersion: 'pi-ai@0.87.1', modelId: 'claude-sonnet-4-20250514'
  }, {
    providerId: 'abort-signal',
    async *stream(call: { request: { signal?: AbortSignal } }) {
      yield { type: 'text-delta', text: 'partial' }
      yield { type: 'usage', inputTokens: 7, outputTokens: 3 }
      releaseGap()
      await new Promise<never>((_, reject) => {
        call.request.signal?.addEventListener('abort', () => reject(new Error('PROVIDER_STREAM_ABORTED')), { once: true })
      })
      yield { type: 'finish', reason: 'stop' }
    }
  })

  const { invocation, ports, agentSdk } = assembleInvocation({
    requestId: REQUEST_ID, sessionId: SESSION_ID, turnId: `turn-${REQUEST_ID}`, lane: 'desktop',
    model: 'claude-sonnet-4-20250514', providerRouteId: PROVIDER_ROUTE_ID,
    messages: [{ id: 'input-user', role: 'user', content: 'hello' }], currentUserMessageId: 'input-user',
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, mcpDeferredLoading: 'off' }, workDir: '/tmp', userDataDir: '/tmp',
    getApiKey: async () => 'test-key',
    appDb: createMemoryAppDb('zh-CN') as unknown as AppDatabase,
    emitFactEvent: () => undefined, emitSessionEvent: async () => undefined
  } as never)
  ports.history = new MemoryHistory()
  ports.toolRevocations = undefined
  const recordTurnSummary = vi.fn()
  ports.usage = { recordTurnSummary } as never

  const hostedAgentSdk = {
    ...agentSdk,
    createHostedTurnRuntime: (input: Parameters<typeof agentSdk.createHostedTurnRuntime>[0]) =>
      agentSdk.createHostedTurnRuntime({
        ...input,
        registry: new TypedToolRegistry(),
        confirmationAdapter: {
          cancel: () => undefined,
          publish: () => undefined,
          createChannel: () => ({
            request: async () => ({ kind: 'approved', cause: 'user-approved' }),
            cancel: () => undefined
          })
        } as never
      })
  }
  const hosted = createHostedTurnHandoff({
    agentSdk: hostedAgentSdk as never, history: ports.history!, invocationId: invocation.trace.turnId,
    turnId: invocation.trace.turnId, routeId: PROVIDER_ROUTE_ID
  })
  let capturedRequestSignal: AbortSignal | undefined
  const handoff = async (input: { request: { signal?: AbortSignal } }) => {
    capturedRequestSignal = input.request.signal
    return hosted(input as never)
  }
  const run = runToolChatSession(invocation, ports, { onHostedTurnHandoff: handoff as never })
  return {
    run,
    waitInGap: inGap,
    capturedRequestSignal: () => capturedRequestSignal,
    recordTurnSummary,
    cleanup: () => setDefaultAgentRuntime(previousRuntime)
  }
}

describe('runToolChatSession hosted 路径 LLM 中止（chat-turn-cancel 方案 2e 重做）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetCachedMemoryContent.mockReturnValue(null)
    chatCancelController = new AbortController()
  })

  it('契约：hosted handoff 的模型请求携带当前 chatSignal', async () => {
    const session = startHostedSession()
    try {
      await session.waitInGap
      expect(session.capturedRequestSignal()).toBe(chatCancelController.signal)

      chatCancelController.abort()
      await expect(session.run).resolves.toMatchObject({ ok: false, cancelled: true })
    } finally {
      session.cleanup()
    }
  })

  it('流中段 abort：结算为 cancelled 而非 failed，且不落入 llm.error', async () => {
    const session = startHostedSession()
    try {
      await session.waitInGap
      chatCancelController.abort()

      await expect(session.run).resolves.toMatchObject({ ok: false, cancelled: true })

      const llmErrorCalls = vi.mocked(logAgentEvent).mock.calls.filter(([, event]) => event === 'llm.error')
      expect(llmErrorCalls).toHaveLength(0)
    } finally {
      session.cleanup()
    }
  })

  it('llm.cancel 审计：abort 后在 Inner catch 留痕，字段含 loopRound 与 abortToCatchMs', async () => {
    const session = startHostedSession()
    try {
      await session.waitInGap
      chatCancelController.abort()

      await expect(session.run).resolves.toMatchObject({ ok: false, cancelled: true })

      const cancelCalls = vi.mocked(logAgentEvent).mock.calls.filter(([, event]) => event === 'llm.cancel')
      expect(cancelCalls).toHaveLength(1)
      expect(cancelCalls[0]?.[0]).toBe('warn')
      expect(cancelCalls[0]?.[2]).toMatchObject({
        requestId: REQUEST_ID,
        sessionId: SESSION_ID,
        loopRound: 1,
        abortToCatchMs: expect.any(Number)
      })
    } finally {
      session.cleanup()
    }
  })

  it('取消轮收尾照常落账：turn summary 以 cancelled 结算（9-29 B1 钉子的 hosted 等价）', async () => {
    const session = startHostedSession()
    try {
      await session.waitInGap
      chatCancelController.abort()

      await expect(session.run).resolves.toMatchObject({ ok: false, cancelled: true })

      expect(session.recordTurnSummary).toHaveBeenCalledTimes(1)
      expect(session.recordTurnSummary.mock.calls[0]?.[0]).toMatchObject({
        turnId: `turn-${REQUEST_ID}`,
        sessionId: SESSION_ID,
        outcome: 'cancelled'
      })
    } finally {
      session.cleanup()
    }
  })
})
