/**
 * I3 回归锚点（P0 验收）：require-confirm + memoryTiers 非空 + 回答者为 agent + browser navigate。
 * 断言 decision_cache 无新增行、无 cache.write 审计——该用例在修复前的代码上为红（缺口 5）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import type { ConfirmOutcome, ContentFacts, Decision, SecurityAuditEvent } from '../src/shared/confirmation/types'
import type { ToolCallGateResult } from './confirmation/toolCallGate'

const mockChannelOutcome = vi.fn((): ConfirmOutcome => ({ kind: 'approved', cause: 'user-approved' }))
const gateState = vi.hoisted(() => ({ answerer: 'user' as 'user' | 'agent' }))
const capturedAuditEvents: SecurityAuditEvent[] = []

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn(),
  logAgentError: vi.fn()
}))

vi.mock('./chatCancelRegistry', () => ({
  registerChatCancel: vi.fn(() => ({ aborted: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  clearChatCancel: vi.fn(),
  throwIfChatCancelled: vi.fn(),
  ChatCancelledError: class ChatCancelledError extends Error {},
  // A2(偏差 18):runtime 工厂经本模块取类构造实例
  ChatCancelRegistry: class ChatCancelRegistry {
    register = vi.fn(() => ({ aborted: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    signalChatCancel = vi.fn()
    clear = vi.fn()
    throwIfCancelled = vi.fn()
    cancelAllActiveChats = vi.fn()
  }
}))

vi.mock('./sessionTitleSuggest', () => ({
  scheduleSessionTitleSuggestion: vi.fn(),
  reachedCumulativeAssistantTurnsForTitleSuggest: vi.fn(() => false)
}))

vi.mock('./browser/stagehandService', () => ({
  stagehandService: { resetInferenceCount: vi.fn(), peekCurrentUrl: vi.fn(() => undefined) }
}))

vi.mock('./toolConfirmRegistry', () => ({
  registerToolCancel: vi.fn(() => ({ aborted: false, addEventListener: vi.fn() })),
  clearToolCancel: vi.fn(),
  waitForToolConfirm: vi.fn(async () => 'approved' as const)
}))

vi.mock('./tools/builtinExecutors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/builtinExecutors')>()
  return {
    ...actual,
    getRegisteredTool: vi.fn(() => undefined),
    getToolExecutor: vi.fn((name: string) =>
      name === 'browser' ? { name, execute: async () => ({ success: true, data: 'navigated' }) } : undefined
    )
  }
})

vi.mock('./confirmation/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./confirmation/audit')>()
  return {
    ...actual,
    getSecurityAuditLog: vi.fn(() => ({ record: (e: SecurityAuditEvent) => capturedAuditEvents.push(e) }))
  }
})

vi.mock('./confirmation/channels', () => ({
  channelFor: vi.fn(() => ({
    request: async (): Promise<ConfirmOutcome> => mockChannelOutcome(),
    cancel: vi.fn()
  }))
}))

const I3_SESSION = 'sess-i3-anchor'
const I3_KEY = {
  kind: 'domain' as const,
  domain: 'example.com',
  level: 'domain-any-action' as const,
  sessionId: I3_SESSION
}

const I3_FACTS: ContentFacts = {
  toolName: 'browser',
  actionClass: 'outbound',
  baseRiskLevel: 'medium',
  signals: [{ kind: 'network-egress', domains: ['example.com'] }],
  summary: { text: 'browser navigate https://example.com' }
}

const I3_DECISION: Decision = {
  type: 'require-confirm',
  ruleId: 'navigate-requires-confirm',
  answerer: 'user',
  riskLevel: 'medium',
  facts: I3_FACTS,
  memoryTiers: [{ key: I3_KEY, label: '记住 example.com（本会话）' }],
  timeoutMs: null
}

vi.mock('./confirmation/toolCallGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./confirmation/toolCallGate')>()
  return {
    ...actual,
    evaluateToolCallGate: vi.fn(async (): Promise<ToolCallGateResult> => ({
      decision: { ...I3_DECISION, answerer: gateState.answerer },
      facts: I3_FACTS
    }))
  }
})

const mockCreateAnthropicClient = vi.fn()

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicClient: (...args: unknown[]) => mockCreateAnthropicClient(...args)
}))

import { runToolChatSession } from './toolChatLoop'
import { assembleInvocation } from './runtime/invocationAssembler'

/** P1：直调 Core 的测试适配——材料经装配器构造 Invocation + ports（断言不动，仅调用方式平移）。 */
function runAssembledSession(materials: unknown) {
  const { invocation, ports } = assembleInvocation(materials as never)
  return runToolChatSession(invocation, ports)
}
import { createMemoryAppDb } from './database/testHelpers'
import { SqliteDecisionCache } from './confirmation/sqliteDecisionCache'
import { getDbConnection } from './database'
import { writePolicyPackages } from './confirmation/policyRulesRuntime'

