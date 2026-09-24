/**
 * 桌面 fail-open-to-user：循环层判定矩阵 / 守卫用例（§6.3）。
 * channels 模块整体 mock：第一跳为主回答者通道（agent 或 user 形态 outcome），
 * 第二跳仅在回退发生时被调用——用调用次数与捕获入参锚定四维判定的循环侧行为：
 *  - agent-deny / unparsable / config-error / recursion-blocked 不回退（§4 矩阵）；
 *  - 普通 ask 卡 timeout（DesktopChannel 形态，无 answererKind）不回退（评审 v3 B1）；
 *  - 中止守卫：chat aborted 不回退、不登记孤儿 waiter（评审 v3 B2）；
 *  - automation / wechat / feishu（IM lane 锚点）不装配回退；
 *  - 回退请求 timeoutMs 不继承 gate.decision.timeoutMs（§5.6）；
 *  - 回退等待期 failApprovalGroup 取消遍历覆盖回退通道（§5.1 第 4 条）。
 */
import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import type { AssistantFactEvent } from '../src/shared/assistantFactAggregator'
import type { ConfirmOutcome, ContentFacts, Decision, SecurityAuditEvent } from '../src/shared/confirmation/types'
import type { ToolCallGateResult } from './confirmation/toolCallGate'

const capturedAuditEvents: SecurityAuditEvent[] = []
const capturedFactEvents: AssistantFactEvent[] = []
const toolResultEvents: Array<{ type: string; payload: { result: { notExecutedReason?: string } } }> = []
const gateState = vi.hoisted(() => ({ answerer: 'agent' as 'user' | 'agent', timeoutMs: null as number | null }))
const cancelState = vi.hoisted(() => ({ aborted: false, abortListeners: [] as Array<() => void> }))
const mockChannelFor = vi.hoisted(() => vi.fn())

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn(),
  logAgentError: vi.fn()
}))

vi.mock('./chatCancelRegistry', () => ({
  signalChatCancel: vi.fn(),
  registerChatCancel: vi.fn(() => ({
    get aborted() { return cancelState.aborted },
    addEventListener: (_event: string, listener: () => void) => { cancelState.abortListeners.push(listener) },
    removeEventListener: vi.fn()
  })),
  clearChatCancel: vi.fn(),
  throwIfChatCancelled: vi.fn(),
  ChatCancelledError: class ChatCancelledError extends Error {},
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

vi.mock('./confirmation/channels', () => ({
  channelFor: mockChannelFor
}))

const GUARD_SESSION = 'sess-fallback-guard'
const GUARD_FACTS: ContentFacts = {
  toolName: 'write_file',
  actionClass: 'write',
  baseRiskLevel: 'medium',
  signals: [{ kind: 'path-target', path: 'out.txt', zone: 'workdir-normal' }],
  summary: { text: 'write_file out.txt' }
}
const GUARD_DECISION: Decision = {
  type: 'require-confirm',
  ruleId: 'write-requires-confirm',
  answerer: 'agent',
  riskLevel: 'medium',
  facts: GUARD_FACTS,
  memoryTiers: [{ key: { kind: 'path', path: 'out.txt', level: 'file' }, label: '记住 out.txt（本会话）' }],
  timeoutMs: null
}

vi.mock('./confirmation/toolCallGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./confirmation/toolCallGate')>()
  return {
    ...actual,
    evaluateToolCallGate: vi.fn(async (): Promise<ToolCallGateResult> => ({
      decision: { ...GUARD_DECISION, answerer: gateState.answerer, timeoutMs: gateState.timeoutMs },
      facts: GUARD_FACTS
    }))
  }
})

const mockCreateAnthropicClient = vi.fn()

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicClient: (...args: unknown[]) => mockCreateAnthropicClient(...args)
}))

import { runToolChatSession } from './toolChatLoop'
import { assembleInvocation } from './runtime/invocationAssembler'
import { createMemoryAppDb } from './database/testHelpers'

function makeDb(): AppDatabase {
  return createMemoryAppDb('zh-CN')
}

const tempDirs: string[] = []
function makeWorkDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sa-fallback-guard-'))
  tempDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

