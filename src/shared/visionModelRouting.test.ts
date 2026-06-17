import { describe, expect, it } from 'vitest'
import type { AppConfig, LlmServiceProfile, ModelEntry } from './domainTypes'
import { buildChatModelOptions } from './llmModelConfig'
import {
  findVisionModelOption,
  resolveVisionModelBinding,
  resolveVisionRouteForImageSend
} from './visionModelRouting'

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

function makeService(
  overrides: Partial<LlmServiceProfile> & Pick<LlmServiceProfile, 'id' | 'name'>
): LlmServiceProfile {
  return {
    baseUrl: '',
    apiKeyPresent: true,
    supportedModelIds: [],
    ...overrides
  }
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const models: ModelEntry[] = [
    makeModel({ id: '1', name: 'deepseek-v4-pro' }),
    makeModel({ id: '2', name: 'deepseek-v4-flash', isFast: true }),
    makeModel({ id: '3', name: 'kimi-k2.6', isVision: true }),
    makeModel({ id: '4', name: 'claude-haiku-4-5', isFast: true, isVision: true })
  ]
  const services: LlmServiceProfile[] = [
    makeService({ id: 's1', name: 'Deep', supportedModelIds: ['1', '2'] }),
    makeService({ id: 's2', name: 'Volcano', supportedModelIds: ['1', '3', '4'] })
  ]
  return {
    locale: 'zh-CN',
    apiKeyPresent: true,
    baseUrl: '',
    llmServices: services,
    activeLlmServiceId: 's2',
    activeLlmServiceIds: ['s2'],
    preferredLanguageModelId: '1',
    preferredFastLanguageModelId: '2',
    preferredVisionModelId: '',
    model: 'deepseek-v4-pro',
    defaultModel: 'deepseek-v4-pro',
    models,
    thinkingEnabled: false,
    workDir: '',
    maxParallelChatSessions: 3,
    tools: { enabled: false, confirmMode: 'diff', allowedTools: [], deniedTools: [], pythonPath: 'python', scriptTimeout: 300, fileCheckpointingEnabled: true, maxFileSnapshots: 100, grepTimeoutSec: 60 },
    skills: { enabled: false, autoRoute: false, scanIntervalSec: 300 },
    wiki: { enabled: false },
    feishu: { enabled: false },
    browser: { enabled: false, env: 'LOCAL', allowedDomains: [], trustedDomains: [], allowHttp: true, headless: true, stagehandModel: '', reuseActiveLlmProfile: true, actionTimeoutSec: 90, idleTimeoutSec: 1800, maxOutputChars: 50000, maxInferencesPerRequest: 8, navigateRequiresConfirm: true, actRequiresConfirm: true, deniedActions: [], allowRemoteSessions: false, captureSubdir: 'browser-captures', rateLimitEnabled: true, rateLimitMinIntervalMs: 1000, rateLimitPerMinute: 20, rateLimitPerHour: 200, rateLimitPerDomainPerMinute: 10, rateLimitMode: 'wait', rateLimitMaxWaitSec: 30 },
    shell: { enabled: false, defaultShell: '', rules: [], trustedCommands: [], scrollbackLines: 5000, maxOutputChars: 50000, confirmOutsideWorkDir: true, confirmHighRisk: true },
    ...overrides
  } as AppConfig
}

