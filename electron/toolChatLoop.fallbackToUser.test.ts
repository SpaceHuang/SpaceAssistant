/**
 * 桌面链路 fail-open-to-user 端到端（§3 目标行为 / §6.3 交付测试）：
 * desktop + 审批 Agent 失败（unavailable / timeout）→ 回退人工确认卡 → 用户批准 / 拒绝。
 * 走真实通道链路（resolveConfirmChannel → AgentChannel / DesktopChannel），
 * 仅 mock 审批执行链（runApprovalAgent）与桌面卡片 waiter（toolConfirmRegistry）。
 * 断言 §5.4 四条事件序列、§5.1 第 1/3 条联动（waiter 补登记 + 回传实际回答者）、
 * §5.10 展示补齐（浮动通知补发 + confirmDiff 补算 + §5.8 autoAnswerer 清除）。
 */
import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import type { AssistantFactEvent } from '../src/shared/assistantFactAggregator'
import type { ContentFacts, Decision, SecurityAuditEvent } from '../src/shared/confirmation/types'
import type { ToolCallGateResult } from './confirmation/toolCallGate'

const capturedAuditEvents: SecurityAuditEvent[] = []
const capturedFactEvents: AssistantFactEvent[] = []
const gateState = vi.hoisted(() => ({ answerer: 'agent' as 'user' | 'agent', timeoutMs: null as number | null, navigate: false }))
const registryState = vi.hoisted(() => ({ prepareCalls: 0 as number }))
const approvalState = vi.hoisted(() => ({ impl: undefined as unknown as (inv: unknown) => Promise<unknown> }))

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn(),
  logAgentError: vi.fn()
}))

vi.mock('./chatCancelRegistry', () => ({
  signalChatCancel: vi.fn(),
  registerChatCancel: vi.fn(() => ({ aborted: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
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
  prepareToolConfirm: vi.fn(() => { registryState.prepareCalls += 1 }),
  waitForToolConfirm: vi.fn(async () => waitOutcome)
}))

vi.mock('./tools/builtinExecutors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/builtinExecutors')>()
  return {
    ...actual,
    getRegisteredTool: vi.fn(() => undefined),
    getToolExecutor: vi.fn((name: string) => {
      if (name === 'write_file') return { name, execute: async () => ({ success: true, data: 'written' }) }
      if (name === 'browser') return { name, execute: async () => ({ success: true, data: 'navigated' }) }
      return undefined
    })
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
  runApprovalAgent: (_deps: never, inv: never) => approvalState.impl(inv) as never,
  APPROVAL_MAX_ROUNDS: 3,
  APPROVAL_READONLY_TOOLS: ['read_file', 'list_directory', 'grep'],
  DEFAULT_APPROVAL_MODEL: 'claude-haiku-4-5-20251001'
}))

const FALLBACK_SESSION = 'sess-fallback-e2e'
const TIER_KEY = { kind: 'path' as const, path: 'out.txt', level: 'file' as const }
const FALLBACK_FACTS: ContentFacts = {
  toolName: 'write_file',
  actionClass: 'write',
  baseRiskLevel: 'medium',
  signals: [{ kind: 'path-target', path: 'out.txt', zone: 'workdir-normal' }],
  summary: { text: 'write_file out.txt' }
}
const NAVIGATE_FACTS: ContentFacts = {
  toolName: 'browser',
  actionClass: 'outbound',
  baseRiskLevel: 'medium',
  signals: [{ kind: 'network-egress', domains: ['example.com'] }],
  summary: { text: 'browser navigate https://example.com' }
}
const NAVIGATE_KEY = {
  kind: 'domain' as const,
  domain: 'example.com',
  level: 'domain-any-action' as const,
  sessionId: FALLBACK_SESSION
}
const FALLBACK_DECISION: Decision = {
  type: 'require-confirm',
  ruleId: 'write-requires-confirm',
  answerer: 'agent',
  riskLevel: 'medium',
  facts: FALLBACK_FACTS,
  memoryTiers: [{ key: TIER_KEY, label: '记住 out.txt（本会话）' }],
  timeoutMs: null
}
const NAVIGATE_DECISION: Decision = {
  type: 'require-confirm',
  ruleId: 'navigate-requires-confirm',
  answerer: 'agent',
  riskLevel: 'medium',
  facts: NAVIGATE_FACTS,
  memoryTiers: [{ key: NAVIGATE_KEY, label: '记住 example.com（本会话）' }],
  timeoutMs: null
}

vi.mock('./confirmation/toolCallGate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./confirmation/toolCallGate')>()
  return {
    ...actual,
    evaluateToolCallGate: vi.fn(async (): Promise<ToolCallGateResult> => (
      gateState.navigate
        ? {
            decision: { ...NAVIGATE_DECISION, answerer: gateState.answerer, timeoutMs: gateState.timeoutMs },
            facts: NAVIGATE_FACTS
          }
        : {
            decision: { ...FALLBACK_DECISION, answerer: gateState.answerer, timeoutMs: gateState.timeoutMs },
            facts: FALLBACK_FACTS
          }
    ))
  }
})