// 注意：invocationAssembler.wrapNotify 转发后的载荷不含 kind（按 case 分发），以调用计数锚定
const notifyCalls: Array<{ toolUseId?: string }> = []
const floatingStub = {
  onConfirmRequest: (event: { toolUseId: string }) => { notifyCalls.push({ toolUseId: event.toolUseId }) },
  onToolResult: vi.fn(),
  onAllCancelledForRequest: vi.fn()
} as never

type CapturedChannel = {
  args: Record<string, unknown>
  requests: Array<Record<string, unknown>>
  cancel: ReturnType<typeof vi.fn>
}

/** 请求 hook：返回非 undefined 时以其结果结算该次 request（用于挂起 / 注入时序）。 */
type RequestHook = (entry: CapturedChannel, req: Record<string, unknown>) => Promise<ConfirmOutcome> | ConfirmOutcome

/**
 * 配置通道序列：第一跳（主回答者通道）按 firstOutcomes 结算；
 * 第二跳（回退通道，answerer 固定 user）按 secondOutcomes 结算。
 * hooks.first / hooks.second 可拦截对应跳的 request（挂起 / 注入时序）。
 * cancel() 会以 rejected/cancelled 结算该通道挂起的 request（对齐真实通道取消语义）。
 */
function installChannelSequence(
  firstOutcomes: ConfirmOutcome[],
  secondOutcomes: ConfirmOutcome[] = [],
  hooks: { first?: RequestHook; second?: RequestHook } = {}
): CapturedChannel[] {
  const channels: CapturedChannel[] = []
  mockChannelFor.mockImplementation((args: Record<string, unknown>) => {
    const entry: CapturedChannel = { args, requests: [], cancel: vi.fn() }
    channels.push(entry)
    const isPrimary = channels.length === 1
    const hook = isPrimary ? hooks.first : hooks.second
    const outcomes = isPrimary ? firstOutcomes : secondOutcomes
    let settlePending: ((outcome: ConfirmOutcome) => void) | undefined
    const channel = {
      cancel: (...a: unknown[]) => {
        entry.cancel(...(a as []))
        settlePending?.({ kind: 'rejected', cause: 'cancelled' })
        settlePending = undefined
      },
      request: async (req: Record<string, unknown>): Promise<ConfirmOutcome> => {
        entry.requests.push(req)
        // cancel 结算通道：cancel() 以 rejected/cancelled 结算挂起中的 request（对齐真实通道语义）
        const cancelledViaCancel = new Promise<ConfirmOutcome>((resolve) => { settlePending = resolve })
        if (hook) return Promise.race([Promise.resolve(hook(entry, req)), cancelledViaCancel])
        const outcome = outcomes[Math.min(entry.requests.length - 1, outcomes.length - 1)]!
        return Promise.race([Promise.resolve(outcome), cancelledViaCancel])
      }
    }
    return channel
  })
  return channels
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
                  { type: 'tool_use', id: 'toolu-fg-1', name: 'write_file', input: { path: 'out.txt', content: 'x' } }
                ],
                stop_reason: 'tool_use'
              }
            : { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }
        streamRound += 1
        return {
          async *[Symbol.asyncIterator]() {},
          finalMessage: vi.fn(async () => round)
        }
      })
    }
  })
}

function baseArgs(db: AppDatabase, workDir: string, lane?: 'automation' | 'wechat' | 'feishu') {
  return {
    requestId: 'req-fallback-guard',
    sessionId: GUARD_SESSION,
    model: 'claude-sonnet-4-20250514',
    baseUrl: 'http://localhost:9999',
    locale: 'zh-CN' as const,
    ...(lane ? { lane } : {}),
    messages: [{ role: 'user' as const, content: 'please write' }],
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, deniedTools: [] },
    workDir,
    userDataDir: workDir,
    getApiKey: async () => 'test-key',
    appDb: db,
    emitFactEvent: (event: AssistantFactEvent) => { capturedFactEvents.push(event) },
    emitSessionEvent: (event: { type: string; payload?: unknown }) => {
      toolResultEvents.push(event as { type: string; payload: { result: { notExecutedReason?: string } } })
    },
    floatingNotificationManager: floatingStub
  }
}

function agentFailure(cause: ConfirmOutcome['cause']): ConfirmOutcome {
  return { kind: 'rejected', answererKind: 'agent', cause }
}

