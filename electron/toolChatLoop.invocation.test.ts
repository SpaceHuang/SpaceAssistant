import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'

/**
 * P1 Invocation 契约（形状测试）：AgentInvocation / AgentHostPorts / 装配器键位平移
 * 与 events 出口对象化（含 notify 取代 floatingNotificationManager 直传）。
 */

const mockGetCachedMemoryContent = vi.fn(() => null)
const mockCreateAnthropicClient = vi.fn()
const mockConfirmOutcome = vi.fn(async () => 'approved' as const)
let streamRound = 0
const capturedFacts: Array<Record<string, unknown>> = []
const capturedSessionEvents: Array<Record<string, unknown>> = []

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn(),
  logAgentError: vi.fn()
}))

vi.mock('./projectMemory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./projectMemory')>()
  return {
    ...actual,
    getCachedMemoryContent: () => mockGetCachedMemoryContent()
  }
})

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicClient: (...args: unknown[]) => mockCreateAnthropicClient(...args)
}))

vi.mock('./chatCancelRegistry', () => ({
  registerChatCancel: vi.fn(() => ({ aborted: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  clearChatCancel: vi.fn(),
  throwIfChatCancelled: vi.fn(),
  ChatCancelledError: class ChatCancelledError extends Error {}
}))

vi.mock('./sessionTitleSuggest', () => ({
  scheduleSessionTitleSuggestion: vi.fn(),
  reachedCumulativeAssistantTurnsForTitleSuggest: vi.fn(() => false)
}))

vi.mock('./tools/builtinExecutors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/builtinExecutors')>()
  return {
    ...actual,
    getRegisteredTool: vi.fn(() => undefined),
    getToolExecutor: vi.fn((name: string) => (name === 'read_file'
      ? { name, execute: async () => ({ success: true, data: 'file-content' }) }
      : name === 'write_file'
        ? { name, execute: async () => ({ success: true, data: 'written' }) }
        : undefined))
  }
})

vi.mock('./browser/stagehandService', () => ({
  stagehandService: { resetInferenceCount: vi.fn() }
}))

vi.mock('./toolConfirmRegistry', () => ({
  registerToolCancel: vi.fn(),
  clearToolCancel: vi.fn(),
  waitForToolConfirm: vi.fn(async () => mockConfirmOutcome())
}))

vi.mock('./database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./database')>()
  return {
    ...actual,
    getSession: vi.fn(() => undefined)
  }
})

import { runToolChatSession } from './toolChatLoop'
import { assembleInvocation, type AgentInvocationMaterials } from './runtime/invocationAssembler'
import { createMemoryAppDb } from './database/testHelpers'

function makeDb(): AppDatabase {
  return createMemoryAppDb('zh-CN')
}

function makeStreamRounds(rounds: Array<{ content: unknown[]; stop_reason: string; usage?: Record<string, number> }>) {
  return {
    messages: {
      stream: vi.fn(() => {
        const round = rounds[Math.min(streamRound, rounds.length - 1)]
        streamRound += 1
        return {
          async *[Symbol.asyncIterator]() {},
          finalMessage: vi.fn(async () => round)
        }
      })
    }
  }
}

function baseMaterials(overrides: Partial<AgentInvocationMaterials> = {}): AgentInvocationMaterials {
  return {
    requestId: 'req-invocation-1',
    sessionId: 'sess-invocation-1',
    turnId: 'turn-invocation-1',
    windowId: 'win-1',
    llmServiceId: 'svc-1',
    model: 'claude-sonnet-4-20250514',
    messages: [{ role: 'user', content: 'hello' }] as never,
    toolsConfig: DEFAULT_TOOLS_CONFIG,
    workDir: '/tmp',
    userDataDir: '/tmp',
    getApiKey: async () => 'test-key',
    appDb: makeDb(),
    emitFactEvent: (event: Record<string, unknown>) => capturedFacts.push(event),
    emitSessionEvent: async (event: Record<string, unknown>) => {
      capturedSessionEvents.push(event)
    },
    ...overrides
  }
}