const mockCreateAnthropicClient = vi.fn()

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicClient: (...args: unknown[]) => mockCreateAnthropicClient(...args)
}))

import { runToolChatSession } from './toolChatLoop'
import { assembleInvocation } from './runtime/invocationAssembler'
import { createMemoryAppDb } from './database/testHelpers'
import { SqliteDecisionCache } from './confirmation/sqliteDecisionCache'
import { getDbConnection } from './database'

let waitOutcome: 'approved' | 'rejected' = 'approved'

const tempDirs: string[] = []
function makeWorkDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sa-fallback-'))
  tempDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function makeDb(): AppDatabase {
  return createMemoryAppDb('zh-CN')
}

// 注意：invocationAssembler.wrapNotify 转发后的载荷不含 kind（按 case 分发），以 toolUseId 识别
const notifyCalls: Array<{ toolUseId?: string }> = []
const floatingStub = {
  onConfirmRequest: (event: { toolUseId: string }) => { notifyCalls.push({ toolUseId: event.toolUseId }) },
  onToolResult: vi.fn(),
  onAllCancelledForRequest: vi.fn()
} as never

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
                  gateState.navigate
                    ? { type: 'tool_use', id: 'toolu-fb-1', name: 'browser', input: { action: 'navigate', mode: 'open', url: 'https://example.com' } }
                    : { type: 'tool_use', id: 'toolu-fb-1', name: 'write_file', input: { path: 'out.txt', content: 'fallback content' } }
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

function baseArgs(db: AppDatabase, workDir: string) {
  return {
    requestId: 'req-fallback-e2e',
    sessionId: FALLBACK_SESSION,
    model: 'claude-sonnet-4-20250514',
    baseUrl: 'http://localhost:9999',
    locale: 'zh-CN' as const,
    messages: [{ role: 'user' as const, content: 'please write' }],
    toolsConfig: { ...DEFAULT_TOOLS_CONFIG, deniedTools: [] },
    workDir,
    userDataDir: workDir,
    getApiKey: async () => 'test-key',
    appDb: db,
    emitFactEvent: (event: AssistantFactEvent) => { capturedFactEvents.push(event) },
    emitSessionEvent: () => undefined,
    floatingNotificationManager: floatingStub
  }
}

const reqEvents = () => capturedAuditEvents.filter((e) => e.requestId === 'req-fallback-e2e')

beforeEach(() => {
  vi.clearAllMocks()
  capturedAuditEvents.length = 0
  capturedFactEvents.length = 0
  notifyCalls.length = 0
  registryState.prepareCalls = 0
  gateState.answerer = 'agent'
  gateState.timeoutMs = null
  gateState.navigate = false
  waitOutcome = 'approved'
  approvalState.impl = async () => ({ ok: false, cause: 'unavailable' })
})

