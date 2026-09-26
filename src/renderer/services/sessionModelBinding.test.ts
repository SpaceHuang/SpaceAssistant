import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../../shared/domainTypes'
import { normalizeModelEntry } from '../../shared/llmModelConfig'
import { resolveSessionModelBinding, resolveSessionThinkingBinding, listChatModelOptions } from './sessionModelBinding'

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const models = [
    normalizeModelEntry({ id: '1', name: 'deepseek-v4-pro' }),
    normalizeModelEntry({ id: '2', name: 'deepseek-flash', isFast: true }),
    normalizeModelEntry({ id: '3', name: 'kimi-k2.7-code' }),
    normalizeModelEntry({ id: '4', name: 'glm-5.3' })
  ]
  const proId = models.find((m) => m.name === 'deepseek-v4-pro')!.id
  return {
    locale: 'zh-CN',
    apiKeyPresent: true,
    baseUrl: '',
    llmServices: [
      {
        id: 's1',
        name: 'Default',
        baseUrl: '',
        apiKeyPresent: true,
        supportedModelIds: models.map((m) => m.id)
      }
    ],
    activeLlmServiceId: 's1',
    activeLlmServiceIds: ['s1'],
    model: 'deepseek-v4-pro',
    defaultModel: 'deepseek-v4-pro',
    preferredLanguageModelId: proId,
    preferredFastLanguageModelId: models.find((m) => m.name === 'deepseek-flash')!.id,
    preferredVisionModelId: models.find((m) => m.name === 'kimi-k2.7-code')!.id,
    models,
    thinkingEnabled: true,
    workDir: '/tmp',
    workDirProfiles: [],
    activeWorkDirProfileId: 'default',
    maxParallelChatSessions: 3,
    tools: { enabled: true, deniedTools: [], allowedTools: [], pythonPath: 'python', scriptTimeout: 300, fileCheckpointingEnabled: true, maxFileSnapshots: 100, grepTimeoutSec: 60 },
    skills: { routing: { mode: 'llm', enabled: true, model: '', timeoutMs: 15000, includeTriggersInCatalog: false }, alwaysLoad: [] },
    wiki: { enabled: false, rootPath: 'llm-wiki' },
    feishu: { enabled: false },
    browser: { enabled: true, trustedDomains: [], allowedDomains: [] },
    shell: { enabled: true, trustedCommands: [] },
    ...overrides
  } as AppConfig
}

describe('sessionModelBinding', () => {
  it('uses session model when binding is valid', () => {
    const cfg = makeConfig()
    const binding = resolveSessionModelBinding(cfg, {
      id: '1',
      name: 'Test',
      preview: '',
      model: 'deepseek-flash',
      llmServiceId: 's1',
      temperature: 0.7,
      maxTokens: 4096,
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
      skillsState: { loaded: [], disabled: [] },
      metadata: {},
      schemaVersion: 1
    })
    expect(binding.modelName).toBe('deepseek-flash')
    expect(binding.displayName).toBe('Default-deepseek-flash')
  })

  it('falls back to language preferred for new sessions', () => {
    const cfg = makeConfig()
    const binding = resolveSessionModelBinding(cfg, undefined)
    expect(binding.modelName).toBe('deepseek-v4-pro')
  })

  it('keeps a model selected before the first session is created', () => {
    const cfg = makeConfig()
    const option = listChatModelOptions(cfg).find((item) => item.modelName === 'deepseek-flash')!
    const binding = resolveSessionModelBinding(cfg, undefined, option)
    expect(binding.modelName).toBe('deepseek-flash')
    expect(binding.llmServiceId).toBe('s1')
    expect(binding.displayName).toBe('Default-deepseek-flash')
  })

  it('lists service-prefixed display names for all options', () => {
    const proId = makeConfig().models!.find((m) => m.name === 'deepseek-v4-pro')!.id
    const cfg = makeConfig({
      llmServices: [
        { id: 's1', name: 'Deep', baseUrl: '', apiKeyPresent: true, supportedModelIds: [proId] },
        { id: 's2', name: 'Volcano', baseUrl: '', apiKeyPresent: true, supportedModelIds: [proId] }
      ],
      activeLlmServiceIds: ['s1', 's2']
    })
    const options = listChatModelOptions(cfg)
    expect(options.filter((o) => o.modelName === 'deepseek-v4-pro').map((o) => o.displayName).sort()).toEqual([
      'Deep-deepseek-v4-pro',
      'Volcano-deepseek-v4-pro'
    ])
  })

  it('prefixes single-service options as well', () => {
    const cfg = makeConfig()
    const options = listChatModelOptions(cfg)
    expect(options.find((o) => o.modelName === 'glm-5.3')?.displayName).toBe('Default-glm-5.3')
  })
})