function makeDb(): AppDatabase {
  return createMemoryAppDb('zh-CN')
}

let streamRound = 0
function installStreamClient() {
  streamRound = 0
  mockCreateAnthropicClient.mockReturnValue({
    messages: {
      stream: vi.fn(() => {
        const round =
          streamRound === 0
            ? {
                content: [
                  {
                    type: 'tool_use',
                    id: 'toolu-i3-1',
                    name: 'browser',
                    input: { action: 'navigate', mode: 'open', url: 'https://example.com' }
                  }
                ],
                stop_reason: 'tool_use'
              }
            : {
                content: [{ type: 'text', text: 'done' }],
                stop_reason: 'end_turn'
              }
        streamRound += 1
        return {
          async *[Symbol.asyncIterator]() {},
          finalMessage: vi.fn(async () => round)
        }
      })
    }
  })
}

function baseArgs(db: AppDatabase) {
  return {
    requestId: 'req-i3-anchor',
    sessionId: I3_SESSION,
    model: 'claude-sonnet-4-20250514',
    baseUrl: 'http://localhost:9999',
    messages: [{ role: 'user' as const, content: 'navigate please' }],
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, deniedTools: [] },
    browserConfig: { enabled: true, env: 'LOCAL' } as unknown as import('../src/shared/domainTypes').BrowserConfig,
    workDir: '/tmp',
    userDataDir: '/tmp',
    getApiKey: async () => 'test-key',
    appDb: db,
    emitFactEvent: () => undefined,
    emitSessionEvent: () => undefined
  } as Parameters<typeof runToolChatSession>[0]
}

describe('I3 回归锚点：记忆只源于人类（P0 验收）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedAuditEvents.length = 0
    gateState.answerer = 'user'
    mockChannelOutcome.mockImplementation(() => ({ kind: 'approved', cause: 'user-approved' }))
  })

  it('回答者为 agent（decision.answerer）：navigate 批准也不写 decision_cache、无 cache.write 审计', async () => {
    gateState.answerer = 'agent'
    mockChannelOutcome.mockImplementation(() => ({
      kind: 'approved',
      answererKind: 'agent',
      cause: 'agent-approved'
    }) satisfies ConfirmOutcome)
    installStreamClient()
    const db = makeDb()
    await runAssembledSession(baseArgs(db))

    expect(new SqliteDecisionCache(getDbConnection(db)).lookup(I3_KEY)).toBeNull()
    expect(capturedAuditEvents.filter((e) => e.event === 'cache.write')).toHaveLength(0)
  })

  it('回答者为 user（strict 档，desktop standard 的 navigate 走「自动」agent）：批准照常双写 decision_cache', async () => {
    installStreamClient()
    const db = makeDb()
    // P1：desktop standard 的询问条目变换为「自动」（agent 裁决）；user 回答者路径取 strict 档
    writePolicyPackages(db, { desktop: 'strict', wechat: 'standard', feishu: 'standard', automation: 'standard' })
    await runAssembledSession(baseArgs(db))

    expect(new SqliteDecisionCache(getDbConnection(db)).lookup(I3_KEY)).not.toBeNull()
    expect(capturedAuditEvents.filter((e) => e.event === 'cache.write')).toHaveLength(1)
  })
})
