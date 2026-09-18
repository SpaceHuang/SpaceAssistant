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
    userDataDir: '/tmp',
    getApiKey: async () => 'test-key',
    appDb: db,
    emitFactEvent: () => undefined,
    emitSessionEvent: () => undefined
  } as Parameters<typeof runToolChatSession>[0]
}

describe('P2 端到端：automation 写操作由审批 Agent 裁决', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedAuditEvents.length = 0
    mockRunApprovalAgent.mockImplementation(async () => ({
      ok: true,
      verdict: { kind: 'approve', reason: { summary: '常规写入，风险可控' } }
    }))
  })

  it('approve 路径：写操作放行执行、confirm.outcome actor=agent、无 cache.write（I3）', async () => {
    installStreamClient()
    const db = makeDb()
    const res = await runToolChatSession(baseArgs(db))
    expect(res.ok).toBe(true)
    // 裁决确实走了审批链
    expect(mockRunApprovalAgent).toHaveBeenCalled()
    // P1-1 凭证对装配：装配方把外层会话的 model/baseUrl/getApiKey 配对传给审批链
    const assembleDeps = mockRunApprovalAgent.mock.calls[0]![0] as {
      model: string
      baseUrl?: string
      getApiKey: () => Promise<string | null>
    }
    expect(assembleDeps.model).toBe('claude-sonnet-4-20250514')
    expect(assembleDeps.baseUrl).toBe('http://localhost:9999')
    expect(typeof assembleDeps.getApiKey).toBe('function')
    const inv = mockRunApprovalAgent.mock.calls[0]![1] as { clue: { toolName: string; summary: string; targetPath?: string } }
    expect(inv.clue.toolName).toBe('write_file')
    expect(inv.clue.targetPath).toBe('out.txt')
    // 审计：confirm.request/outcome 成对，actor=agent，cause=agent-approved
    const outcomeEv = capturedAuditEvents.find((e) => e.event === 'confirm.outcome')
    expect(outcomeEv).toBeTruthy()
    expect(outcomeEv!.actor).toBe('agent')
    expect(outcomeEv!.cause).toBe('agent-approved')
    // I3：无任何缓存写入
    expect(capturedAuditEvents.filter((e) => e.event === 'cache.write')).toHaveLength(0)
    // 工具实际执行（approve 后 executor 被调用，模型第 2 轮继续 → 第 CONVERGE_ROUND+1 轮收敛）
    expect(capturedStreamParams.length).toBe(CONVERGE_ROUND + 1)
  })

  it('deny 路径：理由回传模型可见、回合收敛不中止（连续拒绝不到安全阈值）', async () => {
    mockRunApprovalAgent.mockImplementation(async () => ({
      ok: true,
      verdict: { kind: 'deny', reason: { summary: '审批拒绝：该写操作超出安全边界，请改用只读方式' } }
    }))
    installStreamClient()
    const db = makeDb()
    const res = await runToolChatSession(baseArgs(db))
    expect(res.ok).toBe(true)
    // 每轮拒绝后模型仍被允许继续改方案（CONVERGE_ROUND=3 次拒绝 < 安全桶阈值 5）
    expect(capturedStreamParams.length).toBe(CONVERGE_ROUND + 1)
    // 理由回传：第 2 轮起的模型可见 tool_result 携带 deny reason.summary
    const serialized = JSON.stringify(capturedStreamParams[1]!.messages)
    expect(serialized).toContain('审批拒绝：该写操作超出安全边界，请改用只读方式')
    const outcomeEv = capturedAuditEvents.find((e) => e.event === 'confirm.outcome')
    expect(outcomeEv!.cause).toBe('agent-deny')
    expect(outcomeEv!.actor).toBe('agent')
  })

  it('审批服务不可用：fail-closed deny（cause=unavailable 可区分），回合仍收敛', async () => {
    mockRunApprovalAgent.mockImplementation(async () => ({ ok: false, cause: 'unavailable' }))
    installStreamClient()
    const db = makeDb()
    const res = await runToolChatSession(baseArgs(db))
    expect(res.ok).toBe(true)
    const outcomeEv = capturedAuditEvents.find((e) => e.event === 'confirm.outcome')
    expect(outcomeEv!.cause).toBe('unavailable')
    // 不可用理由对模型可读（fail-closed 且不可静默）
    const serialized = JSON.stringify(capturedStreamParams[1]!.messages)
    expect(serialized).toContain('安全审批服务暂不可用')
  })
})

describe('P2 端到端：任务声明透传（D）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRunApprovalAgent.mockImplementation(async () => ({
      ok: true,
      verdict: { kind: 'approve', reason: { summary: '常规写入，风险可控' } }
    }))
  })

  it('args.approvalTaskDigest → AgentChannel → 线索包 clue.taskDigest 全链透传', async () => {
    installStreamClient()
    const db = makeDb()
    const res = await runToolChatSession({
      ...baseArgs(db),
      approvalTaskDigest: '整理报告目录并汇总周报'
    })
    expect(res.ok).toBe(true)
    expect(mockRunApprovalAgent).toHaveBeenCalled()
    const inv = mockRunApprovalAgent.mock.calls[0]![1] as { clue: { taskDigest?: string } }
    expect(inv.clue.taskDigest).toBe('整理报告目录并汇总周报')
  })

  it('未传 approvalTaskDigest → clue.taskDigest 缺省 undefined（无任务上下文调用方安全）', async () => {
    installStreamClient()
    const db = makeDb()
    const res = await runToolChatSession(baseArgs(db))
    expect(res.ok).toBe(true)
    const inv = mockRunApprovalAgent.mock.calls[0]![1] as { clue: { taskDigest?: string } }
    expect(inv.clue.taskDigest).toBeUndefined()
  })
})
