import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import { setKnownHomeDir } from '../src/shared/agentSafeText'

/**
 * §7.2 集成测试：真实 tool loop（runToolChatSession + 真实 edit_file/read_file 执行器）下，
 * edit_file 匹配失败返回 diagnosis 后模型一次修正成功——
 * 1. 真实案例 fixture（2 个反斜杠）：失败带 suggestedOldString → 第二次成功，全链路无 run_script；
 * 2. B1 反例保护：候选块含主目录路径 → 建议被抑制 + hint 仍可操作 + 不触发重试熔断。
 */

const mockGetCachedMemoryContent = vi.fn(() => null)
const mockCreateAnthropicClient = vi.fn()
const mockConfirmOutcome = vi.fn(async () => 'approved' as const)
let streamRound = 0
const capturedFacts: Array<Record<string, unknown>> = []
const capturedSessionEvents: Array<Record<string, unknown>> = []

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
  cancelAllToolConfirmsForRequest: vi.fn(),
  prepareToolConfirm: vi.fn(),
  waitForToolConfirm: vi.fn(async () => mockConfirmOutcome())
}))

vi.mock('./database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./database')>()
  return {
    ...actual,
    getSession: vi.fn(() => undefined)
  }
})

// read_file / edit_file 用真实执行器（写真实临时文件），其余工具一律不可用——
// 若模型改用 run_script 写文件，回合将拿不到执行器而显式失败，即 §7.2「run_script 写文件次数为 0」的链路保证。
vi.mock('./tools/builtinExecutors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/builtinExecutors')>()
  return {
    ...actual,
    getToolExecutor: vi.fn((name: string) => {
      if (name === 'read_file') return actual.readFileExecutor
      if (name === 'edit_file') return actual.editFileExecutor
      return undefined
    })
  }
})

// 文件快通道直接批准：聚焦 edit_file 失败诊断链路（真实评估器的 realpath/敏感前缀检查与被测逻辑无关，
// 参照 toolChatLoop.fileAutoApprove.test.ts 的既有写法）
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

// 真实案例第 58 行：文件 2 个连续反斜杠，模型首次提交 1 个（JS 字面量 \\\\ = 2 个反斜杠）
const REAL_LINE_FILE = "wiki: `rg -n '(:\\\\s*\\\\(|=>)' src/shared/agent/invocation.ts` 说明"
const REAL_LINE_SUBMITTED = "wiki: `rg -n '(:\\s*\\(|=>)' src/shared/agent/invocation.ts` 说明"

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

function factOf(id: string): { result?: { success?: boolean; data?: { diagnosis?: Record<string, unknown> }; error?: string } } | undefined {
  return capturedFacts.find((f) => f.type === 'tool-result' && (f as { id?: string }).id === id) as never
}

