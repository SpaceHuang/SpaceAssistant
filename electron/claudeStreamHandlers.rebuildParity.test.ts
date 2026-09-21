import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TOOLS_CONFIG, type Message } from '../src/shared/domainTypes'
import { setKnownHomeDir } from '../src/shared/agentSafeText'
import { serializeProviderMessages } from './claudeToolLoopStreamParams'

/**
 * Phase 0 静态比对（agent-context-token-cost-optimization-plan §3.4.5 / §7.3 断言 1）：
 *
 * turn 首请求（round:1）的 messages 来自 buildToolChatMessagesFromSource 的 DB 重建，
 * turn 内后续请求是 runToolChatSession 内实时累积的 messagesForApi。两条路径对同一段
 * 历史的产出若在任何 item 上不同，wire 前缀即从该点分歧——这正是 turn 边界缓存失效
 * （round:1 未命中占全部未命中 54.2%）的唯一候选成因（候选 A）。
 *
 * 本测试「测试内前向驱动完整一轮」并即时捕获 runToolChatSession 返回的 finalSurfaceMessages
 * （messagesForApi 是局部变量，历史时刻的值不可事后复现——§3.4.5 输入前提更正），
 * 再与次轮 round:1 经真实重建链路的产出逐 item 比对，分两层口径：
 * - wire 面（serializeProviderMessages：只有 role/content 进网络）→ 直接决定缓存前缀；
 * - surface 面（含 id 等元数据）→ 差异若仅限不进 wire 的字段，不影响缓存。
 */

const mockGetCachedMemoryContent = vi.fn(() => null)
const mockCreateAnthropicClient = vi.fn()
const mockConfirmOutcome = vi.fn(async () => 'approved' as const)
let streamRound = 0
const capturedFacts: Array<Record<string, unknown>> = []

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'zh-CN') }
}))

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

vi.mock('./browser/stagehandService', () => ({
  stagehandService: { resetInferenceCount: vi.fn() }
}))

vi.mock('./toolConfirmRegistry', () => ({
  registerToolCancel: vi.fn(() => new AbortController().signal),
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

// read_file 用真实执行器（读真实临时文件），其余工具一律不可用
vi.mock('./tools/builtinExecutors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/builtinExecutors')>()
  return {
    ...actual,
    getToolExecutor: vi.fn((name: string) => {
      if (name === 'read_file') return actual.readFileExecutor
      return undefined
    })
  }
})

vi.mock('./tools/writeFileAutoApproval', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tools/writeFileAutoApproval')>()),
  evaluateFileToolAutoApproval: vi.fn(async () => ({ approve: true as const }))
}))

vi.mock('./safeWebContentsSend', () => ({
  isWebContentsAlive: vi.fn(() => true),
  safeWebContentsSend: vi.fn()
}))

import { runToolChatSession, clearSessionToolResources } from './toolChatLoop'
import { assembleInvocation } from './runtime/invocationAssembler'
import { createMemoryAppDb } from './database/testHelpers'
import { buildToolChatMessagesFromSource } from './chatMessageBuild'
import { normalizeAndValidateClaudeMessagesWithContentBlocks } from './claudeStreamHandlers'

type StreamRound = { content: unknown[]; stop_reason: string; usage?: Record<string, number> }

