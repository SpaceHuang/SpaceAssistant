import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from './database/testHelpers'
import { createSession, setConfigValue, type AppDatabase } from './database'
import { resolveThinkingEffort, resolveTrustedTurnExecutionConfig } from './turnExecutionConfig'
import type { ModelEntry } from '../src/shared/domainTypes'

vi.mock('./agentLogger/agentLogger', () => ({ logAgentEvent: vi.fn() }))

const SERVICE_ID = 'svc-deepseek'

function makeModel(overrides: Partial<ModelEntry> & Pick<ModelEntry, 'id' | 'name'>): ModelEntry {
  return {
    maximumContext: 200000,
    maxTokens: 64000,
    isDefault: false,
    isFast: false,
    isVision: false,
    enabled: true,
    ...overrides
  }
}

function seedLlmConfig(db: AppDatabase, models: ModelEntry[]): void {
  setConfigValue(db, 'config.models', JSON.stringify(models))
  setConfigValue(db, 'config.llmServices', JSON.stringify([
    {
      id: SERVICE_ID,
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.example/v1',
      supportedModelIds: models.map((m) => m.id),
      createdAt: '1',
      updatedAt: '1'
    }
  ]))
  setConfigValue(db, 'config.activeLlmServiceIds', JSON.stringify([SERVICE_ID]))
  setConfigValue(db, 'secrets.llmServiceKeys', JSON.stringify({ [SERVICE_ID]: 'enc:sk-test' }))
}

describe('resolveThinkingEffort（会话 > 全局 > 能力降级）', () => {
  const entry = (supportsThinking?: boolean): ModelEntry | undefined =>
    makeModel({ id: 'm', name: 'deepseek-chat', ...(supportsThinking === undefined ? {} : { supportsThinking }) })

  it('会话覆盖优先于全局（§9：全局 off + 会话 high → high，允许）', () => {
    expect(resolveThinkingEffort('off', 'high', entry(true))).toBe('high')
    expect(resolveThinkingEffort('high', 'low', entry(undefined))).toBe('low')
  })

  it('无覆盖（undefined / null）继承全局', () => {
    expect(resolveThinkingEffort('medium', undefined, entry())).toBe('medium')
    expect(resolveThinkingEffort('off', null, entry())).toBe('off')
  })

  it('supportsThinking === false 一律降级 off（能力校验先于优先级，§7.1）', () => {
    expect(resolveThinkingEffort('high', 'high', entry(false))).toBe('off')
    expect(resolveThinkingEffort('low', undefined, entry(false))).toBe('off')
  })

  it('模型未知（无 entry）不做能力降级', () => {
    expect(resolveThinkingEffort('medium', undefined, undefined)).toBe('medium')
  })
})