describe('resolveSessionThinkingBinding（§4.2 两层解析 + §5.2 草稿保持）', () => {
  function makeSession(overrides: Record<string, unknown> = {}): AppConfig['models'] extends never ? never : Parameters<typeof resolveSessionThinkingBinding>[1] {
    return {
      id: 's1',
      name: 'Test',
      preview: '',
      model: 'deepseek-v4-pro',
      temperature: 0.7,
      maxTokens: 4096,
      createdAt: 1,
      updatedAt: 1,
      messageCount: 0,
      skillsState: { loaded: [], disabled: [] },
      metadata: {},
      schemaVersion: 5,
      ...overrides
    } as never
  }

  it('无会话、无草稿 → 继承全局默认（overridden=false）', () => {
    const cfg = makeConfig({ thinkingEffort: 'medium' })
    const b = resolveSessionThinkingBinding(cfg, undefined)
    expect(b).toEqual({ effort: 'medium', overridden: false, globalEffort: 'medium' })
  })

  it('composer 在首个会话创建前选择档位 → 草稿生效（创建时带入）', () => {
    const cfg = makeConfig({ thinkingEffort: 'medium' })
    const b = resolveSessionThinkingBinding(cfg, undefined, 'low')
    expect(b).toEqual({ effort: 'low', overridden: true, globalEffort: 'medium' })
  })

  it('会话覆盖优先于全局（§9：全局 off + 会话 high → high）', () => {
    const cfg = makeConfig({ thinkingEffort: 'off' })
    const b = resolveSessionThinkingBinding(cfg, makeSession({ thinkingEffort: 'high' }))
    expect(b).toEqual({ effort: 'high', overridden: true, globalEffort: 'off' })
  })

  it('会话无覆盖 → 继承全局；全局改动后未覆盖会话跟着变（继承非快照，§4.2）', () => {
    const session = makeSession()
    const before = resolveSessionThinkingBinding(makeConfig({ thinkingEffort: 'high' }), session)
    const after = resolveSessionThinkingBinding(makeConfig({ thinkingEffort: 'low' }), session)
    expect(before.effort).toBe('high')
    expect(after.effort).toBe('low')
    expect(before.overridden).toBe(false)
  })

  it('已覆盖会话不受全局改动影响（覆盖优先）', () => {
    const session = makeSession({ thinkingEffort: 'low' })
    const b = resolveSessionThinkingBinding(makeConfig({ thinkingEffort: 'high' }), session)
    expect(b.effort).toBe('low')
  })

  it('会话覆盖损坏值 → 视为继承（防御）', () => {
    const cfg = makeConfig({ thinkingEffort: 'medium' })
    const b = resolveSessionThinkingBinding(cfg, makeSession({ thinkingEffort: 'xhigh' }))
    expect(b).toEqual({ effort: 'medium', overridden: false, globalEffort: 'medium' })
  })

  it('cfg.thinkingEffort 缺失（旧结构）→ 归一为 medium（内置默认）', () => {
    const cfg = makeConfig() as Partial<AppConfig> as AppConfig
    delete (cfg as { thinkingEffort?: string }).thinkingEffort
    const b = resolveSessionThinkingBinding(cfg, undefined)
    expect(b.effort).toBe('medium')
  })
})
