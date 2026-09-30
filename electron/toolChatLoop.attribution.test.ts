import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { WebContents } from 'electron'
import type { AppDatabase } from './database'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'

const mockGetCachedMemoryContent = vi.fn(() => null)
const mockCreateAnthropicClient = vi.fn()
let streamRound = 0
let capturedFacts: Array<Record<string, unknown>> = []
let capturedSessionEvents: Array<{ type: string; payload?: Record<string, unknown> }> = []

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

vi.mock('./tools/builtinExecutors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/builtinExecutors')>()
  const { defineDirectTool } = await import('./tools/plannedToolRegistry')
  const readFile = defineDirectTool({ name: 'read_file', parseInput: (raw) => raw, execute: async () => ({ success: true, data: 'file-content-abc' }) })
  return { ...actual, getRegisteredTool: vi.fn(() => undefined), getToolExecutor: vi.fn() }
})

vi.mock('./browser/stagehandService', () => ({
  stagehandService: { resetInferenceCount: vi.fn() }
}))

vi.mock('./toolConfirmRegistry', () => ({
  registerToolCancel: vi.fn(),
  clearToolCancel: vi.fn(),
  cancelAllToolConfirmsForRequest: vi.fn(),
  prepareToolConfirm: vi.fn(),
  waitForToolConfirm: vi.fn(async () => ({ approved: true }))
}))

vi.mock('./database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./database')>()
  return {
    ...actual,
    getSession: vi.fn(() => undefined)
  }
})

import { runToolChatSession } from './toolChatLoop'
import { assembleInvocation } from './runtime/invocationAssembler'
import { createMemoryAppDb } from './database/testHelpers'
import { getUsageStepFactsForTurn, getUsageTurnFact, listOrphanUsageTurns } from './database/operations'
import type { StepAttributionJson, TurnToolDimension } from '../src/shared/usageAttribution'

function runAssembledSession(materials: unknown) {
  const { invocation, ports } = assembleInvocation(materials as never)
  return runToolChatSession(invocation, ports)
}

function makeSender(): WebContents {
  return { send: vi.fn(), isDestroyed: vi.fn(() => false) } as unknown as WebContents
}

function makeDb(): AppDatabase {
  return createMemoryAppDb('zh-CN')
}

function toolThenFinalSender() {
  return {
    messages: {
      stream: vi.fn(() => {
        const round = streamRound++
        return {
          async *[Symbol.asyncIterator]() {
            if (round === 0) {
              yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'a.txt' } } }
              yield { type: 'content_block_stop', index: 0 }
            } else {
              yield { type: 'content_block_start', index: 0, content_block: { type: 'text' } }
              yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }
              yield { type: 'content_block_stop', index: 0 }
            }
          },
          finalMessage: vi.fn(async () => round === 0
            ? { content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'a.txt' } }], stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 20 } }
            : { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 200, output_tokens: 5 } })
        }
      })
    }
  }
}

describe('toolChatLoop 归因接线（AT17 桌面腿 / AT18 / AT19）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    streamRound = 0
    capturedFacts = []
    capturedSessionEvents = []
    mockGetCachedMemoryContent.mockReturnValue(null)
  })

  async function runToolSession(db: AppDatabase) {
    return runAssembledSession({
      sender: makeSender(),
      requestId: 'req-attr-1',
      sessionId: 'sess-attr-1',
      model: 'claude-sonnet-4-20250514',
      messages: [{ role: 'user', content: 'hello' }],
      toolsConfig: DEFAULT_TOOLS_CONFIG,
      workDir: '/tmp',
      userDataDir: '/tmp/spaceassistant-userdata',
      getApiKey: async () => 'test-key',
      emitFactEvent: (event: Record<string, unknown>) => capturedFacts.push(event),
      emitSessionEvent: async (event: { type: string; payload?: Record<string, unknown> }) => { capturedSessionEvents.push(event) },
      appDb: db,
      options: {}
    })
  }

  it('step 行带归因：三源真列 + estimator_version=block-v1 + 骨架 JSON（AT17 桌面腿）', async () => {
    const db = makeDb()
    mockCreateAnthropicClient.mockReturnValue(toolThenFinalSender())
    const result = await runToolSession(db)
    expect(result.ok).toBe(true)

    const steps = getUsageStepFactsForTurn(db, 'sess-attr-1', 'sess-attr-1')
    expect(steps.length).toBeGreaterThanOrEqual(2)
    for (const step of steps) {
      expect(step.estimatorVersion).toBe('block-v1')
      expect(step.systemTokens).not.toBeNull()
      expect(step.toolsTokens).not.toBeNull()
      expect(step.messageTokens).not.toBeNull()
      expect(step.attributionJson).not.toBeNull()
      const parsed = JSON.parse(step.attributionJson!) as StepAttributionJson
      expect(parsed.schemaVersion).toBe(1)
      expect(Object.keys(parsed.blocks).length).toBeGreaterThan(0)
    }
    // 骨架能看到本轮 user 消息与上一轮的 assistant tool_use / user tool_result（输入侧消息体构成，SRC-C3）
    const last = JSON.parse(steps[steps.length - 1]!.attributionJson!) as StepAttributionJson
    expect(Object.keys(last.blocks)).toEqual(expect.arrayContaining(['user|text', 'assistant|tool_use', 'user|tool_result']))
    db.close()
  })

  it('turn 行带工具维度：声明明细 + 返回体量（AT19，不读台账）', async () => {
    const db = makeDb()
    mockCreateAnthropicClient.mockReturnValue(toolThenFinalSender())
    await runToolSession(db)

    const turn = getUsageTurnFact(db, 'sess-attr-1')!
    expect(turn).toBeDefined()
    expect(turn.toolAttributionJson).not.toBeNull()
    const parsed = JSON.parse(turn.toolAttributionJson!) as TurnToolDimension
    expect(parsed.tools['read_file']).toBeGreaterThan(0)
    expect(parsed.toolSource.builtin).toBeGreaterThan(0)
    expect(parsed.toolResults['read_file']).toEqual({ calls: 1, chars: expect.any(Number) })
    db.close()
  })

  it('tool_result 事件冗余 toolName/toolSource（AD10，§7.3）', async () => {
    const db = makeDb()
    mockCreateAnthropicClient.mockReturnValue(toolThenFinalSender())
    await runToolSession(db)
    const toolResult = capturedSessionEvents.find((event) => event.type === 'tool_result')
    expect(toolResult).toBeDefined()
    expect(toolResult!.payload!.result).toMatchObject({ toolName: 'read_file', toolSource: 'builtin' })
    db.close()
  })

  it('归因与用量严格 1:1（AT18）：无孤儿 turn，step 行数 == request_usage 条数', async () => {
    const db = makeDb()
    mockCreateAnthropicClient.mockReturnValue(toolThenFinalSender())
    await runToolSession(db)
    expect(listOrphanUsageTurns(db)).toEqual([])
    const steps = getUsageStepFactsForTurn(db, 'sess-attr-1', 'sess-attr-1')
    const usageEvents = capturedSessionEvents.filter((event) => event.type === 'request_usage')
    expect(steps).toHaveLength(usageEvents.length)
    // 每行都有归因（1:1 且非 NULL）
    expect(steps.every((step) => step.attributionJson !== null && step.estimatorVersion === 'block-v1')).toBe(true)
    db.close()
  })
})
