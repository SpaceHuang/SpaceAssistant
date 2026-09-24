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

// 可控的父任务取消信号（failApprovalGroup 的 abort 触发路径验证用）
const chatCancelState = vi.hoisted(() => ({
  signal: null as { aborted: boolean; listeners: Array<() => void> } | null,
  // 忠实语义的取消错误：throwIfChatCancelled mock 与生产同样抛此类型，
  // 桌面取消收敛断言用 instanceof 校验（no-op mock 曾掩盖真实收敛顺序）
  ChatCancelledError: class ChatCancelledError extends Error {
    constructor() {
      super('会话已取消')
      this.name = 'ChatCancelledError'
    }
  }
}))

// 桌面确认卡的可控挂起（waitForToolConfirm 默认立即 approved；pending 模式挂起待取消结算）
const desktopConfirmControl = vi.hoisted(() => ({
  pendingMode: false,
  resolvers: [] as Array<(outcome: string) => void>
}))

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
  registerChatCancel: vi.fn(() => {
    const signal = { aborted: false, listeners: [] as Array<() => void> }
    chatCancelState.signal = signal
    return {
      get aborted() {
        return signal.aborted
      },
      addEventListener: (_type: string, fn: () => void) => {
        signal.listeners.push(fn)
      },
      removeEventListener: () => undefined
    }
  }),
  clearChatCancel: vi.fn(),
  signalChatCancel: vi.fn(),
  // 忠实语义（P1-1 复盘）：生产实现在 signal.aborted 时抛 ChatCancelledError
  throwIfChatCancelled: vi.fn((signal?: { aborted?: boolean }) => {
    if (signal?.aborted) throw new chatCancelState.ChatCancelledError()
  }),
  ChatCancelledError: chatCancelState.ChatCancelledError,
  // A2(偏差 18):runtime 工厂经本模块取类构造实例
  ChatCancelRegistry: class ChatCancelRegistry {
    register = vi.fn(() => ({ aborted: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    signalChatCancel = vi.fn()
    clear = vi.fn()
    throwIfCancelled = vi.fn()
    cancelAllActiveChats = vi.fn()
  }
}))

function abortParentTask(): void {
  const signal = chatCancelState.signal
  if (!signal) throw new Error('chatCancel signal 尚未创建（runToolChatSession 未启动）')
  signal.aborted = true
  for (const fn of signal.listeners) fn()
}

vi.mock('./sessionTitleSuggest', () => ({
  scheduleSessionTitleSuggestion: vi.fn(),
  reachedCumulativeAssistantTurnsForTitleSuggest: vi.fn(() => false)
}))

vi.mock('./toolConfirmRegistry', () => ({
  registerToolCancel: vi.fn(() => ({ aborted: false, addEventListener: vi.fn() })),
  clearToolCancel: vi.fn(),
  // 忠实语义（P1-2 复盘）：组死批量取消时把挂起的桌面确认结算为 'cancelled'
  //（与真实 registry 一致——桌面通道不承载 failApprovalGroup 的 causeHint）
  cancelAllToolConfirmsForRequest: vi.fn(() => {
    for (const resolve of desktopConfirmControl.resolvers) resolve('cancelled')
    desktopConfirmControl.resolvers.length = 0
  }),
  prepareToolConfirm: vi.fn(),
  waitForToolConfirm: vi.fn((_requestId: string, _toolUseId: string) => {
    if (!desktopConfirmControl.pendingMode) return Promise.resolve('approved' as const)
    return new Promise<string>((resolve) => {
      desktopConfirmControl.resolvers.push(resolve)
    })
  })
}))