async function run(materials: AgentInvocationMaterials) {
  const { invocation, ports } = assembleInvocation(materials)
  return runToolChatSession(invocation, ports)
}

describe('assembleInvocation 键位平移（P1 契约形状）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamRound = 0
    capturedFacts.length = 0
    capturedSessionEvents.length = 0
  })

  it('trace / session / profile / limits / safety / additionalContext / driverContext 落位', () => {
    const materials = baseMaterials({
      lane: 'automation',
      internalConfirmExemption: 'approval-agent',
      maxToolLoopRounds: 3,
      approvalTaskDigest: 'task-digest-x',
      historyFacts: [{ id: 'f1', sessionId: 'sess-invocation-1', role: 'user', text: 't', tokens: 1 }] as never,
      remoteContext: { source: 'feishu', messageId: 'm1', confirmPolicy: 'always' } as never,
      system: 'sys',
      locale: 'zh-CN',
      skillFragments: ['frag'],
      baseUrl: 'https://relay.example.com'
    })
    const { invocation, ports } = assembleInvocation(materials)

    expect(invocation.trace).toEqual({ requestId: 'req-invocation-1', turnId: 'turn-invocation-1', windowId: 'win-1' })
    expect(invocation.session).toEqual({ sessionId: 'sess-invocation-1' })
    expect(invocation.profile.model).toBe('claude-sonnet-4-20250514')
    expect(invocation.profile.llmServiceId).toBe('svc-1')
    // P4：网络目标出契约，归 ports.credentials.networkTarget
    expect(ports.credentials.networkTarget?.baseUrl).toBe('https://relay.example.com')
    expect(invocation.profile.system).toBe('sys')
    expect(invocation.profile.locale).toBe('zh-CN')
    expect(invocation.profile.lane).toBe('automation')
    expect(invocation.profile.tools.toolsConfig).toBe(DEFAULT_TOOLS_CONFIG)
    expect(invocation.limits.maxToolRounds).toBe(3)
    expect(invocation.safety.recursionGuard).toBe('approval-agent')
    expect(invocation.additionalContext['approval.taskDigest']).toBe('task-digest-x')
    expect(invocation.additionalContext['facts.history']).toEqual([{ id: 'f1', sessionId: 'sess-invocation-1', role: 'user', text: 't', tokens: 1 }])
    expect(invocation.driverContext).toMatchObject({ source: 'feishu', messageId: 'm1' })
    // 端口落位：workspace / credentials 接口方法 / legacy 过渡（N1 声明的 P2 前豁免）
    expect(ports.workspace.workDir).toBe('/tmp')
    expect(ports.workspace.userDataDir).toBe('/tmp')
    expect(typeof ports.credentials.resolveApiKey).toBe('function')
    expect(ports.legacy?.appDb).toBe(materials.appDb)
  })

  it('messages 区块携带伴随元数据（currentUserMessageId / assistantMessageId / hasImageAttachments）', () => {
    const { invocation } = assembleInvocation(baseMaterials({
      currentUserMessageId: 'u1',
      assistantMessageId: 'a1',
      hasImageAttachments: true
    }))
    expect(invocation.messages.list).toEqual([{ role: 'user', content: 'hello' }])
    expect(invocation.messages.currentUserMessageId).toBe('u1')
    expect(invocation.messages.assistantMessageId).toBe('a1')
    expect(invocation.messages.hasImageAttachments).toBe(true)
  })

  it('floatingNotificationManager 不进契约：装配器包装为 events.notify 实现', () => {
    const calls: Array<Record<string, unknown>> = []
    const manager = {
      onConfirmRequest: (entry: Record<string, unknown>) => calls.push({ kind: 'confirm-request', ...entry }),
      onToolResult: (requestId: string, toolUseId: string) => calls.push({ kind: 'tool-result', requestId, toolUseId }),
      onAllCancelledForRequest: (requestId: string) => calls.push({ kind: 'request-all-cancelled', requestId })
    }
    const { invocation } = assembleInvocation(baseMaterials({ floatingNotificationManager: manager as never }))
    expect((invocation as Record<string, unknown>).floatingNotificationManager).toBeUndefined()
    expect(invocation.events.notify).toBeTypeOf('function')

    invocation.events.notify?.({ kind: 'confirm-request', requestId: 'r', sessionId: 's', sessionName: 'n', toolUseId: 't', toolName: 'run_shell', input: { command: 'ls' } })
    invocation.events.notify?.({ kind: 'tool-result', requestId: 'r', toolUseId: 't' })
    invocation.events.notify?.({ kind: 'request-all-cancelled', requestId: 'r' })
    expect(calls).toEqual([
      { kind: 'confirm-request', requestId: 'r', sessionId: 's', sessionName: 'n', toolUseId: 't', toolName: 'run_shell', input: { command: 'ls' }, createdAt: expect.any(Number) },
      { kind: 'tool-result', requestId: 'r', toolUseId: 't' },
      { kind: 'request-all-cancelled', requestId: 'r' }
    ])
  })

  it('不传 manager 时 notify 为 no-op 缺省（全 no-op 出口语义）', () => {
    const { invocation } = assembleInvocation(baseMaterials())
    expect(() => invocation.events.notify?.({ kind: 'tool-result', requestId: 'r', toolUseId: 't' })).not.toThrow()
  })
})