describe('桌面审批失败回退人工确认卡（端到端，真实通道链路）', () => {
  it('unavailable → 回退：四条审计事件 + waiter 补登记 + 可交互事件 + 浮动通知补发 + 缓存可写', async () => {
    installStreamClient()
    const db = makeDb()
    const workDir = makeWorkDir()
    const res = await runAssembled(baseArgs(db, workDir))
    expect(res.ok).toBe(true)

    // —— §5.4 四条事件序列（同一 requestId），且回退侧不产生第二条 confirm.request
    const events = reqEvents()
    expect(events.map((e) => e.event)).toEqual([
      'confirm.request',
      'confirm.outcome',
      'confirm.answerer-fallback-to-user',
      'confirm.outcome'
    ])
    expect(events[1]).toMatchObject({ actor: 'agent', cause: 'unavailable' })
    expect(events[2]).toMatchObject({ actor: 'system', cause: 'unavailable', lane: 'desktop', toolName: 'write_file' })
    expect(events[2]!.sessionId).toBe(FALLBACK_SESSION)
    expect(events[3]).toMatchObject({ actor: 'user', cause: 'user-approved' })

    // —— §5.1 第 1 条：回退 waiter 先于卡片补登记（agent 阶段不登记，回退分支补登记恰一次）
    expect(registryState.prepareCalls).toBe(1)

    // —— §5.8 / §5.10：第二条 confirm-requested 清除 autoAnswerer、补 confirmDiff 与原因
    const confirmRequested = capturedFactEvents.filter((e) => e.type === 'confirm-requested')
    expect(confirmRequested).toHaveLength(2)
    const fallbackEvent = confirmRequested[1] as Extract<AssistantFactEvent, { type: 'confirm-requested' }>
    expect(fallbackEvent.autoAnswerer).toBe(false)
    expect(fallbackEvent.confirmDiff).toMatchObject({ oldPath: 'out.txt', newContent: 'fallback content' })
    expect(fallbackEvent.autoApproveFallback).toMatchObject({ reasonCode: 'approval_unavailable' })
    expect(fallbackEvent.autoApproveFallback?.reason).toBeTruthy()
    expect(fallbackEvent.autoApproveFallback?.reason).not.toContain('notification.')
    // 脱敏：不暴露模型名 / 配额内部细节（§5.3）
    expect(fallbackEvent.autoApproveFallback?.reason).not.toContain('claude')

    // —— §5.10a：agent 阶段无浮动通知，回退分支补发恰一次
    expect(notifyCalls).toHaveLength(1)
    expect(notifyCalls[0]!.toolUseId).toBe('toolu-fb-1')

    // —— 用户批准后工具实际执行，回合收敛
    expect(res.ok && res.content !== undefined).toBe(true)
  })

  it('timeout → 回退：原 cause=timeout 可查，用户批准后照常执行', async () => {
    approvalState.impl = () => new Promise<never>(() => undefined)
    installStreamClient()
    const db = makeDb()
    const workDir = makeWorkDir()
    const res = await runAssembled({ ...baseArgs(db, workDir), deadlineAt: Date.now() + 250 })
    expect(res.ok).toBe(true)

    const events = reqEvents()
    expect(events.map((e) => e.event)).toEqual([
      'confirm.request',
      'confirm.outcome',
      'confirm.answerer-fallback-to-user',
      'confirm.outcome'
    ])
    expect(events[1]).toMatchObject({ actor: 'agent', cause: 'timeout' })
    expect(events[2]).toMatchObject({ actor: 'system', cause: 'timeout' })
    expect(events[3]).toMatchObject({ actor: 'user', cause: 'user-approved' })
    const confirmRequested = capturedFactEvents.filter((e) => e.type === 'confirm-requested')
    const fallbackEvent = confirmRequested[1] as Extract<AssistantFactEvent, { type: 'confirm-requested' }>
    expect(fallbackEvent.autoApproveFallback).toMatchObject({ reasonCode: 'approval_timeout' })
    expect(notifyCalls).toHaveLength(1)
  })

  it('回退后用户拒绝 → 不执行、不写缓存、outcome 归因 user-denied', async () => {
    waitOutcome = 'rejected'
    installStreamClient()
    const db = makeDb()
    const workDir = makeWorkDir()
    await runAssembled(baseArgs(db, workDir))

    const events = reqEvents()
    expect(events[3]).toMatchObject({ actor: 'user', cause: 'user-denied' })
    expect(new SqliteDecisionCache(getDbConnection(db)).lookup(TIER_KEY)).toBeNull()
    expect(capturedAuditEvents.filter((e) => e.event === 'cache.write')).toHaveLength(0)
  })

  it('回退后人工批准可写 decision_cache（循环内 navigate 双写路径；agent 裁决仍不写）', async () => {
    // navigate 的会话信任双写发生在循环内：写入资格直接消费 confirmAnswererKind——
    // 若 §5.1 第 3 条的派生未回传 user，此用例必然失败（与 memoryGuard 的 agent 锚点互补）
    const domainKey = { kind: 'domain' as const, domain: 'example.com', level: 'domain-any-action' as const, sessionId: FALLBACK_SESSION }
    gateState.navigate = true
    waitOutcome = 'approved'
    installStreamClient()
    const db = makeDb()
    const workDir = makeWorkDir()
    const res = await runAssembled({
      ...baseArgs(db, workDir),
      browserConfig: { enabled: true, env: 'LOCAL' } as never
    })
    expect(res.ok).toBe(true)
    const events = reqEvents()
    expect(events[3]).toMatchObject({ actor: 'user', cause: 'user-approved' })
    expect(new SqliteDecisionCache(getDbConnection(db)).lookup(domainKey)).not.toBeNull()
    expect(capturedAuditEvents.filter((e) => e.event === 'cache.write')).toHaveLength(1)
  })

  it('失败原因短文案来自 i18n 真源（zh-CN / en-US 双份，§5.3）', async () => {
    const { approvalFallbackReasonFor } = await import('./confirmation/fallbackReason')
    expect(approvalFallbackReasonFor('unavailable', 'zh-CN')).toBe('服务暂不可用')
    expect(approvalFallbackReasonFor('timeout', 'zh-CN')).toBe('等待超时')
    expect(approvalFallbackReasonFor('unavailable', 'en-US')).toBe('Service unavailable')
    expect(approvalFallbackReasonFor('timeout', 'en-US')).toBe('Timed out')
  })
})

/** P1：直调 Core 的测试适配——材料经装配器构造 Invocation + ports。 */
function runAssembled(materials: unknown) {
  const { invocation, ports } = assembleInvocation(materials as never)
  return runToolChatSession(invocation, ports)
}
