/**
 * P2 验收端到端（mock provider + 内存 DB）：automation 回合写操作 → AgentChannel 裁决双路径。
 * - approve：放行执行、无缓存写入（I3）、回合收敛；
 * - deny：理由回传（模型可读）、回合收敛不中止。
 * 回答者经真实链路解析：gate（automation-default-confirm）→ resolveConfirmChannel（automation=agent）
 * → AgentChannel → runApprovalAgent（mock 裁决）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import type { ApprovalInvocationResult, SecurityAuditEvent } from '../src/shared/confirmation/types'

const mockRunApprovalAgent = vi.fn(async (): Promise<ApprovalInvocationResult> => ({
  ok: true,
  verdict: { kind: 'approve', reason: { summary: '常规写入，风险可控' } }
}))
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

vi.mock('./toolConfirmRegistry', () => ({
  registerToolCancel: vi.fn(() => ({ aborted: false, addEventListener: vi.fn() })),
  clearToolCancel: vi.fn(),
  cancelAllToolConfirmsForRequest: vi.fn(),
  prepareToolConfirm: vi.fn(),
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

vi.mock('./confirmation/approvalAgent', () => ({
  runApprovalAgent: (...args: unknown[]) => mockRunApprovalAgent(...(args as [never, never])),
  APPROVAL_MAX_ROUNDS: 3,
  APPROVAL_READONLY_TOOLS: ['read_file', 'list_directory', 'grep', 'list_work_dirs', 'history.read', 'skills.read'],
  DEFAULT_APPROVAL_MODEL: 'claude-haiku-4-5-20251001'
}))

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

let streamRound = 0
/** round0 发起写操作；其后模型每轮继续发起（deny 路径验证不中止），CONVERGE_ROUND 轮收敛为文本。 */
const CONVERGE_ROUND = 3
function installStreamClient() {
  streamRound = 0
  capturedStreamParams.length = 0
  mockCreateAnthropicClient.mockReturnValue({
    messages: {
      stream: vi.fn((params: { messages: unknown[] }) => {
        capturedStreamParams.push({ messages: params.messages })
        const round =
          streamRound < CONVERGE_ROUND
            ? {
                content: [
                  {
                    type: 'tool_use',
                    id: `toolu-e2e-${streamRound}`,
                    name: 'write_file',
                    input: { path: 'out.txt', content: 'x' }
                  }
                ],
                stop_reason: 'tool_use'
              }
            : {
                content: [{ type: 'text', text: '任务完成（含被拒说明）' }],
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
    requestId: 'req-e2e-approval',
    sessionId: 'sess-e2e-approval',
    model: 'claude-sonnet-4-20250514',
    baseUrl: 'http://localhost:9999',
    lane: 'automation' as const,
    messages: [{ role: 'user' as const, content: 'please write' }],
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, deniedTools: [] },
    workDir: '/tmp',
    userDataDir: '/tmp/spaceassistant-test-userdata',
    getApiKey: async () => 'test-key',
    appDb: db,
    emitFactEvent: () => undefined,
    emitSessionEvent: () => undefined
  } as Parameters<typeof runToolChatSession>[0]
}

describe('V4 端到端：automation 写操作在审批 Agent 前由 locked 规则拒绝', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedAuditEvents.length = 0
    mockRunApprovalAgent.mockImplementation(async () => ({
      ok: true,
      verdict: { kind: 'approve', reason: { summary: '常规写入，风险可控' } }
    }))
  })

  it('即使审批 Agent 可批准，automation 写操作也终局拒绝且不会调用 Agent', async () => {
    installStreamClient()
    const db = makeDb()
    const res = await runAssembledSession(baseArgs(db))
    expect(res.ok).toBe(true)
    expect(mockRunApprovalAgent).not.toHaveBeenCalled()
    expect(JSON.stringify(capturedStreamParams[1]!.messages)).toContain('无人值守调用不得写入本地文件')
    expect(capturedAuditEvents.filter((e) => e.event === 'cache.write')).toHaveLength(0)
    expect(capturedStreamParams.length).toBe(CONVERGE_ROUND + 1)
  })
})