describe('runToolChatSession(invocation, ports) 行为等价（P1）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamRound = 0
    capturedFacts.length = 0
    capturedSessionEvents.length = 0
    mockGetCachedMemoryContent.mockReturnValue(null)
    mockConfirmOutcome.mockResolvedValue('approved')
  })

  it('契约入口完整跑一轮带工具调用的回合（events 出口对象化后行为不变）', async () => {
    mockCreateAnthropicClient.mockReturnValue(
      makeStreamRounds([
        { content: [{ type: 'tool_use', id: 'tu-inv1', name: 'read_file', input: { path: 'a.txt' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
        { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }
      ])
    )
    const res = await run(baseMaterials())
    expect(res).toMatchObject({ ok: true, content: [{ type: 'text', text: 'done' }] })
    expect(capturedFacts.some((fact) => fact.type === 'tool-result')).toBe(true)
    expect(capturedSessionEvents.some((event) => event.type === 'request_header')).toBe(true)
  })

  it('确认请求经 events.notify 出口投递（宿主 manager 收到 confirm-request）', async () => {
    const notifications: Array<Record<string, unknown>> = []
    const manager = {
      onConfirmRequest: (entry: Record<string, unknown>) => notifications.push({ kind: 'confirm-request', ...entry }),
      onToolResult: (requestId: string, toolUseId: string) => notifications.push({ kind: 'tool-result', requestId, toolUseId }),
      onAllCancelledForRequest: (requestId: string) => notifications.push({ kind: 'request-all-cancelled', requestId })
    }
    mockCreateAnthropicClient.mockReturnValue(
      makeStreamRounds([
        { content: [{ type: 'tool_use', id: 'tu-inv2', name: 'write_file', input: { path: 'x.txt', content: 'v' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
        { content: [{ type: 'text', text: 'written' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }
      ])
    )
    const res = await run(baseMaterials({ floatingNotificationManager: manager as never }))
    expect(res).toMatchObject({ ok: true })
    const confirmReq = notifications.find((n) => n.kind === 'confirm-request')
    expect(confirmReq).toMatchObject({ sessionId: 'sess-invocation-1', toolUseId: 'tu-inv2', toolName: 'write_file', requestId: 'req-invocation-1' })
    // 工具终态同样经 notify 出口（tool-result）
    expect(notifications.some((n) => n.kind === 'tool-result' && n.toolUseId === 'tu-inv2')).toBe(true)
  })
})