function makeStreamRounds(rounds: StreamRound[]) {
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

function factOf(id: string): { result?: Record<string, unknown> } | undefined {
  return capturedFacts.find((f) => f.type === 'tool-result' && (f as { id?: string }).id === id) as never
}

function makeUserMessage(sessionId: string, id: string, content: string, timestamp: number): Message {
  return { id, sessionId, role: 'user', content, timestamp, status: 'completed', schemaVersion: 1 }
}

function makeAssistantMessage(sessionId: string, id: string, content: string, timestamp: number, toolCalls?: Message['toolCalls']): Message {
  return {
    id,
    sessionId,
    role: 'assistant',
    content,
    timestamp,
    status: 'completed',
    schemaVersion: 1,
    ...(toolCalls?.length ? { toolCalls } : {})
  }
}

function makeToolCallRecord(id: string, input: Record<string, unknown>, result: Record<string, unknown> | undefined): NonNullable<Message['toolCalls']>[number] {
  return {
    id,
    toolName: 'read_file',
    input,
    ...(result ? { result: result as never } : {}),
    status: 'completed',
    riskLevel: 'low'
  }
}

/** 复现 runToolChatSession 的 skillFragments 注入规则（第一条 user 之前）：
 *  round:1 的重建产物在进入 runToolChatSession 前不含注入，真实发送序列含。 */
function withSkillFragmentInjection(messages: unknown[], skillFragments?: string[]): unknown[] {
  if (!skillFragments?.length) return messages
  const out = [...messages]
  const firstUserIndex = out.map((message) => (message as { role?: string }).role).indexOf('user')
  out.splice(firstUserIndex >= 0 ? firstUserIndex : out.length, 0, { role: 'user', content: skillFragments.join('\n\n') })
  return out
}

/** turn 2 round:1 的实际发送序列（注入 fragment 后）去掉本轮新用户消息，即「历史前缀」的重建侧口径。 */
function rebuiltHistoryOf(round1Messages: unknown[], skillFragments?: string[]): unknown[] {
  const injected = withSkillFragmentInjection(round1Messages, skillFragments)
  return injected.slice(0, injected.length - 1)
}

/** wire 面（进网络的部分）逐 item JSON 比对，返回首个分歧点。 */
function firstWireDivergence(a: unknown[], b: unknown[]): { index: number; a?: unknown; b?: unknown } | null {
  return firstDivergence(serializeProviderMessages(a), serializeProviderMessages(b))
}

function describeDiv(div: { index: number; a?: unknown; b?: unknown } | null): string {
  return div === null
    ? '无分歧'
    : `首个分歧 item #${div.index}\n  实时累积侧: ${JSON.stringify(div.a)}\n  DB 重建侧:   ${JSON.stringify(div.b)}`
}

/** surface 面（剥离 id/timestamp 等不进 wire 的元数据后）逐 item JSON 比对，返回首个分歧点。 */
function firstDivergence(a: unknown[], b: unknown[]): { index: number; a?: unknown; b?: unknown } | null {
  const strip = (item: unknown) => {
    if (!item || typeof item !== 'object') return item
    const { id: _id, timestamp: _ts, ...rest } = item as Record<string, unknown>
    return rest
  }
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(strip(a[i])) !== JSON.stringify(strip(b[i]))) return { index: i, a: a[i], b: b[i] }
  }
  if (a.length !== b.length) return { index: n, a: a[n], b: b[n] }
  return null
}

