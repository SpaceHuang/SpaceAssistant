import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '../database'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'

/**
 * P4（偏差 5 + 6）：baseUrl 出契约（网络目标归 ports.credentials）与思维强度分档（effort）。
 */

vi.mock('electron', () => ({ app: { getLocale: vi.fn(() => 'zh-CN') } }))
vi.mock('../agentLogger/agentLogger', () => ({
  logAgentEvent: vi.fn(),
  logAgentError: vi.fn()
}))

import { openDatabase, setConfigValue } from '../database'
import { assembleInvocation, type AgentInvocationMaterials } from './invocationAssembler'

const shells: AppDatabase[] = []
afterEach(() => {
  shells.splice(0).forEach((db) => db.close())
})

function seedModel(db: AppDatabase, name: string, supportsThinking?: boolean): void {
  const models = [{ id: name, name, maximumContext: 200000, maxTokens: 64000, isDefault: false, isFast: false, isVision: false, enabled: true, ...(supportsThinking !== undefined ? { supportsThinking } : {}) }]
  setConfigValue(db, 'config.models', JSON.stringify(models))
  setConfigValue(db, 'config.llmServices', JSON.stringify([
    { id: 'svc-1', name: 'S1', baseUrl: 'https://svc.example.com', supportedModelIds: [name], createdAt: '1', updatedAt: '1' }
  ]))
  setConfigValue(db, 'config.activeLlmServiceIds', JSON.stringify(['svc-1']))
}

function materials(db: AppDatabase | undefined, overrides: Partial<AgentInvocationMaterials> = {}): AgentInvocationMaterials {
  return {
    requestId: 'req-p4',
    sessionId: 'sess-p4',
    model: 'model-a',
    messages: [{ role: 'user', content: 'x' }] as never,
    toolsConfig: DEFAULT_TOOLS_CONFIG,
    workDir: '/tmp',
    userDataDir: '/tmp',
    getApiKey: async () => 'k',
    ...(db ? { appDb: db } : {}),
    emitFactEvent: () => undefined,
    emitSessionEvent: async () => undefined,
    ...overrides
  }
}

describe('偏差 5：baseUrl 出契约', () => {
  it('invocation.profile 不含 baseUrl；网络目标归 ports.credentials.networkTarget', () => {
    const db = openDatabase(':memory:')
    shells.push(db)
    seedModel(db, 'model-a')
    const { invocation, ports } = assembleInvocation(materials(db, { baseUrl: 'https://relay.example.com' }))
    expect((invocation.profile as Record<string, unknown>).baseUrl).toBeUndefined()
    expect(ports.credentials.networkTarget?.baseUrl).toBe('https://relay.example.com')
  })
})

describe('偏差 6：思维强度分档（effort）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('兼容映射：enableThinking=true → effort=medium；false → off（布尔入口保留一个发布周期）', () => {
    const db = openDatabase(':memory:')
    shells.push(db)
    seedModel(db, 'model-a')
    const on = assembleInvocation(materials(db, { options: { enableThinking: true } }))
    expect(on.invocation.profile.reasoning?.effort).toBe('medium')
    const off = assembleInvocation(materials(db, { options: { enableThinking: false } }))
    expect(off.invocation.profile.reasoning?.effort).toBe('off')
  })

  it('显式 effort 优先于 enableThinking 兼容映射', () => {
    const db = openDatabase(':memory:')
    shells.push(db)
    seedModel(db, 'model-a')
    const r = assembleInvocation(materials(db, { options: { enableThinking: true }, effort: 'low' }))
    expect(r.invocation.profile.reasoning?.effort).toBe('low')
  })

  it('缺省（无布尔无档位）→ off（子调用零成本档默认）', () => {
    const db = openDatabase(':memory:')
    shells.push(db)
    seedModel(db, 'model-a')
    const r = assembleInvocation(materials(db))
    expect(r.invocation.profile.reasoning?.effort).toBe('off')
  })

  it('能力校验降级：模型显式不支持 thinking + effort=high → 降 off + degraded 标记 + 审计留痕', async () => {
    const db = openDatabase(':memory:')
    shells.push(db)
    seedModel(db, 'model-a', false)
    const { logAgentEvent } = await import('../agentLogger/agentLogger')
    vi.mocked(logAgentEvent).mockClear()
    const r = assembleInvocation(materials(db, { effort: 'high' }))
    expect(r.invocation.profile.reasoning?.effort).toBe('off')
    expect(r.invocation.profile.reasoning?.degraded).toMatchObject({ from: 'high', to: 'off' })
    expect(vi.mocked(logAgentEvent)).toHaveBeenCalledWith(
      'info',
      'agent.profile.reasoning_degraded',
      expect.objectContaining({ requestId: 'req-p4', model: 'model-a', from: 'high', to: 'off' })
    )
  })

  it('模型能力未标记（缺省）不触发降级（向后兼容）', () => {
    const db = openDatabase(':memory:')
    shells.push(db)
    seedModel(db, 'model-a')
    const r = assembleInvocation(materials(db, { effort: 'high' }))
    expect(r.invocation.profile.reasoning?.effort).toBe('high')
    expect(r.invocation.profile.reasoning?.degraded).toBeUndefined()
  })

  it('无库宿主不做能力校验（显式默认语义，不静默换档）', () => {
    const r = assembleInvocation(materials(undefined, { effort: 'medium' }))
    expect(r.invocation.profile.reasoning?.effort).toBe('medium')
  })
})