describe('resolveTrustedTurnExecutionConfig 产出档位', () => {
  it('缺省（无新旧键）→ medium，enableThinking 兼容派生为 true', async () => {
    const db = createMemoryAppDb()
    seedLlmConfig(db, [makeModel({ id: 'm', name: 'deepseek-chat' })])
    const session = createSession(db, { name: 's', model: 'deepseek-chat' })

    await expect(resolveTrustedTurnExecutionConfig(db, session.id, 'desktop')).resolves.toMatchObject({
      thinkingEffort: 'medium',
      enableThinking: true
    })
  })

  it('旧布尔 thinkingEnabled=false → off（迁移双读，§7.1）', async () => {
    const db = createMemoryAppDb()
    seedLlmConfig(db, [makeModel({ id: 'm', name: 'deepseek-chat' })])
    const session = createSession(db, { name: 's', model: 'deepseek-chat' })
    setConfigValue(db, 'config.thinkingEnabled', 'false')

    await expect(resolveTrustedTurnExecutionConfig(db, session.id, 'desktop')).resolves.toMatchObject({
      thinkingEffort: 'off',
      enableThinking: false
    })
  })

  it('新旧键并存时新键优先（§9：以 thinkingEffort 为准）', async () => {
    const db = createMemoryAppDb()
    seedLlmConfig(db, [makeModel({ id: 'm', name: 'deepseek-chat' })])
    const session = createSession(db, { name: 's', model: 'deepseek-chat' })
    setConfigValue(db, 'config.thinkingEnabled', 'false')
    setConfigValue(db, 'config.thinkingEffort', 'high')

    await expect(resolveTrustedTurnExecutionConfig(db, session.id, 'desktop')).resolves.toMatchObject({
      thinkingEffort: 'high',
      enableThinking: true
    })
  })

  it('会话覆盖写入冻结快照，且不影响其他会话（§10.3：会话 A low / 会话 B 继承）', async () => {
    const db = createMemoryAppDb()
    seedLlmConfig(db, [makeModel({ id: 'm', name: 'deepseek-chat' })])
    const a = createSession(db, { name: 'a', model: 'deepseek-chat', thinkingEffort: 'low' })
    const b = createSession(db, { name: 'b', model: 'deepseek-chat' })
    setConfigValue(db, 'config.thinkingEffort', 'high')

    await expect(resolveTrustedTurnExecutionConfig(db, a.id, 'desktop')).resolves.toMatchObject({ thinkingEffort: 'low' })
    await expect(resolveTrustedTurnExecutionConfig(db, b.id, 'desktop')).resolves.toMatchObject({ thinkingEffort: 'high' })
  })

  it('supportsThinking === false 的模型冻结为 off（§10.3 能力降级）', async () => {
    const db = createMemoryAppDb()
    seedLlmConfig(db, [makeModel({ id: 'm', name: 'deepseek-chat', supportsThinking: false })])
    const session = createSession(db, { name: 's', model: 'deepseek-chat', thinkingEffort: 'high' })
    setConfigValue(db, 'config.thinkingEffort', 'high')

    await expect(resolveTrustedTurnExecutionConfig(db, session.id, 'desktop')).resolves.toMatchObject({
      thinkingEffort: 'off',
      enableThinking: false
    })
  })

  // B1 断链回归（评审 v1）：turnExecutionConfig 先行降级会把装配器的留痕块跳过，
  // 因此 frozen 必须携带「降级前档位」，主链路把它传给装配器，由装配层照旧落
  // agent.profile.reasoning_degraded 审计并写 profile.reasoning.degraded。
  it('能力降级时携带降级前档位 requestedThinkingEffort，全链路审计不丢失', async () => {
    const db = createMemoryAppDb()
    seedLlmConfig(db, [makeModel({ id: 'm', name: 'deepseek-chat', supportsThinking: false })])
    const session = createSession(db, { name: 's', model: 'deepseek-chat', thinkingEffort: 'high' })
    setConfigValue(db, 'config.thinkingEffort', 'high')

    const frozen = await resolveTrustedTurnExecutionConfig(db, session.id, 'desktop')
    expect(frozen.thinkingEffort).toBe('off')
    expect(frozen.requestedThinkingEffort).toBe('high')

    // 用 frozen 组装配材料（与 claudeStreamHandlers.ts:407 同一传参口径），断言留痕完整
    const { assembleInvocation } = await import('./runtime/invocationAssembler')
    const { logAgentEvent } = await import('./agentLogger/agentLogger')
    const { invocation } = assembleInvocation({
      requestId: 'req-degraded-1',
      sessionId: session.id,
      model: frozen.model ?? 'deepseek-chat',
      messages: [],
      effort: frozen.requestedThinkingEffort ?? frozen.thinkingEffort,
      toolsConfig: {} as never,
      workDir: '/tmp',
      userDataDir: '/tmp',
      getApiKey: async () => 'k',
      appDb: db,
      emitFactEvent: () => undefined,
      emitSessionEvent: () => undefined
    } as never)
    expect(invocation.profile.reasoning).toEqual({
      effort: 'off',
      degraded: { from: 'high', to: 'off' }
    })
    const degradedLogs = vi.mocked(logAgentEvent).mock.calls.filter((c) => c[1] === 'agent.profile.reasoning_degraded')
    expect(degradedLogs).toHaveLength(1)
    expect(degradedLogs[0]?.[2]).toMatchObject({ from: 'high', to: 'off', model: 'deepseek-chat' })
  })

  it('无能力降级时不产出 requestedThinkingEffort（装配器入参 = 冻结档位）', async () => {
    const db = createMemoryAppDb()
    seedLlmConfig(db, [makeModel({ id: 'm', name: 'deepseek-chat' })])
    const session = createSession(db, { name: 's', model: 'deepseek-chat', thinkingEffort: 'low' })

    const frozen = await resolveTrustedTurnExecutionConfig(db, session.id, 'desktop')
    expect(frozen.thinkingEffort).toBe('low')
    expect(frozen.requestedThinkingEffort).toBeUndefined()
  })

  it('视觉路由换模型后按目标模型能力降级（§9：按切换后的目标模型重新解析）', async () => {
    const db = createMemoryAppDb()
    seedLlmConfig(db, [
      makeModel({ id: 'text', name: 'deepseek-chat' }),
      makeModel({ id: 'vision', name: 'deepseek-vl', isVision: true, supportsThinking: false })
    ])
    setConfigValue(db, 'config.preferredVisionModelId', 'vision')
    const session = createSession(db, { name: 's', model: 'deepseek-chat' })
    setConfigValue(db, 'config.thinkingEffort', 'high')

    await expect(resolveTrustedTurnExecutionConfig(
      db,
      session.id,
      'desktop',
      { projectMemoryEnabled: true },
      { requiresVision: true }
    )).resolves.toMatchObject({ model: 'deepseek-vl', thinkingEffort: 'off' })
  })
})
