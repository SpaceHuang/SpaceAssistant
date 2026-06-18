import { describe, expect, it } from 'vitest'
import type { LlmServiceProfile, ModelEntry } from './domainTypes'
import {
  buildChatModelOptions,
  getAvailableModels,
  migrateModelEntries,
  pruneDisabledModelsFromServices,
  resolvePreferredModelId,
  resolveServiceForModel,
  sortModelsFastFirst
} from './llmModelConfig'

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

describe('llmModelConfig', () => {
  const models: ModelEntry[] = [
    makeModel({ id: '1', name: 'deepseek-v4-pro' }),
    makeModel({ id: '2', name: 'deepseek-v4-flash', isFast: true }),
    makeModel({ id: '3', name: 'kimi-k2.6', isVision: true }),
    makeModel({ id: '4', name: 'claude-haiku-4-5', isFast: true, isVision: true })
  ]

  const services: LlmServiceProfile[] = [
    makeService({ id: 's1', name: 'Deep', supportedModelIds: ['1', '2'] }),
    makeService({ id: 's2', name: 'Volcano', supportedModelIds: ['1', '3'] })
  ]

  it('getAvailableModels returns union of active services supported models', () => {
    const available = getAvailableModels(models, services, ['s1', 's2'])
    expect(available.map((m) => m.name)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'kimi-k2.6'
    ])
  })

  it('getAvailableModels excludes disabled models', () => {
    const disabled = models.map((m) => (m.id === '3' ? { ...m, enabled: false } : m))
    const available = getAvailableModels(disabled, services, ['s1', 's2'])
    expect(available.some((m) => m.name === 'kimi-k2.6')).toBe(false)
  })

  it('sortModelsFastFirst keeps order within groups', () => {
    const sorted = sortModelsFastFirst(models)
    expect(sorted[0]!.isFast).toBe(true)
    expect(sorted[1]!.isFast).toBe(true)
  })

  it('migrateModelEntries fills isVision from builtin table', () => {
    const migrated = migrateModelEntries([
      makeModel({ id: 'x', name: 'kimi-k2.6', isVision: undefined as unknown as boolean })
    ])
    expect(migrated[0]!.isVision).toBe(true)
    expect(migrated[0]!.isDefault).toBe(false)
  })

  it('resolvePreferredModelId falls back through chain', () => {
    const available = getAvailableModels(models, services, ['s1'])
    expect(resolvePreferredModelId('language', available, 'missing')).toBe('1')
    expect(resolvePreferredModelId('fast', available, 'missing')).toBe('2')
    expect(resolvePreferredModelId('vision', available, 'missing')).toBeNull()
  })

  it('buildChatModelOptions always uses service prefix in displayName', () => {
    const options = buildChatModelOptions(models, services, ['s1', 's2'])
    const pro = options.filter((o) => o.modelName === 'deepseek-v4-pro')
    expect(pro).toHaveLength(2)
    expect(pro.map((o) => o.displayName).sort()).toEqual(['Deep-deepseek-v4-pro', 'Volcano-deepseek-v4-pro'])

    const flash = options.find((o) => o.modelName === 'deepseek-v4-flash')
    expect(flash?.displayName).toBe('Deep-deepseek-v4-flash')
  })

  it('pruneDisabledModelsFromServices removes disabled ids', () => {
    const pruned = pruneDisabledModelsFromServices(services, new Set(['1']))
    expect(pruned[0]!.supportedModelIds).toEqual(['1'])
    expect(pruned[1]!.supportedModelIds).toEqual(['1'])
  })

  it('resolveServiceForModel prefers explicit serviceId', () => {
    const s = resolveServiceForModel(services, ['s1', 's2'], '1', 's2')
    expect(s?.id).toBe('s2')
  })

  it('resolveServiceForModel walks active list order when no explicit id', () => {
    const s = resolveServiceForModel(services, ['s1', 's2'], '1')
    expect(s?.id).toBe('s1')
  })
})
