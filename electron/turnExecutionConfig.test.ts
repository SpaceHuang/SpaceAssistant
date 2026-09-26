import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from './database/testHelpers'
import { createSession, getSession, setConfigValue, type AppDatabase } from './database'
import { resolveTrustedTurnExecutionConfig, resolveThinkingEffort } from './turnExecutionConfig'
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

/** 造一份「模型列表 + 可用服务 + 已存 Key」的完整配置，供可信快照解析使用 */
function seedLlmConfig(
  db: AppDatabase,
  models: ModelEntry[],
  options: { preferredLanguageModelId?: string; keyPresent?: boolean; serviceId?: string } = {}
): void {
  const serviceId = options.serviceId ?? SERVICE_ID
  setConfigValue(db, 'config.models', JSON.stringify(models))
  setConfigValue(db, 'config.llmServices', JSON.stringify([
    {
      id: serviceId,
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.example/v1',
      supportedModelIds: models.map((m) => m.id),
      createdAt: '1',
      updatedAt: '1'
    }
  ]))
  setConfigValue(db, 'config.activeLlmServiceIds', JSON.stringify([serviceId]))
  if (options.preferredLanguageModelId) setConfigValue(db, 'config.preferredLanguageModelId', options.preferredLanguageModelId)
  if (options.keyPresent !== false) {
    setConfigValue(db, 'secrets.llmServiceKeys', JSON.stringify({ [serviceId]: 'enc:sk-test' }))
  }
}

