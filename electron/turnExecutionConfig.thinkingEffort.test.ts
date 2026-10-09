import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from './database/testHelpers'
import { createSession, getConfigValue, getDbConnection, setConfigValue, updateSession, type AppDatabase } from './database'
import { resolvePinnedAutomationTurnExecutionConfig as resolvePinnedAutomationTurnExecutionConfigWithQueries, resolveThinkingEffort, resolveTrustedTurnExecutionConfig as resolveTrustedTurnExecutionConfigWithQueries } from './turnExecutionConfig'
import type { ModelEntry } from '../src/shared/domainTypes'
import { createSqliteSessionStorage } from './sessionStorage/sqliteSessionStorage'

vi.mock('./agentLogger/agentLogger', () => ({ logAgentEvent: vi.fn() }))
vi.mock('./secureApiKey', () => ({ isSecretStorageAvailable: vi.fn(() => true), decryptSecret: vi.fn((value: string) => value.replace(/^enc:/, '')) }))

const SERVICE_ID = 'svc-deepseek'

function resolveTrustedTurnExecutionConfig(db: AppDatabase, sessionId: string, lane: Parameters<typeof resolveTrustedTurnExecutionConfigWithQueries>[4], derived?: Parameters<typeof resolveTrustedTurnExecutionConfigWithQueries>[5], options?: Parameters<typeof resolveTrustedTurnExecutionConfigWithQueries>[6]) {
  const storage = createSqliteSessionStorage(db)
  return resolveTrustedTurnExecutionConfigWithQueries(db, storage.queries, storage.commands, sessionId, lane, derived, options)
}