beforeEach(() => {
  vi.clearAllMocks()
  capturedAuditEvents.length = 0
  capturedFactEvents.length = 0
  toolResultEvents.length = 0
  notifyCalls.length = 0
  cancelState.aborted = false
  cancelState.abortListeners.length = 0
  gateState.answerer = 'agent'
  gateState.timeoutMs = null
  installStreamClient()
})

function runAssembled(materials: unknown) {
  const { invocation, ports } = assembleInvocation(materials as never)
  return runToolChatSession(invocation, ports)
}

describe('§4 矩阵负向：不可回退格在循环层不触发第二跳', () => {
  it.each<[ConfirmOutcome['cause']]>([
    ['agent-deny'],
    ['unparsable'],
    ['config-error'],
    ['recursion-blocked']
  ])('cause=%s → 只调一次 channelFor，无回退事件 / 无第二张卡 / 无浮动通知', async (cause) => {
    installChannelSequence([agentFailure(cause)])
    const res = await runAssembled(baseArgs(makeDb(), makeWorkDir()))
    expect(res.ok).toBe(true)
    expect(mockChannelFor).toHaveBeenCalledTimes(1)
    expect(capturedAuditEvents.filter((e) => e.event === 'confirm.answerer-fallback-to-user')).toHaveLength(0)
    const confirmRequested = capturedFactEvents.filter((e) => e.type === 'confirm-requested')
    expect(confirmRequested).toHaveLength(1)
    expect((confirmRequested[0] as Extract<AssistantFactEvent, { type: 'confirm-requested' }>).autoAnswerer).toBe(true)
    expect(notifyCalls).toHaveLength(0)
  })
})

describe('四维判定第②维（评审 v3 B1）：普通 ask 卡超时不回退', () => {
  it('gate answerer=user + DesktopChannel 形态 outcome（无 answererKind）→ 不弹第二张卡，confirm_timeout 收敛', async () => {
    gateState.answerer = 'user'
    installChannelSequence([{ kind: 'timeout', cause: 'timeout' }])
    await runAssembled(baseArgs(makeDb(), makeWorkDir()))
    expect(mockChannelFor).toHaveBeenCalledTimes(1)
    expect(capturedAuditEvents.filter((e) => e.event === 'confirm.answerer-fallback-to-user')).toHaveLength(0)
    const confirmRequested = capturedFactEvents.filter((e) => e.type === 'confirm-requested')
    expect(confirmRequested).toHaveLength(1)
    // 既有超时归类：confirm_timeout（总等待仍为一次卡片上界，不出现第二张卡）
    const results = toolResultEvents.filter((e) => e.type === 'tool_result').map((e) => e.payload.result.notExecutedReason)
    expect(results).toContain('confirm_timeout')
    // 普通 ask 基线浮动通知仍在（initial 发一次），不因回退逻辑多发
    expect(notifyCalls).toHaveLength(1)
  })

  it('DesktopChannel 形态 rejected/unavailable（无 answererKind）→ 不回退', async () => {
    gateState.answerer = 'user'
    installChannelSequence([{ kind: 'rejected', cause: 'unavailable' }])
    await runAssembled(baseArgs(makeDb(), makeWorkDir()))
    expect(mockChannelFor).toHaveBeenCalledTimes(1)
    expect(capturedAuditEvents.filter((e) => e.event === 'confirm.answerer-fallback-to-user')).toHaveLength(0)
  })
})

describe('四维判定第④维（评审 v3 B2）：中止守卫', () => {
  it('主通道等待期间 chat aborted（取消 settle 为 unavailable）→ 不回退、不弹卡', async () => {
    installChannelSequence([agentFailure('unavailable')], [], {
      // 第一跳请求内置位 aborted 再返回 unavailable（AgentChannel.cancel 的 settle 形态）
      first: (_entry, _req) => {
        cancelState.aborted = true
        return Promise.resolve(agentFailure('unavailable'))
      }
    })
    await runAssembled(baseArgs(makeDb(), makeWorkDir()))
    expect(mockChannelFor).toHaveBeenCalledTimes(1)
    expect(capturedAuditEvents.filter((e) => e.event === 'confirm.answerer-fallback-to-user')).toHaveLength(0)
    expect(notifyCalls).toHaveLength(0)
  })

  it('审批前已取消（既有取消路径回归锚点）→ confirm_cancelled 归类不变、不进入通道', async () => {
    cancelState.aborted = true
    installChannelSequence([agentFailure('unavailable')])
    await runAssembled(baseArgs(makeDb(), makeWorkDir()))
    expect(mockChannelFor).toHaveBeenCalledTimes(0)
    const results = toolResultEvents.filter((e) => e.type === 'tool_result').map((e) => e.payload.result.notExecutedReason)
    expect(results).toContain('confirm_cancelled')
  })
})

