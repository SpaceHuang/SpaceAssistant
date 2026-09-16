import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockCreateAnthropicClient = vi.fn()
const mockResolveLlmCredentials = vi.fn()

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'zh-CN') }
}))

vi.mock('../anthropicClientFactory', () => ({
  createAnthropicClient: (...args: unknown[]) => mockCreateAnthropicClient(...args)
}))

vi.mock('../llmServiceResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llmServiceResolver')>()
  return {
    ...actual,
    resolveLlmCredentialsForModel: (...args: unknown[]) => mockResolveLlmCredentials(...args)
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
import { runButlerTask } from './butlerInvoker'
import { createAutomationTask, getLatestRunForTask } from './taskStore'
import { getSession } from '../database'

function makeRuntime(db: AppDatabase): TurnRuntime {
  return new TurnRuntime({
    storage: createTurnCoordinatorStorage(db),
    deps: { now: Date.now, id: (() => { let i = 0; return () => `id-${++i}` })() }
  })
}

describe('butlerInvoker 管家执行链（P4 集成）', () => {
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
  })

  function makeDeps(overrides: Record<string, unknown> = {}) {
    return {
      db,
      turnRuntime: makeRuntime(db),
      getWorkDir: () => '/tmp/wd',
      getUserDataPath: () => '/tmp/ud',
      getToolsConfig: () => ({ ...DEFAULT_TOOLS_CONFIG, confirmMode: 'auto' as const }),
      resolveWorkDirForSession: () => '/tmp/wd',
      ...overrides
    }
  }

  it('手动触发：会话创建归属正确，回合完成，run 记录 completed + usage + summary', async () => {
    const task = createAutomationTask(db, {
      name: '巡检',
      schedule: { kind: 'interval', intervalMinutes: 30 },
      prompt: '检查磁盘空间',
      deliveryPref: 'none'
    })
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        stream: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {},
          finalMessage: vi.fn(async () => ({
            content: [{ type: 'text', text: '磁盘 42% 已用，一切正常。' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 120, output_tokens: 30 }
          }))
        }))
      }
    })

    const result = await runButlerTask(makeDeps(), task.id, { trigger: 'manual', requestId: 'req-butler-1' })
    expect(result.ok).toBe(true)

    const run = getLatestRunForTask(db, task.id)
    expect(run?.status).toBe('completed')
    expect(run?.sessionId).toBeTruthy()
    expect(run?.resultSummary).toContain('磁盘')
    expect(run?.usageJson).toContain('input_tokens')
    expect(run?.trigger).toBe('manual')

    const session = run?.sessionId ? getSession(db, run.sessionId) : undefined
    expect(session?.ownership).toBe('automation')
    expect(session?.visibility).toBe('section')
  })

  it('提示词诱导写文件：门控拒绝（无回答者），回合收敛，run 记录说明拒绝原因', async () => {
    const task = createAutomationTask(db, {
      name: '写文件任务',
      schedule: { kind: 'interval', intervalMinutes: 30 },
      prompt: '请写入 report.txt',
      deliveryPref: 'none'
    })
    let round = 0
    mockCreateAnthropicClient.mockReturnValue({
      messages: {
        stream: vi.fn(() => {
          const current = round++
          return {
            async *[Symbol.asyncIterator]() {},
            finalMessage: vi.fn(async () => {
              if (current === 0) {
                return {
                  content: [{ type: 'tool_use', id: 'tu-w', name: 'write_file', input: { path: 'report.txt', content: 'x' } }],
                  stop_reason: 'tool_use',
                  usage: { input_tokens: 50, output_tokens: 10 }
                }
              }
              return {
                content: [{ type: 'text', text: '写文件操作被安全策略拒绝：automation 无人类应答者，无法确认。' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 80, output_tokens: 20 }
              }
            })
          }
        })
      }
    })

    const result = await runButlerTask(makeDeps(), task.id, { trigger: 'manual', requestId: 'req-butler-2' })
    expect(result.ok).toBe(true)
    const run = getLatestRunForTask(db, task.id)
    expect(run?.status).toBe('completed')
    expect(run?.resultSummary).toContain('拒绝')
    expect(run?.sessionId).toBeTruthy()
  })
})