function resolvePinnedAutomationTurnExecutionConfig(db: AppDatabase, sessionId: string, snapshot: Parameters<typeof resolvePinnedAutomationTurnExecutionConfigWithQueries>[3]) {
  return resolvePinnedAutomationTurnExecutionConfigWithQueries(db, createSqliteSessionStorage(db).queries, sessionId, snapshot)
}

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
  it('IM 显式远程模型及 Thinking 设置决定待冻结配置，不读取会话/桌面模型与 Thinking', async () => {
    const db = createMemoryAppDb()
    const original = makeModel({ id: 'm', name: 'deepseek-chat' })
    const remote = makeModel({ id: 'remote-model', name: 'deepseek-flash' })
    seedLlmConfig(db, [original, remote])
    const session = createSession(db, { name: 'remote-settings', model: original.name, thinkingEffort: 'high' })
    setConfigValue(db, 'config.preferredLanguageModelId', original.id)
    setConfigValue(db, 'config.feishu', JSON.stringify({ remoteModelSelectionMode: 'explicit', remoteDefaultModelId: remote.id, remoteThinkingEffort: 'low' }))
    setConfigValue(db, 'config.thinkingEffort', 'high')

    await expect(resolveTrustedTurnExecutionConfig(db, session.id, 'feishu')).resolves.toMatchObject({
      model: remote.name,
      llmServiceId: SERVICE_ID,
      thinkingEffort: 'low'
    })
  })

  it('旧会话模型名迁移不能覆盖远程显式选择的模型', async () => {
    const db = createMemoryAppDb()
    const legacy = makeModel({ id: 'legacy', name: 'deepseek-v4-flash' })
    const selected = makeModel({ id: 'selected', name: 'deepseek-chat' })
    seedLlmConfig(db, [legacy, selected])
    const session = createSession(db, { name: 'remote-legacy-session', model: legacy.name, llmServiceId: SERVICE_ID })
    setConfigValue(db, 'config.preferredLanguageModelId', legacy.id)
    setConfigValue(db, 'config.feishu', JSON.stringify({ remoteModelSelectionMode: 'explicit', remoteDefaultModelId: selected.id, remoteThinkingEffort: 'low' }))

    await expect(resolveTrustedTurnExecutionConfig(db, session.id, 'feishu')).resolves.toMatchObject({
      model: selected.name,
      llmServiceId: SERVICE_ID
    })
    expect(createSqliteSessionStorage(db).queries.readSession(session.id)?.model).toBe(selected.name)
  })

  it('显式远程模型不可用时不回退到桌面默认模型', async () => {
    const db = createMemoryAppDb()
    const model = makeModel({ id: 'm', name: 'deepseek-chat' })
    seedLlmConfig(db, [model])
    const session = createSession(db, { name: 'remote-invalid-model', model: model.name })
    setConfigValue(db, 'config.preferredLanguageModelId', model.id)
    setConfigValue(db, 'config.feishu', JSON.stringify({ remoteModelSelectionMode: 'explicit', remoteDefaultModelId: 'removed-model', remoteThinkingEffort: 'low' }))

    await expect(resolveTrustedTurnExecutionConfig(db, session.id, 'feishu')).rejects.toThrow('REMOTE_EXPLICIT_MODEL_UNAVAILABLE')
  })

  it('继承模式始终使用当前可用的优选语言模型，并同步 IM 会话绑定', async () => {
    const db = createMemoryAppDb()
    const previous = makeModel({ id: 'previous', name: 'deepseek-chat' })
    const preferred = makeModel({ id: 'preferred', name: 'deepseek-flash' })
    seedLlmConfig(db, [previous, preferred])
    setConfigValue(db, 'config.llmServices', JSON.stringify([
      { id: SERVICE_ID, name: 'DeepSeek', baseUrl: 'https://api.deepseek.example/v1', supportedModelIds: [previous.id, preferred.id] },
      { id: 'svc-other', name: 'Other', baseUrl: 'https://api.other.example/v1', supportedModelIds: [preferred.id] }
    ]))
    setConfigValue(db, 'config.activeLlmServiceIds', JSON.stringify([SERVICE_ID, 'svc-other']))
    setConfigValue(db, 'secrets.llmServiceKeys', JSON.stringify({ [SERVICE_ID]: 'enc:sk-test', 'svc-other': 'enc:sk-other' }))
    const session = createSession(db, { name: 'remote-inherit', model: previous.name, llmServiceId: SERVICE_ID })
    setConfigValue(db, 'config.preferredLanguageModelId', preferred.id)
    setConfigValue(db, 'config.feishu', JSON.stringify({ remoteModelSelectionMode: 'inherit', remoteDefaultModelId: previous.id, remoteThinkingEffort: 'low' }))

    const frozen = await resolveTrustedTurnExecutionConfig(db, session.id, 'feishu')
    expect(frozen).toMatchObject({ model: preferred.name, llmServiceId: SERVICE_ID, thinkingEffort: 'low' })
    expect(createSqliteSessionStorage(db).queries.readSession(session.id)).toMatchObject({ model: preferred.name, llmServiceId: SERVICE_ID })
  })

  it('冻结前原会话服务失效时，为远程模型选择另一个可用服务', async () => {
    const db = createMemoryAppDb()
    const remote = makeModel({ id: 'remote', name: 'deepseek-flash' })
    seedLlmConfig(db, [remote])
    setConfigValue(db, 'config.llmServices', JSON.stringify([
      { id: 'svc-removed', name: 'Removed', baseUrl: 'https://removed.example/v1', supportedModelIds: [remote.id] },
      { id: 'svc-available', name: 'Available', baseUrl: 'https://available.example/v1', supportedModelIds: [remote.id] }
    ]))
    setConfigValue(db, 'config.activeLlmServiceIds', JSON.stringify(['svc-available']))
    setConfigValue(db, 'secrets.llmServiceKeys', JSON.stringify({ 'svc-available': 'enc:sk-available' }))
    const session = createSession(db, { name: 'remote-before-freeze', model: remote.name, llmServiceId: 'svc-removed' })
    setConfigValue(db, 'config.preferredLanguageModelId', remote.id)
    setConfigValue(db, 'config.feishu', JSON.stringify({ remoteModelSelectionMode: 'explicit', remoteDefaultModelId: remote.id, remoteThinkingEffort: 'low' }))

    await expect(resolveTrustedTurnExecutionConfig(db, session.id, 'feishu')).resolves.toMatchObject({
      model: remote.name,
      llmServiceId: 'svc-available'
    })
    expect(createSqliteSessionStorage(db).queries.readSession(session.id)?.llmServiceId).toBe('svc-available')
  })

  it('显式远程模型冻结前没有任何可用服务时明确失败，不静默换默认模型', async () => {
    const db = createMemoryAppDb()
    const desktop = makeModel({ id: 'desktop', name: 'deepseek-chat' })
    const remote = makeModel({ id: 'remote', name: 'deepseek-flash' })
    seedLlmConfig(db, [desktop, remote])
    setConfigValue(db, 'config.llmServices', JSON.stringify([
      { id: SERVICE_ID, name: 'DeepSeek', baseUrl: 'https://api.deepseek.example/v1', supportedModelIds: [desktop.id] }
    ]))
    const session = createSession(db, { name: 'remote-no-provider', model: desktop.name })
    setConfigValue(db, 'config.preferredLanguageModelId', desktop.id)
    setConfigValue(db, 'config.feishu', JSON.stringify({ remoteModelSelectionMode: 'explicit', remoteDefaultModelId: remote.id, remoteThinkingEffort: 'low' }))

    await expect(resolveTrustedTurnExecutionConfig(db, session.id, 'feishu')).rejects.toThrow('REMOTE_EXPLICIT_MODEL_UNAVAILABLE')
  })

  it('首次解析任一渠道时先用飞书历史值归一两渠道公共配置', async () => {
    const db = createMemoryAppDb()
    const modelA = makeModel({ id: 'model-a', name: 'deepseek-chat' })
    const modelB = makeModel({ id: 'model-b', name: 'deepseek-flash' })
    seedLlmConfig(db, [modelA, modelB])
    setConfigValue(db, 'config.preferredLanguageModelId', modelA.id)
    setConfigValue(db, 'config.feishu', JSON.stringify({ remoteDefaultModelId: modelA.id }))
    setConfigValue(db, 'config.wechat', JSON.stringify({ remoteDefaultModelId: modelB.id }))
    const feishuSession = createSession(db, { name: 'first-feishu-turn', model: modelA.name })
    const wechatSession = createSession(db, { name: 'first-wechat-turn', model: modelB.name })

    const feishu = await resolveTrustedTurnExecutionConfig(db, feishuSession.id, 'feishu')
    const wechat = await resolveTrustedTurnExecutionConfig(db, wechatSession.id, 'wechat')

    expect(feishu.model).toBe(modelA.name)
    expect(wechat.model).toBe(modelA.name)
    expect(getConfigValue(db, 'config.remoteImModelConfigVersion')).toBe('1')
  })

  it('两渠道迁移任一写入失败时阻止 IM 回合配置解析且不提交迁移标记', async () => {
    const db = createMemoryAppDb()
    const model = makeModel({ id: 'model-a', name: 'deepseek-chat' })
    seedLlmConfig(db, [model])
    const session = createSession(db, { name: 'migration-write-failure', model: model.name })
    setConfigValue(db, 'config.feishu', JSON.stringify({ remoteDefaultModelId: model.id }))
    setConfigValue(db, 'config.wechat', JSON.stringify({ remoteDefaultModelId: model.id }))
    getDbConnection(db).exec("CREATE TRIGGER fail_remote_wechat_model_config BEFORE UPDATE ON configs WHEN NEW.key = 'config.wechat' BEGIN SELECT RAISE(ABORT, 'write failed'); END")

    await expect(resolveTrustedTurnExecutionConfig(db, session.id, 'feishu')).rejects.toThrow('write failed')
    expect(getConfigValue(db, 'config.remoteImModelConfigVersion')).toBeUndefined()
  })

  it('远程请求 low 被模型基线排除时冻结有效档位并保留降级来源', async () => {
    const db = createMemoryAppDb()
    const model = makeModel({ id: 'm', name: 'deepseek-v4-pro', thinkingLevelMap: { off: 'off', low: null, medium: 'medium', high: 'high' } })
    seedLlmConfig(db, [model])
    const session = createSession(db, { name: 'remote-thinking-degrade', model: model.name })
    setConfigValue(db, 'config.preferredLanguageModelId', model.id)
    setConfigValue(db, 'config.feishu', JSON.stringify({ remoteModelSelectionMode: 'inherit', remoteThinkingEffort: 'low' }))

    await expect(resolveTrustedTurnExecutionConfig(db, session.id, 'feishu')).resolves.toMatchObject({
      thinkingEffort: 'off',
      requestedThinkingEffort: 'low'
    })
  })

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
      sessionStorage: createSqliteSessionStorage(db),
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
      makeModel({ id: 'vision', name: 'kimi-k2.7-code', isVision: true, supportsThinking: false })
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
    )).resolves.toMatchObject({ model: 'kimi-k2.7-code', thinkingEffort: 'off' })
  })
})