describe('硬回归：回退仅装配在桌面链路（IM lane 锚点）', () => {
  it.each<['automation' | 'wechat' | 'feishu']>([['automation'], ['wechat'], ['feishu']])(
    'lane=%s 即使构造出 agent 回答者失败也不装配回退',
    async (lane) => {
      installChannelSequence([agentFailure('unavailable')])
      const res = await runAssembled(baseArgs(makeDb(), makeWorkDir(), lane))
      expect(res.ok).toBe(true)
      expect(mockChannelFor).toHaveBeenCalledTimes(1)
      expect(capturedAuditEvents.filter((e) => e.event === 'confirm.answerer-fallback-to-user')).toHaveLength(0)
      expect(capturedFactEvents.filter((e) => e.type === 'confirm-requested')).toHaveLength(1)
    }
  )
})

describe('回退分支的联动动作（§5.1 / §5.6 / §5.10）', () => {
  it('第二跳以 answerer=user + suppressRequestAudit 解析；回退请求 timeoutMs 置 null；补 waiter、补浮动通知、落回退事件', async () => {
    gateState.timeoutMs = 30_000
    const channels = installChannelSequence([agentFailure('unavailable')], [{ kind: 'approved', cause: 'user-approved' }])
    await runAssembled(baseArgs(makeDb(), makeWorkDir()))

    expect(mockChannelFor).toHaveBeenCalledTimes(2)
    const [first, second] = channels
    // 主跳沿用 gate 决策（agent 上界可透传给 AgentChannel）
    expect(first!.args.answererPolicy).toEqual({ kind: 'agent' })
    expect(first!.requests[0]!.timeoutMs).toBe(30_000)
    // 回退跳：回答者固定 user、降噪审计、同 requestId、lane=desktop
    expect(second!.args.answererPolicy).toEqual({ kind: 'user' })
    expect(second!.args.suppressRequestAudit).toBe(true)
    expect(second!.args.requestId).toBe(first!.args.requestId)
    expect(second!.args.lane).toBe('desktop')
    // §5.6：回退请求不继承 gate.decision.timeoutMs
    expect(second!.requests[0]!.timeoutMs).toBeNull()
    // 回退事件已落（审计四条事件中的第 3 条；通道被 mock，其余三条由通道层单测锚定）
    const fallbackEvents = capturedAuditEvents.filter((e) => e.event === 'confirm.answerer-fallback-to-user')
    expect(fallbackEvents).toHaveLength(1)
    expect(fallbackEvents[0]).toMatchObject({ actor: 'system', cause: 'unavailable', lane: 'desktop' })
    // 第二张可交互卡事件 + 浮动通知补发
    expect(capturedFactEvents.filter((e) => e.type === 'confirm-requested')).toHaveLength(2)
    expect(notifyCalls).toHaveLength(1)
  })

  it('回退等待期 failApprovalGroup：取消遍历覆盖回退通道（评审 v2 B2 非阻断 1）', async () => {
    // 第二跳挂起模拟回退卡等待；failApprovalGroup 遍历 activeApprovalChannels 调 cancel → 挂起请求以 cancelled 结算
    const channels = installChannelSequence(
      [agentFailure('unavailable')],
      [{ kind: 'rejected', cause: 'cancelled' }],
      { second: () => new Promise<ConfirmOutcome>(() => undefined) }
    )
    const runPromise = runAssembled(baseArgs(makeDb(), makeWorkDir()))
    // 等待进入回退等待（第二跳已发起）
    await vi.waitFor(() => expect(channels.length).toBeGreaterThanOrEqual(2))
    // 触发 chatSignal abort listener → failApprovalGroup → 遍历取消（含回退通道）
    for (const listener of cancelState.abortListeners) listener()
    await vi.waitFor(() => expect(channels[1]!.cancel).toHaveBeenCalled())
    // failApprovalGroup 置位后既有语义为回合错误收敛（'审批已完成，但运行租约恢复失败'）——本用例锚点仅关注取消遍历覆盖
    await runPromise.catch(() => undefined)
  })
})