describe('edit_file 失败诊断链路（§7.2 集成）', () => {
  let tmpDir: string
  let sessionId: string

  beforeEach(async () => {
    vi.clearAllMocks()
    streamRound = 0
    capturedFacts.length = 0
    capturedSessionEvents.length = 0
    mockGetCachedMemoryContent.mockReturnValue(null)
    mockConfirmOutcome.mockResolvedValue('approved')
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-edit-diag-e2e-')))
    sessionId = `sess-edit-diag-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // 主进程运行时由 main.ts 注入；链路级预检依赖同一状态（§5.2.1）
    setKnownHomeDir('C:\\Users\\alice')
  })

  afterEach(async () => {
    setKnownHomeDir(undefined)
    clearSessionToolResources(sessionId)
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function runRounds(rounds: Array<{ content: unknown[]; stop_reason: string; usage?: Record<string, number> }>) {
    mockCreateAnthropicClient.mockReturnValue(makeStreamRounds(rounds))
    const materials = {
      requestId: 'req-edit-diag-e2e',
      sessionId,
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'edit the doc' }],
      toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: tmpDir,
      userDataDir: path.join(tmpDir, '.userdata'),
      getApiKey: async () => 'test-key',
      appDb: createMemoryAppDb('zh-CN'),
      emitFactEvent: (event: Record<string, unknown>) => capturedFacts.push(event),
      emitSessionEvent: async (event: Record<string, unknown>) => {
        capturedSessionEvents.push(event)
      }
    }
    const { invocation, ports } = assembleInvocation(materials as never)
    return runToolChatSession(invocation, ports)
  }

  it('真实 fixture：首次失败带 suggestedOldString，第二次成功；全链路 0 次 run_script 且回合收敛', async () => {
    const abs = path.join(tmpDir, 'doc.md')
    const original = ['intro line', REAL_LINE_FILE, 'outro line'].join('\n')
    await fs.writeFile(abs, original, 'utf8')

    const res = await runRounds([
      { content: [{ type: 'tool_use', id: 'tu-read', name: 'read_file', input: { path: 'doc.md' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
      { content: [{ type: 'tool_use', id: 'tu-edit-bad', name: 'edit_file', input: { path: 'doc.md', old_string: REAL_LINE_SUBMITTED, new_string: 'new line' } }], stop_reason: 'tool_use', usage: { input_tokens: 12, output_tokens: 5 } },
      // 第二次：模型使用 diagnosis.suggestedOldString（= REAL_LINE_FILE）重试
      { content: [{ type: 'tool_use', id: 'tu-edit-good', name: 'edit_file', input: { path: 'doc.md', old_string: REAL_LINE_FILE, new_string: 'new line' } }], stop_reason: 'tool_use', usage: { input_tokens: 14, output_tokens: 5 } },
      { content: [{ type: 'text', text: 'done via edit_file only' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }
    ])

    // 回合正常收敛（未触发「连续 3 次相同错误 → 熔断中止」）
    expect(res).toMatchObject({ ok: true, content: [{ type: 'text', text: 'done via edit_file only' }] })

    // 第一次 edit_file 失败：稳定错误码 + 结构化诊断 + 可下发建议（投影后仍逐字符可用）
    const badFact = factOf('tu-edit-bad')
    expect(badFact?.result?.success).toBe(false)
    const diag = badFact?.result?.data?.diagnosis as {
      kind: string
      candidateLineRange: [number, number]
      usableAsOldString: boolean
      suggestedOldString?: string
      hint: string
    }
    expect(diag.kind).toBe('escape-layer-mismatch')
    expect(diag.candidateLineRange).toEqual([2, 2])
    expect(diag.usableAsOldString).toBe(true)
    expect(diag.suggestedOldString).toBe(REAL_LINE_FILE)
    expect(diag.hint).toContain('edit_file')

    // 第二次 edit_file 成功，磁盘内容正确（经 safeAtomicWrite 写路径）
    expect(factOf('tu-edit-good')?.result?.success).toBe(true)
    expect(await fs.readFile(abs, 'utf8')).toBe(['intro line', 'new line', 'outro line'].join('\n'))

    // 全链路模型只发起 read_file + 2×edit_file（rounds 里没有 run_script 调用；若出现未知工具会留下 notExecuted 事实）
    const toolResultIds = capturedFacts
      .filter((f) => f.type === 'tool-result')
      .map((f) => (f as { id?: string }).id)
      .sort()
    expect(toolResultIds).toEqual(['tu-edit-bad', 'tu-edit-good', 'tu-read'])
  })

  it('B1 反例保护：候选含主目录路径 → 建议被抑制 + hint 可操作 + 按提示修正后成功，不触发熔断', async () => {
    const abs = path.join(tmpDir, 'log.md')
    const realLine = 'log path: C:\\Users\\alice\\notes\\todo.txt written'
    await fs.writeFile(abs, ['head', realLine, 'tail'].join('\n'), 'utf8')

    const res = await runRounds([
      { content: [{ type: 'tool_use', id: 'b1-read', name: 'read_file', input: { path: 'log.md' } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } },
      // 第一次：提交含错拼（wriitten）且候选块含主目录路径
      { content: [{ type: 'tool_use', id: 'b1-edit-bad', name: 'edit_file', input: { path: 'log.md', old_string: 'log path: C:\\Users\\alice\\notes\\todo.txt wriitten', new_string: 'x' } }], stop_reason: 'tool_use', usage: { input_tokens: 12, output_tokens: 5 } },
      // 第二次：模型按 hint 的行号/计数信息自行修正（建议被抑制，不存在可照抄的片段）
      { content: [{ type: 'tool_use', id: 'b1-edit-good', name: 'edit_file', input: { path: 'log.md', old_string: realLine, new_string: 'x' } }], stop_reason: 'tool_use', usage: { input_tokens: 14, output_tokens: 5 } },
      { content: [{ type: 'text', text: 'fixed after hint' }], stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 8 } }
    ])

    // 回合正常收敛：建议被抑制的路径不会走向「下发被改写建议 → 反复失败 → 循环中止」
    expect(res).toMatchObject({ ok: true, content: [{ type: 'text', text: 'fixed after hint' }] })

    const badFact = factOf('b1-edit-bad')
    expect(badFact?.result?.success).toBe(false)
    const diag = badFact?.result?.data?.diagnosis as {
      usableAsOldString: boolean
      suppressionReason?: string
      suggestedOldString?: string
      hint: string
    }
    // B1 核心：建议被抑制，但 hint 仍给出可操作事实（行号 + read_file 指引）
    expect(diag.usableAsOldString).toBe(false)
    expect(diag.suppressionReason).toBe('sanitize-would-rewrite')
    expect(diag.suggestedOldString).toBeUndefined()
    expect(diag.hint).toContain('2')
    expect(diag.hint).toContain('read_file')

    expect(factOf('b1-edit-good')?.result?.success).toBe(true)
    expect(await fs.readFile(abs, 'utf8')).toBe(['head', 'x', 'tail'].join('\n'))
  })
})