describe('resolveVisionModelBinding', () => {
  it('returns null when no enabled vision model is available in chat options', () => {
    const cfg = makeConfig({
      models: [
        makeModel({ id: '1', name: 'deepseek-v4-pro' }),
        makeModel({ id: '2', name: 'deepseek-v4-flash', isFast: true })
      ],
      activeLlmServiceIds: ['s1']
    })
    const options = buildChatModelOptions(cfg.models, cfg.llmServices, cfg.activeLlmServiceIds ?? [])
    expect(resolveVisionModelBinding(cfg, options)).toBeNull()
  })

  it('binds preferred vision model when configured and available', () => {
    const cfg = makeConfig({ preferredVisionModelId: '4' })
    const options = buildChatModelOptions(cfg.models, cfg.llmServices, cfg.activeLlmServiceIds ?? [])
    const binding = resolveVisionModelBinding(cfg, options)
    expect(binding).not.toBeNull()
    expect(binding!.modelName).toBe('claude-haiku-4-5')
    expect(binding!.llmServiceId).toBe('s2')
    expect(binding!.model.id).toBe('4')
  })

  it('falls back when preferred vision model is disabled', () => {
    const cfg = makeConfig({
      preferredVisionModelId: '4',
      models: [
        makeModel({ id: '1', name: 'deepseek-v4-pro' }),
        makeModel({ id: '3', name: 'kimi-k2.6', isVision: true }),
        makeModel({ id: '4', name: 'claude-haiku-4-5', isFast: true, isVision: true, enabled: false })
      ]
    })
    const options = buildChatModelOptions(cfg.models, cfg.llmServices, cfg.activeLlmServiceIds ?? [])
    const binding = resolveVisionModelBinding(cfg, options)
    expect(binding).not.toBeNull()
    expect(binding!.modelName).toBe('kimi-k2.6')
    expect(binding!.model.id).toBe('3')
  })

  it('resolves when the same vision model exists on multiple active services', () => {
    const cfg = makeConfig({
      activeLlmServiceIds: ['s1', 's2'],
      llmServices: [
        makeService({ id: 's1', name: 'Deep', supportedModelIds: ['1', '2', '3'] }),
        makeService({ id: 's2', name: 'Volcano', supportedModelIds: ['1', '3', '4'] })
      ]
    })
    const options = buildChatModelOptions(cfg.models, cfg.llmServices, cfg.activeLlmServiceIds ?? [])
    const binding = resolveVisionModelBinding(cfg, options)
    expect(binding).not.toBeNull()
    expect(binding!.modelName).toBe('kimi-k2.6')
    expect(binding!.llmServiceId).toBe('s1')
  })

  it('findVisionModelOption prefers earlier active service when names collide', () => {
    const cfg = makeConfig({
      activeLlmServiceIds: ['s1', 's2'],
      llmServices: [
        makeService({ id: 's1', name: 'Deep', supportedModelIds: ['1', '2', '3'] }),
        makeService({ id: 's2', name: 'Volcano', supportedModelIds: ['1', '3', '4'] })
      ]
    })
    const options = buildChatModelOptions(cfg.models, cfg.llmServices, cfg.activeLlmServiceIds ?? [])
    const matched = findVisionModelOption(options, 'kimi-k2.6', cfg.activeLlmServiceIds ?? [])
    expect(matched?.serviceId).toBe('s1')
  })
})

describe('resolveVisionRouteForImageSend', () => {
  it('allows send when session already uses an available vision model', () => {
    const cfg = makeConfig()
    const route = resolveVisionRouteForImageSend(cfg, 'kimi-k2.6', 's2')
    expect(route).toEqual({
      ok: true,
      switched: false,
      modelName: 'kimi-k2.6',
      llmServiceId: 's2',
      displayName: 'Volcano-kimi-k2.6'
    })
  })

  it('switches to preferred vision model when session uses a language model', () => {
    const cfg = makeConfig({ preferredVisionModelId: '4' })
    const route = resolveVisionRouteForImageSend(cfg, 'deepseek-v4-pro', 's2')
    expect(route.ok).toBe(true)
    if (route.ok) {
      expect(route.switched).toBe(true)
      expect(route.modelName).toBe('claude-haiku-4-5')
      expect(route.llmServiceId).toBe('s2')
    }
  })

  it('returns ok:false when no vision model is available', () => {
    const cfg = makeConfig({
      models: [
        makeModel({ id: '1', name: 'deepseek-v4-pro' }),
        makeModel({ id: '2', name: 'deepseek-v4-flash', isFast: true })
      ],
      activeLlmServiceIds: ['s1']
    })
    expect(resolveVisionRouteForImageSend(cfg, 'deepseek-v4-pro', 's1')).toEqual({ ok: false })
  })
})