vi.mock('./tools/builtinExecutors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/builtinExecutors')>()
  return {
    ...actual,
    getRegisteredTool: vi.fn(() => undefined),
    getToolExecutor: vi.fn((name: string) =>
      name === 'write_file'
        ? {
            name,
            execute: async () => ({ success: true, data: 'written' }),
            // 声明资源键：不同路径可并发——兄弟审批节点并存的前提（无资源键的工具是串行屏障）
            resourceKeys: (input: { path?: string }) => [`workspace:${input?.path ?? ''}`]
          }
        : undefined
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
import { writePolicyPackages } from './confirmation/policyRulesRuntime'

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
function installStreamClient(opts: { firstRoundToolUses?: number; bigWrite?: number } = {}) {
  const firstRoundToolUses = opts.firstRoundToolUses ?? 1
  // 超过 autoApproveMaxBytes（256KB）的写入：desktop 恒走确定性自动审批快通道，
  // 超限才会 fallback 进 require-confirm（桌面确认卡链路用例的前置）
  const writeContent = opts.bigWrite ? 'x'.repeat(opts.bigWrite) : 'x'
  streamRound = 0
  capturedStreamParams.length = 0
  mockCreateAnthropicClient.mockReturnValue({
    messages: {
      stream: vi.fn((params: { messages: unknown[] }) => {
        capturedStreamParams.push({ messages: params.messages })
        const round =
          streamRound < CONVERGE_ROUND
            ? {
                content: Array.from({ length: streamRound === 0 ? firstRoundToolUses : 1 }, (_, i) => {
                  // 首轮单工具保持既有 id/path（既有断言锚定 out.txt）；多工具变体加索引区分兄弟节点
                  const idSuffix = streamRound === 0 && firstRoundToolUses === 1 ? `${streamRound}` : `${streamRound}-${i}`
                  return {
                    type: 'tool_use' as const,
                    id: `toolu-e2e-${idSuffix}`,
                    name: 'write_file',
                    input: { path: idSuffix === '0' ? 'out.txt' : `out-${idSuffix}.txt`, content: writeContent }
                  }
                }),
                stop_reason: 'tool_use' as const
              }
            : {
                content: [{ type: 'text', text: '任务完成（含被拒说明）' }],
                stop_reason: 'end_turn' as const
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
    const res = await runAssembledSession(baseArgs(db))
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
    const res = await runAssembledSession(baseArgs(db))
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
    const res = await runAssembledSession(baseArgs(db))
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
    const res = await runAssembledSession({
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
    const res = await runAssembledSession(baseArgs(db))
    expect(res.ok).toBe(true)
    const inv = mockRunApprovalAgent.mock.calls[0]![1] as { clue: { taskDigest?: string } }
    expect(inv.clue.taskDigest).toBeUndefined()
  })
})

// ===== §5.2 方案 A：failApprovalGroup 成因分立 =====
// park/恢复失败属「环境不可用」（unavailable），父任务取消属「外部中断」（cancelled）；
// 兄弟审批节点经通道取消的结算必须跟随真实成因，不得统一翻转成「已取消」。

describe('P2 端到端：failApprovalGroup 成因分立（取消语义对齐，方案 A）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedAuditEvents.length = 0
    chatCancelState.signal = null
    mockRunApprovalAgent.mockImplementation(
      () => new Promise<ApprovalInvocationResult>(() => undefined)
    )
  })

  function collectToolResults() {
    const collected: Array<{ toolUseId: string; notExecutedReason?: string }> = []
    return {
      collected,
      emitSessionEvent: (e: { type: string; payload?: { result?: { notExecutedReason?: string }; toolUseId?: string } }) => {
        if (e?.type === 'tool_result' && e.payload?.result) {
          collected.push({ toolUseId: e.payload.toolUseId ?? '', notExecutedReason: e.payload.result.notExecutedReason })
        }
      }
    }
  }

  it('park/恢复失败路径：failApprovalGroup 以 unavailable 收敛挂起中的兄弟审批节点（notExecutedReason 不翻转为 confirm_cancelled）', async () => {
    installStreamClient({ firstRoundToolUses: 2 })
    const db = makeDb()
    const { collected, emitSessionEvent } = collectToolResults()
    // 回合以失败收敛（:2579 throw 既有语义，回合级失败可接受）；await 完成即证明无挂起。
    // 串行执行（concurrency=1）：A 先入通道挂起（此刻 B 未启动 → canPark=false），B 启动后
    // 判定 canPark=true → park 失败 → failApprovalGroup 取消挂起中的兄弟通道 A。
    await runAssembledSession({
      ...baseArgs(db),
      toolExecutionConcurrency: 1,
      // park 必失败 → sharedApprovalRecoveryFailed → failApprovalGroup('unavailable')
      applicationAdmission: {
        park: () => undefined,
        resume: () => ({ ok: false as const, reason: 'test-stub' })
      },
      emitSessionEvent
    }).catch(() => undefined)
    // 兄弟节点确实挂起在通道中被批量取消（confirm.outcome 来自通道 cancel 结算）：
    // 恢复失败属「环境不可用」——通道 outcome 必须保持 cause=unavailable，
    // 不得因 cancel 统一翻转成 cancelled（notExecutedReason 相应不翻转为 confirm_cancelled）
    const outcomeEv = capturedAuditEvents.find((e) => e.event === 'confirm.outcome')
    expect(outcomeEv).toBeTruthy()
    expect(outcomeEv!.cause).toBe('unavailable')
    // notExecutedReason 同样归因闭环：落库的工具结果全部是 confirm_unavailable，
    // 无一被误标为 confirm_cancelled（触发者走恢复失败分支、兄弟走通道 unavailable 结算）
    expect(collected.length).toBeGreaterThan(0)
    const reasons = collected.map((r) => r.notExecutedReason)
    expect(reasons).not.toContain('confirm_cancelled')
    expect(reasons).toContain('confirm_unavailable')
  })

  it('父任务取消（chatSignal abort）路径：挂起中的审批节点按 cancelled 收敛（审计 cause=cancelled）', async () => {
    installStreamClient()
    const db = makeDb()
    const { emitSessionEvent } = collectToolResults()
    const session = runAssembledSession({
      ...baseArgs(db),
      emitSessionEvent
    })
    // 等审批节点真正挂进通道（invokeApproval 已被调用 = inflight 已注册），再模拟父任务取消
    await vi.waitFor(() => {
      expect(mockRunApprovalAgent.mock.calls.length).toBe(1)
    })
    abortParentTask()
    // 取消后回合以失败收敛（:2579 throw 既有语义）；await 完成即证明无挂起
    await session.catch(() => undefined)
    // 父任务取消属「外部中断」：failApprovalGroup 缺省 cause=cancelled → 通道 outcome cause=cancelled
    const outcomeEv = capturedAuditEvents.find((e) => e.event === 'confirm.outcome')
    expect(outcomeEv).toBeTruthy()
    expect(outcomeEv!.cause).toBe('cancelled')
  })
})

// ===== 审批组死亡时「走完通道」的当前节点结算 =====
// 近死代码清理（confirmOutcomeCause / channelRejectSummary 强制覆盖随即被通道 outcome
// 字段再覆盖）与裸 throw 语义链梳理：组已死（取消 / 租约恢复失败）后，走完通道的当前
// 节点必须先按组死权威成因落库（notExecutedReason 闭环，与守卫分支口径一致），再按链路
// 收敛——桌面取消经 throwIfChatCancelled 以 ChatCancelledError 收敛（落库在前），
// 其余场景经 abortRepeatedToolError 以回合级失败收敛。不得经裸 throw 跳过 per-tool 落库。
// 成因来源：failApprovalGroup 首写入参（组死权威成因），而非 channelOutcome.cause——
// 用户回答者通道（桌面确认卡 / IM）的结算退化为 cancelled，不承载组死成因。

describe('P2 端到端：审批组死亡时走完通道的节点先落库再收敛', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedAuditEvents.length = 0
    chatCancelState.signal = null
    desktopConfirmControl.pendingMode = false
    desktopConfirmControl.resolvers.length = 0
    mockRunApprovalAgent.mockImplementation(
      () => new Promise<ApprovalInvocationResult>(() => undefined)
    )
  })

  function collectToolResults() {
    const collected: Array<{ toolUseId: string; notExecutedReason?: string }> = []
    return {
      collected,
      emitSessionEvent: (e: { type: string; payload?: { result?: { notExecutedReason?: string }; toolUseId?: string } }) => {
        if (e?.type === 'tool_result' && e.payload?.result) {
          collected.push({ toolUseId: e.payload.toolUseId ?? '', notExecutedReason: e.payload.result.notExecutedReason })
        }
      }
    }
  }

  it('恢复失败路径：走完通道的节点同样落库 confirm_unavailable，会话经 abort 路径以 ok:false 收敛', async () => {
    installStreamClient({ firstRoundToolUses: 2 })
    const db = makeDb()
    const { collected, emitSessionEvent } = collectToolResults()
    // 串行执行：A 先入通道挂起，B 启动后 park 失败 → failApprovalGroup('unavailable')。
    // B 走守卫分支落库；A 走完通道后必须同样落库（不再经裸 throw 跳过）。
    const res = await runAssembledSession({
      ...baseArgs(db),
      toolExecutionConcurrency: 1,
      applicationAdmission: {
        park: () => undefined,
        resume: () => ({ ok: false as const, reason: 'test-stub' })
      },
      emitSessionEvent
    })
    // 两个节点的结果全部落库且成因一致（环境不可用），无一缺席、无误标为 cancelled
    expect(collected).toHaveLength(2)
    expect(collected.map((r) => r.notExecutedReason)).toEqual(['confirm_unavailable', 'confirm_unavailable'])
    // 回合经 abortRepeatedToolError 收敛（不再 reject），中止理由携带真实成因
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('运行租约恢复失败')
  })

  it('桌面确认卡 + 兄弟节点恢复失败：组死归因不因通道退化翻转（confirm_unavailable），回合错误不误报取消', async () => {
    installStreamClient({ firstRoundToolUses: 2 })
    desktopConfirmControl.pendingMode = true
    const db = makeDb()
    // custom 档不做 standard 的 ask→auto-evaluator 变换：desktop write_file 保持 ask
    //（answerer=user）→ 真实桌面确认卡链路（否则小文件被确定性自动审批短路）
    writePolicyPackages(db, { desktop: 'custom' })
    const { collected, emitSessionEvent } = collectToolResults()
    // 串行执行：A 先入桌面卡挂起，B 启动后 park 失败 → failApprovalGroup('unavailable')。
    // 存在两个合法变体（A 挂卡与 B 触发的竞争窗口）：
    //  - A 已挂卡：B 组死 → 桌面通道经 registry 结算退化为 cancelled（不承载组死成因），
    //    A 走完通道结算 → 归因必须取组死权威成因 unavailable（P1-2 回归特征：误报 confirm_cancelled）；
    //  - B 抢在 A 挂卡前完成收敛：A 走守卫分支落库（口径同为 unavailable）。
    // 两个变体的共同不变量：落库无 confirm_cancelled、回合错误不误报「已取消」。
    const res = await runAssembledSession({
      ...baseArgs(db),
      lane: 'desktop',
      toolExecutionConcurrency: 1,
      applicationAdmission: {
        park: () => undefined,
        resume: () => ({ ok: false as const, reason: 'test-stub' })
      },
      emitSessionEvent
    })
    expect(collected).toHaveLength(2)
    const reasons = collected.map((r) => r.notExecutedReason)
    expect(reasons).not.toContain('confirm_cancelled')
    expect(reasons).toContain('confirm_unavailable')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).not.toContain('审批已取消')
  })

  it('取消路径（桌面链路，真实取消语义）：走完通道的节点先落库 confirm_cancelled，再以 ChatCancelledError 收敛', async () => {
    installStreamClient()
    const db = makeDb()
    const { collected, emitSessionEvent } = collectToolResults()
    const session = runAssembledSession({ ...baseArgs(db), emitSessionEvent })
    await vi.waitFor(() => {
      expect(mockRunApprovalAgent.mock.calls.length).toBe(1)
    })
    abortParentTask()
    // 桌面链路（无 remoteContext）父任务取消：生产既有语义是外层把 ChatCancelledError
    // 转为 { ok:false, cancelled:true } 收敛（不回归、不 reject）
    const res = await session
    expect(res.ok).toBe(false)
    expect((res as { cancelled?: boolean }).cancelled).toBe(true)
    if (!res.ok) expect(res.error).toContain('会话已取消')
    // 收敛前必须完成 per-tool 落库——落库不得被取消收敛跳过（throwIfChatCancelled 在落库之后）
    expect(collected).toHaveLength(1)
    expect(collected[0]!.notExecutedReason).toBe('confirm_cancelled')
  })
})
