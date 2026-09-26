/**
 * H2（评审）回归锚点：desktop standard 下 write_file 自动批准必须产生
 * `file.auto_approve` 审计事件与 `autoApprovedWrite` 持久 meta。
 * P1 删除 desktop-auto-approve 规则后，自动批准改由档位变换路径产出
 * （gate.fileAutoApproved 显式字段判定），不再有 desktop-auto-approve ruleId 可匹配。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import type { WebContents } from 'electron'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'

const mockLogAgentEvent = vi.fn()
const mockCreateAnthropicClient = vi.fn()
let streamRound = 0
const capturedSessionEvents: Array<{ type: string; payload: Record<string, unknown> }> = []

function makeMockStream() {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'message_start' }
    },
    finalMessage: vi.fn(async () => {
      streamRound += 1
      if (streamRound === 1) {
        return {
          content: [{ type: 'tool_use', id: 'tu-auto', name: 'write_file', input: { path: 'a.txt', content: 'x' } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 }
        }
      }
      return {
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 20, output_tokens: 8 }
      }
    })
  }
}

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: (...args: unknown[]) => mockLogAgentEvent(...args),
  logAgentError: vi.fn()
}))

vi.mock('./projectMemory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./projectMemory')>()
  return { ...actual, getCachedMemoryContent: () => null }
})

vi.mock('./anthropicClientFactory', () => ({
  createAnthropicClient: (...args: unknown[]) => mockCreateAnthropicClient(...args)
}))

vi.mock('./safeWebContentsSend', () => ({
  isWebContentsAlive: vi.fn(() => true),
  safeWebContentsSend: vi.fn()
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

vi.mock('./tools/builtinExecutors', () => ({
  // registeredTool 置空 → loop 走裸 exec.execute 路径（不需要完整 RegisteredTool 接口）
  getRegisteredTool: vi.fn(() => undefined),
  getToolExecutor: vi.fn(() => ({ execute: async () => ({ success: true, data: 'ok' }) }))
}))

vi.mock('./browser/stagehandService', () => ({
  stagehandService: { resetInferenceCount: vi.fn() }
}))

// 文件快通道直接批准：聚焦 toolChatLoop 对 gate.fileAutoApproved 的消费链路
// （真实评估器依赖工作目录 realpath/敏感前缀检查，与被测逻辑无关）
vi.mock('./tools/writeFileAutoApproval', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tools/writeFileAutoApproval')>()),
  evaluateFileToolAutoApproval: vi.fn(async () => ({ approve: true as const }))
}))

vi.mock('./toolConfirmRegistry', () => ({
  registerToolCancel: vi.fn(),
  clearToolCancel: vi.fn(),
  cancelAllToolConfirmsForRequest: vi.fn(),
  prepareToolConfirm: vi.fn(),
  waitForToolConfirm: vi.fn(async () => 'approved' as const)
}))

vi.mock('./database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./database')>()
  return { ...actual, getSession: vi.fn(() => undefined) }
})

import { runToolChatSession } from './toolChatLoop'
import { assembleInvocation } from './runtime/invocationAssembler'
import { createMemoryAppDb } from './database/testHelpers'

function makeSender(): WebContents {
  return { send: vi.fn(), isDestroyed: vi.fn(() => false) } as unknown as WebContents
}

describe('desktop standard write_file 自动批准（H2 审计回归）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamRound = 0
    capturedSessionEvents.length = 0
    mockCreateAnthropicClient.mockImplementation(() => ({
      messages: {
        stream: vi.fn(() => makeMockStream())
      }
    }))
  })

  async function runSession(): Promise<void> {
    // Windows 下 /tmp 非真实路径会让 writeFileAutoApproval 的 realpath 检查拒绝，用真实临时目录
    const workDir = await mkdtemp(path.join(tmpdir(), 'h2-auto-approve-'))
    const db: AppDatabase = createMemoryAppDb('zh-CN')
    // P1 契约重构：材料经装配器构造 Invocation + ports（gatePolicy/effectiveRules/lanePackage 同源装配）
    const { invocation, ports } = assembleInvocation({
      requestId: 'req-h2',
      sessionId: 'sess-h2',
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'write it' }],
      toolsConfig: { ...DEFAULT_TOOLS_CONFIG },
      workDir,
      userDataDir: path.join(workDir, '.userdata'),
      getApiKey: async () => 'test-key',
      appDb: db,
      emitFactEvent: () => undefined,
      emitSessionEvent: async (event) => {
        capturedSessionEvents.push(event as { type: string; payload: Record<string, unknown> })
      }
    } as never)
    await runToolChatSession(invocation as never, ports as never)
  }

  it('自动批准走档位变换路径：落 file.auto_approve 审计 + autoApprovedWrite meta', async () => {
    await runSession()

    const audit = mockLogAgentEvent.mock.calls.find((c) => c[1] === 'file.auto_approve')
    expect(audit, 'file.auto_approve 审计事件必须产生').toBeTruthy()

    const toolResult = capturedSessionEvents.find((e) => e.type === 'tool_result') as
      | { payload: { result: { decisionRuleId?: string; autoApprovedWrite?: { path: string; bytesWritten: number } } } }
      | undefined
    expect(toolResult?.payload.result.autoApprovedWrite).toMatchObject({ path: 'a.txt' })
    expect(toolResult?.payload.result.decisionRuleId).toBeTruthy()
  })

  it('P1-3(a)：事件流事实载荷不再携带 autoApprovedWrite.diff 全文（渲染层零引用的死字段）', async () => {
    await runSession()

    const toolResult = capturedSessionEvents.find((e) => e.type === 'tool_result') as
      | { payload: { result: { autoApprovedWrite?: Record<string, unknown> } } }
      | undefined
    const meta = toolResult?.payload.result.autoApprovedWrite
    expect(meta, '自动批准的 tool_result 应保留 autoApprovedWrite 元数据').toBeTruthy()
    expect(meta).not.toHaveProperty('diff')
    // 行统计元数据保留（供审计/展示聚合）
    expect(meta).toMatchObject({ path: 'a.txt' })
    expect(typeof meta?.added).toBe('number')
    expect(typeof meta?.removed).toBe('number')
    expect(typeof meta?.bytesWritten).toBe('number')
  })
})
