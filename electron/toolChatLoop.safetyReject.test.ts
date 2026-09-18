/**
 * P1-2 / P1-3 验收（管家链路现行伤害修复）：
 *  - 拒绝理由回传：ConfirmOutcome.reason.summary 渲染进模型可见工具结果；
 *  - 计数口径分离：连续 3 次同类安全拒绝不再中止 Turn（安全拒绝桶阈值 5，执行失败桶不变）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import type { ConfirmOutcome, ContentFacts, Decision, SecurityAuditEvent } from '../src/shared/confirmation/types'
import type { ToolCallGateResult } from './confirmation/toolCallGate'

const mockChannelOutcome = vi.fn((): ConfirmOutcome => ({ kind: 'approved', cause: 'user-approved' }))
const capturedAuditEvents: SecurityAuditEvent[] = []
const capturedStreamParams: Array<{ messages: unknown[] }> = []

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn(),
  logAgentError: vi.fn()
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
      name === 'write_file' ? { name, execute: async () => ({ success: true, data: 'written' }) } : undefined
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

const SAFETY_SUMMARY = '审批拒绝：该写操作超出安全边界，请改用只读方式或缩小范围'
const SR_SESSION = 'sess-safety-reject'

const SR_FACTS: ContentFacts = {
  toolName: 'write_file',
  actionClass: 'write',
  baseRiskLevel: 'medium',
  signals: [{ kind: 'path-target', path: 'out.txt', zone: 'workdir-normal' }],
  summary: { text: 'write_file out.txt' }
}

const SR_DECISION: Decision = {
  type: 'require-confirm',
  ruleId: 'automation-default-confirm',
  riskLevel: 'medium',
  facts: SR_FACTS,
  memoryTiers: [],
  timeoutMs: null
}

vi.mock('./confirmation/toolCallGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./confirmation/toolCallGate')>()
  return {
    ...actual,
    evaluateToolCallGate: vi.fn(async (): Promise<ToolCallGateResult> => ({
      decision: SR_DECISION,
      facts: SR_FACTS
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

function makeDb(): AppDatabase {
  return createMemoryAppDb('zh-CN')
}

/** 前_SAFE_ROUNDS 轮持续发起同一写操作，之后模型收敛为文本答复。 */
const SAFE_ROUNDS = 3
let streamRound = 0
function installStreamClient() {
  streamRound = 0
  capturedStreamParams.length = 0
  mockCreateAnthropicClient.mockReturnValue({
    messages: {
      stream: vi.fn((params: { messages: unknown[] }) => {
        capturedStreamParams.push({ messages: params.messages })
        const round =
          streamRound < SAFE_ROUNDS
            ? {
                content: [
                  {
                    type: 'tool_use',
                    id: `toolu-sr-${streamRound}`,
                    name: 'write_file',
                    input: { path: 'out.txt', content: 'x' }
                  }
                ],
                stop_reason: 'tool_use'
              }
            : {
                content: [{ type: 'text', text: '已完成：部分工作因安全拒绝未能执行' }],
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
    requestId: 'req-safety-reject',
    sessionId: SR_SESSION,
    model: 'claude-sonnet-4-20250514',
    baseUrl: 'http://localhost:9999',
    messages: [{ role: 'user' as const, content: 'please write' }],
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, deniedTools: [] },
    workDir: '/tmp',
    userDataDir: '/tmp',
    getApiKey: async () => 'test-key',
    appDb: db,
    emitFactEvent: () => undefined,
    emitSessionEvent: () => undefined
  } as Parameters<typeof runToolChatSession>[0]
}

describe('P1 安全拒绝理由回传与计数口径分离', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedAuditEvents.length = 0
    mockChannelOutcome.mockImplementation(() => ({
      kind: 'rejected',
      answererKind: 'agent',
      cause: 'agent-deny',
      reason: { summary: SAFETY_SUMMARY }
    }) satisfies ConfirmOutcome)
  })

  it('连续 3 次同类安全拒绝不中止 Turn：模型在第 4 轮收敛并看到拒绝理由', async () => {
    installStreamClient()
    const db = makeDb()
    const res = await runAssembledSession(baseArgs(db))
    expect(res.ok).toBe(true)
    // 第 4 轮请求发生 = 第 3 次拒绝后未 break（旧代码 safety 拒绝同键满 3 次即中止 → 红）
    expect(capturedStreamParams.length).toBeGreaterThanOrEqual(4)
    // 理由回传：第 2 轮起模型可见的 tool_result 中携带 reason.summary 渲染文案（旧代码为固定「用户拒绝执行此工具」→ 红）
    const secondRoundMessages = capturedStreamParams[1]!.messages
    const serialized = JSON.stringify(secondRoundMessages)
    expect(serialized).toContain(SAFETY_SUMMARY)
    expect(serialized).not.toContain('用户拒绝执行此工具')
  })

  it('执行失败桶阈值不变：同一执行错误连续 3 次仍中止 Turn（既有行为回归）', async () => {
    mockChannelOutcome.mockImplementation(() => ({ kind: 'approved', cause: 'user-approved' }) satisfies ConfirmOutcome)
    // 执行器恒失败（同一错误文案）
    const { getToolExecutor } = await import('./tools/builtinExecutors')
    vi.mocked(getToolExecutor).mockImplementation((name: string) =>
      name === 'write_file'
        ? { name, execute: async () => ({ success: false, error: 'EACCES: permission denied', userMessage: 'EACCES: permission denied' }) }
        : undefined
    )
    installStreamClient()
    const db = makeDb()
    await runAssembledSession(baseArgs(db))
    // 3 次执行失败后 break：第 4 轮请求不发生
    expect(capturedStreamParams.length).toBe(3)
  })
})
