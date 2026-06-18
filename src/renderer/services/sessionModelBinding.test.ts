import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../../shared/domainTypes'
import { DEFAULT_MODELS } from '../../shared/domainTypes'
import { resolveSessionModelBinding, listChatModelOptions } from './sessionModelBinding'

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const models = DEFAULT_MODELS.map((m, i) => ({ id: String(i + 1), ...m }))
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
    preferredLanguageModelId: models.find((m) => m.name === 'deepseek-v4-pro')!.id,
    preferredFastLanguageModelId: models.find((m) => m.name === 'deepseek-v4-flash')!.id,
    preferredVisionModelId: models.find((m) => m.name === 'kimi-k2.6')!.id,
    models,
    thinkingEnabled: true,
    workDir: '/tmp',
    workDirProfiles: [],
    activeWorkDirProfileId: 'default',
    maxParallelChatSessions: 3,
    tools: { enabled: true, confirmMode: 'diff', deniedTools: [], allowedTools: [], pythonPath: 'python', scriptTimeout: 300, fileCheckpointingEnabled: true, maxFileSnapshots: 100, grepTimeoutSec: 60 },
    skills: { routing: { mode: 'llm', enabled: true, model: '', timeoutMs: 15000, includeTriggersInCatalog: false }, alwaysLoad: [] },
    wiki: { enabled: false, rootPath: 'llm-wiki' },
    feishu: { enabled: false },
    browser: { enabled: true, trustedDomains: [], allowedDomains: [] },
    shell: { enabled: true, trustedCommands: [], confirmMode: 'always' },
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
      model: 'deepseek-v4-flash',
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
    expect(binding.modelName).toBe('deepseek-v4-flash')
    expect(binding.displayName).toBe('Default-deepseek-v4-flash')
  })

  it('falls back to language preferred for new sessions', () => {
    const cfg = makeConfig()
    const binding = resolveSessionModelBinding(cfg, undefined)
    expect(binding.modelName).toBe('deepseek-v4-pro')
  })

  it('lists service-prefixed display names for all options', () => {
    const cfg = makeConfig({
      llmServices: [
        { id: 's1', name: 'Deep', baseUrl: '', apiKeyPresent: true, supportedModelIds: ['4'] },
        { id: 's2', name: 'Volcano', baseUrl: '', apiKeyPresent: true, supportedModelIds: ['4'] }
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
    expect(options.find((o) => o.modelName === 'glm-5.1')?.displayName).toBe('Default-glm-5.1')
  })
})