describe('resolvePinnedAutomationTurnExecutionConfig', () => {
  it('固定 model ID/service/effort，不受桌面默认值变化影响', async () => {
    const db = createMemoryAppDb()
    const model = makeModel({ id: 'catalog-a', name: 'same-provider-name', supportsThinking: true })
    seedLlmConfig(db, [model])
    const session = createSession(db, { name: 'automation', model: model.name, llmServiceId: SERVICE_ID, thinkingEffort: 'high', ownership: 'automation' })
    setConfigValue(db, 'config.defaultModel', 'desktop-other')
    setConfigValue(db, 'config.thinkingEffort', 'low')
    const snapshot = { resolutionStatus: 'resolved' as const, modelId: model.id, providerModelName: model.name, serviceId: SERVICE_ID, requestedEffort: 'high' as const, effectiveEffort: 'high' as const }
    await expect(resolvePinnedAutomationTurnExecutionConfig(db, session.id, snapshot)).resolves.toMatchObject({ lane: 'automation', model: model.name, llmServiceId: SERVICE_ID, thinkingEffort: 'high', requestedThinkingEffort: 'high' })
    db.close()
  })

  it('pair 被撤销后 fail-closed，不改 session', async () => {
    const db = createMemoryAppDb()
    const model = makeModel({ id: 'catalog-a', name: 'same-provider-name', supportsThinking: true })
    seedLlmConfig(db, [model])
    const session = createSession(db, { name: 'automation', model: model.name, llmServiceId: SERVICE_ID, thinkingEffort: 'high', ownership: 'automation' })
    setConfigValue(db, 'config.activeLlmServiceIds', '[]')
    await expect(resolvePinnedAutomationTurnExecutionConfig(db, session.id, { resolutionStatus: 'resolved', modelId: model.id, providerModelName: model.name, serviceId: SERVICE_ID, requestedEffort: 'high', effectiveEffort: 'high' })).rejects.toThrow(/AUTOMATION_SERVICE_CONFIG_INVALID/)
    expect((await import('./database')).getSession(db, session.id)).toMatchObject({ model: model.name, llmServiceId: SERVICE_ID, thinkingEffort: 'high' })
    db.close()
  })
})