describe('resolveTrustedTurnExecutionConfig', () => {
  it.each(['desktop', 'feishu', 'wechat'] as const)('%s 从同一可信 session 配置生成规范化快照', async (lane) => {
    const db = createMemoryAppDb()
    seedLlmConfig(db, [makeModel({ id: 'text', name: 'deepseek-chat' })])
    const session = createSession(db, { name: lane, model: 'deepseek-chat', maxTokens: 8192 })
    setConfigValue(db, 'config.thinkingEnabled', 'false')
    setConfigValue(db, 'config.locale', 'zh-CN')

    await expect(resolveTrustedTurnExecutionConfig(db, session.id, lane)).resolves.toMatchObject({
      lane, model: 'deepseek-chat', maxTokens: 8192, enableThinking: false, locale: 'zh-CN'
    })
  })

  it('拒绝不存在的 session，不接受调用方伪造网络配置', async () => {
    const db = createMemoryAppDb()
    await expect(resolveTrustedTurnExecutionConfig(db, 'missing', 'desktop')).rejects.toThrow('TURN_SESSION_NOT_FOUND')
  })

  it('带图 turn 在 prepare 阶段从主进程配置冻结视觉模型绑定', async () => {
    const db = createMemoryAppDb()
    seedLlmConfig(db, [
      makeModel({ id: 'text', name: 'deepseek-chat' }),
      makeModel({ id: 'vision', name: 'kimi-k2.7-code', isVision: true })
    ], { preferredLanguageModelId: 'text' })
    const session = createSession(db, { name: 'vision', model: 'deepseek-chat', maxTokens: 8192 })
    setConfigValue(db, 'config.preferredVisionModelId', 'vision')

    await expect(resolveTrustedTurnExecutionConfig(
      db,
      session.id,
      'desktop',
      { projectMemoryEnabled: true },
      { requiresVision: true }
    )).resolves.toMatchObject({
      model: 'kimi-k2.7-code',
      llmServiceId: SERVICE_ID,
      effectiveModelForUsage: 'kimi-k2.7-code'
    })
  })

  it('会话上的旧内置模型名先归一到当前名，并回写 session', async () => {
    const db = createMemoryAppDb()
    seedLlmConfig(db, [makeModel({ id: '5', name: 'deepseek-flash', isFast: true })], { preferredLanguageModelId: '5' })
    const session = createSession(db, { name: 'legacy-name', model: 'deepseek-v4-flash' })

    await expect(resolveTrustedTurnExecutionConfig(db, session.id, 'desktop')).resolves.toMatchObject({
      model: 'deepseek-flash',
      llmServiceId: SERVICE_ID
    })
    expect(getSession(db, session.id)?.model).toBe('deepseek-flash')
  })

  it('装配时保留显式 supportsThinking false 并将请求档位降为 off', async () => {
    const db = createMemoryAppDb()
    seedLlmConfig(db, [makeModel({ id: 'gpt', name: 'gpt-5.5', supportsThinking: false })], { preferredLanguageModelId: 'gpt' })
    const session = createSession(db, { name: 'no-thinking', model: 'gpt-5.5' })
    await expect(resolveTrustedTurnExecutionConfig(db, session.id, 'desktop')).resolves.toMatchObject({ thinkingEffort: 'off' })
    expect(resolveThinkingEffort('high', null, makeModel({ id: 'custom', name: 'custom', supportsThinking: false }))).toBe('off')
  })

  it('模型已下架时重绑当前优选模型并回写 session，而不是让该会话永久失败', async () => {
    const db = createMemoryAppDb()
    seedLlmConfig(db, [
      makeModel({ id: '4', name: 'deepseek-v4-pro' }),
      makeModel({ id: '5', name: 'deepseek-flash', isFast: true })
    ], { preferredLanguageModelId: '5' })
    const session = createSession(db, { name: 'dead-model', model: 'claude-sonnet-4-20250514' })

    await expect(resolveTrustedTurnExecutionConfig(db, session.id, 'desktop')).resolves.toMatchObject({
      model: 'deepseek-flash'
    })
    const stored = getSession(db, session.id)
    expect(stored?.model).toBe('deepseek-flash')
    expect(stored?.llmServiceId).toBe(SERVICE_ID)
  })

  it('无任何可用模型时 fail-fast，不产出可发往默认端点的半成品配置', async () => {
    const db = createMemoryAppDb()
    const session = createSession(db, { name: 'no-model', model: 'claude-sonnet-4-20250514' })

    await expect(resolveTrustedTurnExecutionConfig(db, session.id, 'desktop'))
      .rejects.toThrow('会话模型「claude-sonnet-4-20250514」当前不可用')
  })

  it('带图 turn 的视觉路由凭据不可用时不重绑、不改写会话绑定，直接以视觉模型报错', async () => {
    const db = createMemoryAppDb()
    seedLlmConfig(db, [
      makeModel({ id: 'text', name: 'deepseek-chat' }),
      makeModel({ id: 'vision', name: 'kimi-k2.7-code', isVision: true })
    ], { preferredLanguageModelId: 'text' })
    // 视觉模型只由「没有 Key」的服务提供：视觉路由存在（options 不校验 Key），但凭据解析必失败。
    setConfigValue(db, 'config.llmServices', JSON.stringify([
      {
        id: SERVICE_ID,
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.example/v1',
        supportedModelIds: ['text'],
        createdAt: '1',
        updatedAt: '1'
      },
      {
        id: 'svc-vision-no-key',
        name: 'Vision',
        baseUrl: 'https://api.vision.example/v1',
        supportedModelIds: ['vision'],
        createdAt: '1',
        updatedAt: '1'
      }
    ]))
    setConfigValue(db, 'config.activeLlmServiceIds', JSON.stringify([SERVICE_ID, 'svc-vision-no-key']))
    setConfigValue(db, 'config.preferredVisionModelId', 'vision')
    const session = createSession(db, { name: 'vision-no-key', model: 'kimi-k2.7-code' })

    await expect(resolveTrustedTurnExecutionConfig(db, session.id, 'desktop', {}, { requiresVision: true }))
      .rejects.toThrow('视觉模型「kimi-k2.7-code」当前不可用')
    // 会话模型本身没问题，不能被一次视觉配置事故改写成 language 优选文本模型
    const stored = getSession(db, session.id)
    expect(stored?.model).toBe('kimi-k2.7-code')
    expect(stored?.llmServiceId).toBeUndefined()
  })

  it('会话模型正常的文本会话发图时，视觉路由凭据不可用也不会把会话模型改写成文本回退', async () => {
    const db = createMemoryAppDb()
    seedLlmConfig(db, [
      makeModel({ id: 'text', name: 'deepseek-chat' }),
      makeModel({ id: 'vision', name: 'kimi-k2.7-code', isVision: true })
    ], { preferredLanguageModelId: 'text' })
    setConfigValue(db, 'config.llmServices', JSON.stringify([
      {
        id: SERVICE_ID,
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.example/v1',
        supportedModelIds: ['text'],
        createdAt: '1',
        updatedAt: '1'
      },
      {
        id: 'svc-vision-no-key',
        name: 'Vision',
        baseUrl: 'https://api.vision.example/v1',
        supportedModelIds: ['vision'],
        createdAt: '1',
        updatedAt: '1'
      }
    ]))
    setConfigValue(db, 'config.activeLlmServiceIds', JSON.stringify([SERVICE_ID, 'svc-vision-no-key']))
    setConfigValue(db, 'config.preferredVisionModelId', 'vision')
    // 会话模型是完好的文本模型：出问题的只是视觉路由的凭据
    const session = createSession(db, { name: 'text-with-image', model: 'deepseek-chat' })

    await expect(resolveTrustedTurnExecutionConfig(db, session.id, 'desktop', {}, { requiresVision: true }))
      .rejects.toThrow('视觉模型「kimi-k2.7-code」当前不可用')
    const stored = getSession(db, session.id)
    expect(stored?.model).toBe('deepseek-chat')
    expect(stored?.llmServiceId).toBeUndefined()
  })
})
