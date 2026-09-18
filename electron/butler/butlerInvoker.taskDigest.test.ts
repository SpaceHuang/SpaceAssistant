/**
 * D 任务声明证据段（对比分析 §4-D）：管家装配把任务 prompt 摘要（可信证据——用户创建任务时
 * 的输入）经 RunToolChatSessionArgs.approvalTaskDigest 传入执行链，最终进审批线索包
 * clue.taskDigest，供裁决模型判断「动作是否服务于任务」。
 * 本文件 mock toolChatLoop 只为观测装配参数；其余（准入 / 会话 / turnRuntime / 任务存储）走真实链路。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockRunToolChatSession = vi.fn()
const mockResolveLlmCredentials = vi.fn()

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'zh-CN') }
}))

vi.mock('../toolChatLoop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../toolChatLoop')>()
  return {
    ...actual,
    runToolChatSession: (...args: unknown[]) => mockRunToolChatSession(...(args as [unknown]))
  }
})

vi.mock('../llmServiceResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llmServiceResolver')>()
  return {
    ...actual,
    resolveLlmCredentialsForModel: (...args: unknown[]) =>
      mockResolveLlmCredentials(...(args as [unknown]))
  }
})

vi.mock('../agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn(),
  logAgentError: vi.fn()
}))

import { openDatabase, setConfigValue, type AppDatabase } from '../database'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import { TurnRuntime } from '../turnRuntime'
import { createTurnCoordinatorStorage } from '../turnCoordinatorStorage'
import { runButlerTask, buildApprovalTaskDigest } from './butlerInvoker'
import { createAutomationTask } from './taskStore'

function makeRuntime(db: AppDatabase): TurnRuntime {
  return new TurnRuntime({
    storage: createTurnCoordinatorStorage(db),
    deps: { now: Date.now, id: (() => { let i = 0; return () => `id-${++i}` })() }
  })
}

describe('butlerInvoker 任务声明装配（D）', () => {
  let db: AppDatabase
  beforeEach(() => {
    vi.clearAllMocks()
    db = openDatabase(':memory:')
    setConfigValue(db, 'config.defaultModel', 'claude-sonnet-4-20250514')
    mockResolveLlmCredentials.mockResolvedValue({
      error: undefined,
      serviceId: 'svc-1',
      baseUrl: 'https://mock.local',
      getApiKey: async () => 'test-key'
    })
    mockRunToolChatSession.mockResolvedValue({
      ok: true,
      content: [{ type: 'text', text: '任务完成。' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 }
    })
  })

  function makeDeps() {
    return {
      db,
      turnRuntime: makeRuntime(db),
      getWorkDir: () => '/tmp/wd',
      getUserDataPath: () => '/tmp/ud',
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, confirmMode: 'auto' as const }),
      resolveWorkDirForSession: () => '/tmp/wd'
    }
  }

  it('任务 prompt 经 buildApprovalTaskDigest 随 args.approvalTaskDigest 传入执行链', async () => {
    const task = createAutomationTask(db, {
      name: '巡检',
      schedule: { kind: 'interval', intervalMinutes: 30 },
      prompt: '检查磁盘空间',
      deliveryPref: 'none'
    })
    const result = await runButlerTask(makeDeps(), task.id, { trigger: 'manual', requestId: 'req-digest-1' })
    expect(result.ok).toBe(true)
    expect(mockRunToolChatSession).toHaveBeenCalled()
    const inv = mockRunToolChatSession.mock.calls[0]![0] as { additionalContext: Record<string, unknown> }
    expect(inv.additionalContext['approval.taskDigest']).toBe('检查磁盘空间')
  })
})

describe('buildApprovalTaskDigest（摘要规则）', () => {
  it('折叠空白字符（渲染进提示词时保持单行形态）', () => {
    expect(buildApprovalTaskDigest('  检查\n磁盘\t空间  ')).toBe('检查 磁盘 空间')
  })

  it('超长截断到 500 字符（线索包有界）', () => {
    expect(buildApprovalTaskDigest('a'.repeat(800))).toHaveLength(500)
  })
})
