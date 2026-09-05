import { describe, expect, it } from 'vitest'
import type { LlmServiceProfile, ModelEntry } from './domainTypes'
import {
  buildChatModelOptions,
  diffFetchedModels,
  getAvailableModels,
  mergeFetchedModels,
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
    makeModel({ id: '3', name: 'kimi-k2.7-code', isVision: true }),
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
      'kimi-k2.7-code'
    ])
  })

  it('getAvailableModels excludes disabled models', () => {
    const disabled = models.map((m) => (m.id === '3' ? { ...m, enabled: false } : m))
    const available = getAvailableModels(disabled, services, ['s1', 's2'])
    expect(available.some((m) => m.name === 'kimi-k2.7-code')).toBe(false)
  })

  it('sortModelsFastFirst keeps order within groups', () => {
    const sorted = sortModelsFastFirst(models)
    expect(sorted[0]!.isFast).toBe(true)
    expect(sorted[1]!.isFast).toBe(true)
  })

  it('migrateModelEntries fills isVision from builtin table', () => {
    const migrated = migrateModelEntries([
      makeModel({ id: 'x', name: 'kimi-k2.7-code', isVision: undefined as unknown as boolean })
    ])
    expect(migrated[0]!.isVision).toBe(true)
    expect(migrated[0]!.isDefault).toBe(false)
  })

  it('migrateModelEntries skips rename when the target name is already taken', () => {
    const migrated = migrateModelEntries([
      makeModel({ id: 'old', name: 'kimi-k2.6' }),
      makeModel({ id: 'new', name: 'kimi-k2.7-code' })
    ])
    // 目标名已被占用时保留原名，避免产生同名重复条目
    expect(migrated.map((m) => m.name)).toEqual(['kimi-k2.6', 'kimi-k2.7-code'])
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

describe('mergeFetchedModels', () => {
  const seq = (() => {
    let n = 0
    return () => `new-${++n}`
  })()

  it('creates entries for unknown ids with defaults and builtin tags', () => {
    const result = mergeFetchedModels(
      [],
      [{ id: 'claude-haiku-4-5' }, { id: 'vendor-x-model' }],
      [],
      seq
    )
    expect(result.models).toHaveLength(2)
    const haiku = result.models[0]!
    expect(haiku.name).toBe('claude-haiku-4-5')
    expect(haiku.id).toBe('new-1')
    expect(haiku.isFast).toBe(true)
    expect(haiku.isVision).toBe(true)
    expect(haiku.enabled).toBe(true)
    const custom = result.models[1]!
    expect(custom.maximumContext).toBe(200000)
    expect(custom.maxTokens).toBe(64000)
    expect(custom.isFast).toBe(false)
    expect(custom.isVision).toBe(false)
    expect(result.addedNames).toEqual(['claude-haiku-4-5', 'vendor-x-model'])
    expect(result.supportedModelIds).toEqual(['new-1', 'new-2'])
  })

  it('does not duplicate or overwrite existing entries matched by name', () => {
    const existing = makeModel({ id: '1', name: 'kimi-k2.7-code', maximumContext: 12345, isVision: false })
    const result = mergeFetchedModels([existing], [{ id: 'kimi-k2.7-code' }], ['1'], seq)
    expect(result.models).toHaveLength(1)
    expect(result.models[0]!.maximumContext).toBe(12345)
    expect(result.models[0]!.isVision).toBe(false)
    expect(result.addedNames).toEqual([])
    expect(result.supportedModelIds).toEqual(['1'])
  })

  it('re-enables a disabled existing entry and adds it to supported ids', () => {
    const existing = makeModel({ id: '1', name: 'glm-5.3', enabled: false })
    const result = mergeFetchedModels([existing], [{ id: 'glm-5.3' }], [], seq)
    expect(result.models[0]!.enabled).toBe(true)
    expect(result.supportedModelIds).toEqual(['1'])
  })

  it('replaces supported ids with the fetched list and reports removed ones', () => {
    const existing = [makeModel({ id: '1', name: 'a' }), makeModel({ id: '2', name: 'b' })]
    const result = mergeFetchedModels(existing, [{ id: 'b' }], ['1'], seq)
    expect(result.supportedModelIds).toEqual(['2'])
    expect(result.removedIds).toEqual(['1'])
    // 被替换掉的条目仍留在目录中，仅取消勾选
    expect(result.models).toHaveLength(2)
  })

  it('is idempotent on repeated fetches', () => {
    const first = mergeFetchedModels([], [{ id: 'm1' }], [], seq)
    const second = mergeFetchedModels(first.models, [{ id: 'm1' }], first.supportedModelIds, seq)
    expect(second.models).toHaveLength(1)
    expect(second.supportedModelIds).toEqual(first.supportedModelIds)
    expect(second.addedNames).toEqual([])
  })
})

describe('diffFetchedModels', () => {
  const models = [
    makeModel({ id: '1', name: 'kimi-k2.6' }),
    makeModel({ id: '2', name: 'kimi-k2.7-code' }),
    makeModel({ id: '3', name: 'other' })
  ]

  it('computes stale (supported - fetched) ids', () => {
    const diff = diffFetchedModels(['1', '2'], models, ['kimi-k2.7-code', 'kimi-k2.8'])
    expect(diff.staleIds).toEqual(['1'])
  })

  it('returns empty diff when supported matches fetched', () => {
    const diff = diffFetchedModels(['2'], models, ['kimi-k2.7-code'])
    expect(diff.staleIds).toEqual([])
  })

  it('treats supported entries missing from catalog as not stale', () => {
    const diff = diffFetchedModels(['ghost'], models, ['kimi-k2.7-code'])
    expect(diff.staleIds).toEqual([])
  })
})