describe('Phase 0 静态比对：turn 边界重建 vs 实时累积（§3.4.5）', () => {
  let tmpDir: string
  let sessionId: string

  beforeEach(async () => {
    vi.clearAllMocks()
    streamRound = 0
    capturedFacts.length = 0
    mockGetCachedMemoryContent.mockReturnValue(null)
    mockConfirmOutcome.mockResolvedValue('approved')
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-rebuild-parity-')))
    sessionId = `sess-rebuild-parity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setKnownHomeDir('C:\\Users\\alice')
  })

  afterEach(async () => {
    setKnownHomeDir(undefined)
    clearSessionToolResources(sessionId)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  /**
   * 前向驱动一个 turn：round:1 走真实重建链路（buildToolChatMessagesFromSource →
   * normalizeAndValidateClaudeMessagesWithContentBlocks），再交给 runToolChatSession。
   * 返回 res.finalSurfaceMessages（turn 末实时累积的 messagesForApi）与 round:1 的
   * 重建产物（供次轮比对）。
   */
  async function driveTurn(args: {
    history: Message[]
    userMessage: Message
    rounds: StreamRound[]
    skillFragments?: string[]
  }) {
    const sourceMessages = [...args.history, args.userMessage]
    const built = await buildToolChatMessagesFromSource({
      userDataDir: tmpDir,
      workDir: tmpDir,
      sourceMessages,
      currentUserMessageId: args.userMessage.id,
      sessionId
    })
    const round1Messages = normalizeAndValidateClaudeMessagesWithContentBlocks(built, {
      sessionId,
      requiredUserMessageId: args.userMessage.id
    })
    capturedFacts.length = 0
    streamRound = 0
    mockCreateAnthropicClient.mockReturnValue(makeStreamRounds(args.rounds))
    const materials = {
      requestId: `req-${args.userMessage.id}`,
      sessionId,
      model: 'claude-sonnet-4-20250514',
      messages: round1Messages,
      toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: tmpDir,
      userDataDir: tmpDir,
      getApiKey: async () => 'test-key',
      appDb: createMemoryAppDb('zh-CN'),
      ...(args.skillFragments?.length ? { skillFragments: args.skillFragments } : {}),
      emitFactEvent: (event: Record<string, unknown>) => {
        capturedFacts.push(event)
      },
      emitSessionEvent: async () => {}
    }
    const { invocation, ports } = assembleInvocation(materials as never)
    const res = (await runToolChatSession(invocation as never, ports as never)) as {
      ok: boolean
      error?: string
      finalSurfaceMessages?: unknown[]
    }
    expect(res.ok, `turn ${args.userMessage.id} 未收敛: ${res.error ?? ''}`).toBe(true)
    return { res, round1Messages }
  }

  function expectSurfaceParity(a: unknown[], b: unknown[], label: string) {
    const surfaceDiv = firstDivergence(a, b)
    const wireDiv = firstWireDivergence(a, b)
    const describeDiv = (div: { index: number; a?: unknown; b?: unknown } | null) =>
      div === null
        ? '无分歧'
        : `首个分歧 item #${div.index}\n  实时累积侧: ${JSON.stringify(div.a)}\n  DB 重建侧:   ${JSON.stringify(div.b)}`
    return {
      surfaceDiv,
      wireDiv,
      assert() {
        expect(wireDiv, `[${label}] wire 面（缓存前缀口径）出现分歧：${describeDiv(wireDiv)}`).toBeNull()
        expect(surfaceDiv, `[${label}] surface 面（含元数据口径）出现分歧：${describeDiv(surfaceDiv)}`).toBeNull()
      }
    }
  }

  it('wire 面：turn 2 round:1 重建产物与 turn 1 finalSurfaceMessages 逐字节一致（无 skillFragments）', async () => {
    await fs.writeFile(path.join(tmpDir, 'doc.md'), 'hello rebuild parity', 'utf8')
    const u1 = makeUserMessage(sessionId, 'u1', 'read the doc and summarize', 1_000)

    const turn1 = await driveTurn({
      history: [],
      userMessage: u1,
      rounds: [
        { content: [{ type: 'tool_use', id: 'tu-read', name: 'read_file', input: { path: 'doc.md' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
        { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }
      ]
    })
    const finalSurface = turn1.res.finalSurfaceMessages
    expect(finalSurface, 'runToolChatSession 应返回 finalSurfaceMessages').toBeTruthy()

    // turn 1 结束后 DB 中固化的历史（assistant 正文与 toolCalls 事实由渲染层持久化，此处按事实事件回填）
    const a1 = makeAssistantMessage(sessionId, 'a1', '', 1_100, [
      makeToolCallRecord('tu-read', { path: 'doc.md' }, factOf('tu-read')?.result)
    ])
    const a2 = makeAssistantMessage(sessionId, 'a2', 'done', 1_200)
    const u2 = makeUserMessage(sessionId, 'u2', 'now summarize again', 2_000)

    const turn2 = await driveTurn({
      history: [u1, a1, a2],
      userMessage: u2,
      rounds: [{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 30, output_tokens: 5 } }]
    })
    // turn 2 round:1 的 messages 去掉本轮新用户消息后，应与 turn 1 末的实时累积逐字节一致
    const rebuiltHistory = rebuiltHistoryOf(turn2.round1Messages as unknown[])
    expectSurfaceParity(finalSurface as unknown[], rebuiltHistory, '基础场景').assert()
  })

  it('wire 面：skillFragments 下 turn 边界前缀仍构成严格前缀扩展（§5.3.3 append-notice）', async () => {
    await fs.writeFile(path.join(tmpDir, 'doc.md'), 'hello skill parity', 'utf8')
    const u1 = makeUserMessage(sessionId, 'u1', 'read the doc', 1_000)
    const fragments = ['<skill id="parity-test">Skill fragment v1</skill>']

    const turn1 = await driveTurn({
      history: [],
      userMessage: u1,
      rounds: [
        { content: [{ type: 'tool_use', id: 'tu-read', name: 'read_file', input: { path: 'doc.md' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
        { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }
      ],
      skillFragments: fragments
    })
    const finalSurface = turn1.res.finalSurfaceMessages
    expect(finalSurface).toBeTruthy()

    const a1 = makeAssistantMessage(sessionId, 'a1', '', 1_100, [
      makeToolCallRecord('tu-read', { path: 'doc.md' }, factOf('tu-read')?.result)
    ])
    const a2 = makeAssistantMessage(sessionId, 'a2', 'done', 1_200)
    const u2 = makeUserMessage(sessionId, 'u2', 'next task', 2_000)

    const turn2 = await driveTurn({
      history: [u1, a1, a2],
      userMessage: u2,
      rounds: [{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 30, output_tokens: 5 } }],
      skillFragments: fragments
    })
    const rebuiltHistory = rebuiltHistoryOf(turn2.round1Messages as unknown[], fragments)
    expectSurfaceParity(finalSurface as unknown[], rebuiltHistory, 'skillFragments 场景').assert()
  })

  it('wire 面：一轮多工具（多 tool_use / tool_result 聚合）后重建一致', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.md'), 'alpha content', 'utf8')
    await fs.writeFile(path.join(tmpDir, 'b.md'), 'beta content', 'utf8')
    const u1 = makeUserMessage(sessionId, 'u1', 'read both docs', 1_000)

    const turn1 = await driveTurn({
      history: [],
      userMessage: u1,
      rounds: [
        {
          content: [
            { type: 'tool_use', id: 'tu-a', name: 'read_file', input: { path: 'a.md' } },
            { type: 'tool_use', id: 'tu-b', name: 'read_file', input: { path: 'b.md' } }
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 8 }
        },
        { content: [{ type: 'text', text: 'both read' }], stop_reason: 'end_turn', usage: { input_tokens: 25, output_tokens: 6 } }
      ]
    })
    const finalSurface = turn1.res.finalSurfaceMessages
    expect(finalSurface).toBeTruthy()

    const a1 = makeAssistantMessage(sessionId, 'a1', '', 1_100, [
      makeToolCallRecord('tu-a', { path: 'a.md' }, factOf('tu-a')?.result),
      makeToolCallRecord('tu-b', { path: 'b.md' }, factOf('tu-b')?.result)
    ])
    const a2 = makeAssistantMessage(sessionId, 'a2', 'both read', 1_200)
    const u2 = makeUserMessage(sessionId, 'u2', 'go on', 2_000)

    const turn2 = await driveTurn({
      history: [u1, a1, a2],
      userMessage: u2,
      rounds: [{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 30, output_tokens: 5 } }]
    })
    const rebuiltHistory = rebuiltHistoryOf(turn2.round1Messages as unknown[])
    expectSurfaceParity(finalSurface as unknown[], rebuiltHistory, '多工具场景').assert()
  })

  it('评审观察 1：tool_use 轮中的空白 text 块剔除后与重建产出 parity（§3.4.5 残留缺口）', async () => {
    await fs.writeFile(path.join(tmpDir, 'doc.md'), 'whitespace parity', 'utf8')
    const u1 = makeUserMessage(sessionId, 'u1', 'read the doc', 1_000)
    const turn1 = await driveTurn({
      history: [],
      userMessage: u1,
      rounds: [
        {
          content: [
            { type: 'text', text: '   ' },
            { type: 'tool_use', id: 'tu-ws', name: 'read_file', input: { path: 'doc.md' } }
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 8 }
        },
        { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }
      ]
    })
    const finalSurface = turn1.res.finalSurfaceMessages
    expect(finalSurface).toBeTruthy()
    const a1 = makeAssistantMessage(sessionId, 'a1', '', 1_100, [
      makeToolCallRecord('tu-ws', { path: 'doc.md' }, factOf('tu-ws')?.result)
    ])
    const a2 = makeAssistantMessage(sessionId, 'a2', 'done', 1_200)
    const u2 = makeUserMessage(sessionId, 'u2', 'next', 2_000)
    const turn2 = await driveTurn({
      history: [u1, a1, a2],
      userMessage: u2,
      rounds: [{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 30, output_tokens: 5 } }]
    })
    const rebuiltHistory = rebuiltHistoryOf(turn2.round1Messages as unknown[])
    expectSurfaceParity(finalSurface as unknown[], rebuiltHistory, '空白 text 块场景').assert()
  })

  it('特征化报告：输出两层口径的首个分歧位置（诊断用，不因分歧失败）', async () => {
    await fs.writeFile(path.join(tmpDir, 'doc.md'), 'diagnostic content', 'utf8')
    const u1 = makeUserMessage(sessionId, 'u1', 'read the doc', 1_000)
    const turn1 = await driveTurn({
      history: [],
      userMessage: u1,
      rounds: [
        { content: [{ type: 'tool_use', id: 'tu-read', name: 'read_file', input: { path: 'doc.md' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
        { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }
      ]
    })
    const a1 = makeAssistantMessage(sessionId, 'a1', '', 1_100, [
      makeToolCallRecord('tu-read', { path: 'doc.md' }, factOf('tu-read')?.result)
    ])
    const a2 = makeAssistantMessage(sessionId, 'a2', 'done', 1_200)
    const u2 = makeUserMessage(sessionId, 'u2', 'again', 2_000)
    const turn2 = await driveTurn({
      history: [u1, a1, a2],
      userMessage: u2,
      rounds: [{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 30, output_tokens: 5 } }]
    })
    const finalSurface = (turn1.res.finalSurfaceMessages ?? []) as unknown[]
    const rebuiltHistory = rebuiltHistoryOf(turn2.round1Messages as unknown[])
    const report = expectSurfaceParity(finalSurface, rebuiltHistory, '特征化')
    // 特征化输出：无论分歧与否都通过，供 P0-1 埋点与 P0-2 修复对照
    console.info('[rebuildParity] surface 面:', describeDiv(report.surfaceDiv))
    console.info('[rebuildParity] wire 面:', describeDiv(report.wireDiv))
    expect(finalSurface.length, '两侧 item 数应一致').toBe(rebuiltHistory.length)
  })
})
