import { describe, expect, it } from 'vitest'
import type { LlmServiceProfile, ModelEntry } from './domainTypes'
import {
  buildChatModelOptions,
  diffFetchedModels,
  getAvailableModels,
  getModelIds,
  mergeFetchedModels,
  migrateModelEntries,
  migrateBuiltinModelName,
  pruneMissingModelsFromServices,
  resolvePreferredModelId,
  resolveServiceForModel,
  sortModelsFastFirst,
  resolveModelContextWindow,
  buildCustomModelEntry
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
    makeModel({ id: '2', name: 'deepseek-flash', isFast: true }),
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
      'deepseek-flash',
      'deepseek-v4-pro',
      'kimi-k2.7-code'
    ])
  })

  it('getAvailableModels keeps legacy disabled entries available', () => {
    const disabled = models.map((m) => (m.id === '3' ? { ...m, enabled: false } : m))
    const available = getAvailableModels(disabled, services, ['s1', 's2'])
    expect(available.some((m) => m.name === 'kimi-k2.7-code')).toBe(true)
    expect(getModelIds(disabled)).toEqual(['1', '2', '3', '4'])
  })

  it('sortModelsFastFirst keeps order within groups', () => {
    const sorted = sortModelsFastFirst(models)
    expect(sorted[0]!.isFast).toBe(true)
    expect(sorted[1]!.isFast).toBe(true)
  })

  it('migrateModelEntries derives vision support from pi-ai metadata', () => {
    const migrated = migrateModelEntries([
      makeModel({ id: 'x', name: 'kimi-k2.7-code', isVision: undefined as unknown as boolean })
    ])
    expect(migrated[0]!.isVision).toBe(true)
    expect(migrated[0]!.isDefault).toBe(false)
  })

  it('migrateModelEntries upgrades legacy disabled models to enabled', () => {
    expect(migrateModelEntries([makeModel({ id: 'old-off', name: 'custom', enabled: false })])[0]?.enabled).toBe(true)
  })

  it('does not assign product fast tags by model name and preserves saved values', () => {
    const [unlabeled] = migrateModelEntries([makeModel({ id: 'new-haiku', name: 'claude-haiku-4-5' })])
    const [savedFast] = migrateModelEntries([makeModel({ id: 'saved-flash', name: 'deepseek-flash', isFast: true })])
    expect(unlabeled?.isFast).toBe(false)
    expect(savedFast?.isFast).toBe(true)
  })

  it('uses model baseline for missing parameters while preserving explicit values', () => {
    const normalized = migrateModelEntries([
      makeModel({ id: 'base', name: 'deepseek-v4-pro', maximumContext: undefined as unknown as number, maxTokens: undefined as unknown as number }),
      makeModel({ id: 'custom', name: 'deepseek-v4-pro', maximumContext: 500_000, maxTokens: 12_000 })
    ])
    expect(normalized[0]).toMatchObject({ maximumContext: 1_000_000, maxTokens: 384_000, isVision: false })
    expect(normalized[1]).toMatchObject({ maximumContext: 500_000, maxTokens: 12_000 })
  })

  it('tracks whether a 200k window is real configuration or a generic fallback', () => {
    const entries = migrateModelEntries([
      makeModel({ id: 'real-200k', name: 'claude-haiku-4-5', maximumContext: 200_000 }),
      makeModel({ id: 'fallback-200k', name: 'unlisted-model', maximumContext: undefined as unknown as number })
    ])
    expect(entries[0]).toMatchObject({ maximumContext: 200_000, maximumContextSource: 'user' })
    expect(entries[1]).toMatchObject({ maximumContext: 200_000, maximumContextSource: 'fallback' })
  })

  it('does not trust a legacy unknown-model 200k value that came from automatic fetch defaults', () => {
    const legacyFetched = makeModel({ id: 'legacy-fetch', name: 'vendor-large-model', maximumContext: 200_000 })
    const [migrated] = migrateModelEntries([legacyFetched])
    expect(migrated).toMatchObject({ maximumContext: 200_000, maximumContextSource: 'fallback' })
    expect(resolveModelContextWindow('vendor-large-model', [legacyFetched])).toEqual({ contextWindow: 200_000, trusted: false })
  })

  it('resolves a source-aware context window for desktop, remote, and automation callers', () => {
    expect(resolveModelContextWindow('custom', [makeModel({ id: 'custom', name: 'custom', maximumContextSource: 'fallback' })]))
      .toEqual({ contextWindow: 200_000, trusted: false })
    expect(resolveModelContextWindow('claude-haiku-4-5', [makeModel({ id: 'haiku', name: 'claude-haiku-4-5' })]))
      .toEqual({ contextWindow: 200_000, trusted: true })
  })

  it('derives omitted custom-model capacities and only trusts a window the user entered', () => {
    expect(buildCustomModelEntry({ id: 'known', name: 'gpt-5.5', isFast: false, isVision: true }))
      .toMatchObject({ maximumContext: 272_000, maximumContextSource: 'baseline', maxTokens: 128_000 })
    expect(buildCustomModelEntry({ id: 'unknown', name: 'custom-model', isFast: false, isVision: false }))
      .toMatchObject({ maximumContext: 200_000, maximumContextSource: 'fallback' })
    expect(buildCustomModelEntry({ id: 'explicit', name: 'custom-model', maximumContext: 200_000, isFast: false, isVision: false }))
      .toMatchObject({ maximumContext: 200_000, maximumContextSource: 'user' })
  })

  it('migrates every reviewed changed default and preserves minimax vision eligibility', () => {
    const migrated = migrateModelEntries([
      makeModel({ id: 'gpt-old', name: 'gpt-5.5', maximumContext: 1_000_000, maxTokens: 128_000, isVision: true }),
      makeModel({ id: 'kimi-old', name: 'kimi-k2.7-code', maximumContext: 262_144, maxTokens: 98_304, isVision: true }),
      makeModel({ id: 'glm-old', name: 'glm-5.3', maximumContext: 1_000_000, maxTokens: 128_000, isVision: false }),
      makeModel({ id: 'glm-flash-old', name: 'glm-5.3-flash', maximumContext: 1_000_000, maxTokens: 128_000, isVision: true }),
      makeModel({ id: 'minimax-old', name: 'minimax-m2.7', maximumContext: 204_800, maxTokens: 204_800, isVision: true })
    ])
    expect(migrated.map(({ maximumContext, maxTokens, isVision }) => ({ maximumContext, maxTokens, isVision }))).toEqual([
      { maximumContext: 272_000, maxTokens: 128_000, isVision: true },
      { maximumContext: 262_144, maxTokens: 98_304, isVision: true },
      { maximumContext: 1_000_000, maxTokens: 131_072, isVision: false },
      { maximumContext: 1_000_000, maxTokens: 131_072, isVision: true },
      { maximumContext: 204_800, maxTokens: 131_072, isVision: true }
    ])
    expect(resolveModelContextWindow('gpt-5.5', [migrated[0]!])).toMatchObject({ contextWindow: 272_000, trusted: true })
  })

  it('migrates only fields equal to known previous defaults, independently', () => {
    const migrated = migrateModelEntries([
      makeModel({ id: 'old', name: 'deepseek-v4-pro', maximumContext: 1_048_565, maxTokens: 300_000 }),
      makeModel({ id: 'edited', name: 'deepseek-v4-pro', maximumContext: 500_000, maxTokens: 300_000 }),
      makeModel({ id: 'sonnet-old', name: 'claude-sonnet-4-6', maximumContext: 750_000, maxTokens: 64_000 }),
      makeModel({ id: 'unknown-old', name: 'claude-sonnet-4-6', maximumContext: 100_000, maxTokens: 32_000 })
    ])
    expect(migrated[0]).toMatchObject({ maximumContext: 1_000_000, maxTokens: 300_000 })
    expect(migrated[1]).toMatchObject({ maximumContext: 500_000, maxTokens: 300_000 })
    expect(migrated[2]).toMatchObject({ maximumContext: 750_000, maxTokens: 128_000 })
    expect(migrated[3]).toMatchObject({ maxTokens: 32_000 })
  })

  it('preserves explicitly user-sourced historical window values across migration and runtime resolution', () => {
    const explicit = makeModel({ id: 'custom-gpt', name: 'gpt-5.5', maximumContext: 1_000_000, maximumContextSource: 'user' })
    expect(migrateModelEntries([explicit])[0]).toMatchObject({ maximumContext: 1_000_000, maximumContextSource: 'user' })
    expect(resolveModelContextWindow('gpt-5.5', [explicit])).toEqual({ contextWindow: 1_000_000, trusted: true })

    const legacy = makeModel({ id: 'legacy-gpt', name: 'gpt-5.5', maximumContext: 1_000_000, maximumContextSource: undefined })
    expect(migrateModelEntries([legacy])[0]).toMatchObject({ maximumContext: 272_000, maximumContextSource: 'baseline' })
    expect(resolveModelContextWindow('gpt-5.5', [legacy])).toEqual({ contextWindow: 272_000, trusted: true })
  })

  it('preserves supportsThinking false when creating and migrating model entries', () => {
    expect(buildCustomModelEntry({ id: 'no-thinking-new', name: 'custom-model', isFast: false, isVision: false, supportsThinking: false }))
      .toMatchObject({ supportsThinking: false })
    expect(migrateModelEntries([makeModel({ id: 'no-thinking-old', name: 'gpt-5.5', supportsThinking: false })])[0])
      .toMatchObject({ supportsThinking: false })
  })

  it('keeps an empty model catalog empty and derives preferences only from available entries', async () => {
    expect(getModelIds([])).toEqual([])
    const { getDefaultPreferredModelIds } = await import('./llmModelConfig')
    expect(getDefaultPreferredModelIds([])).toEqual({
      preferredLanguageModelId: '',
      preferredFastLanguageModelId: '',
      preferredVisionModelId: ''
    })
    expect(getDefaultPreferredModelIds(models)).toEqual({
      preferredLanguageModelId: '1',
      preferredFastLanguageModelId: '2',
      preferredVisionModelId: '2'
    })
  })

  it('migrateModelEntries skips rename when the target name is already taken', () => {
    const migrated = migrateModelEntries([
      makeModel({ id: 'old', name: 'kimi-k2.6' }),
      makeModel({ id: 'new', name: 'kimi-k2.7-code' })
    ])
    // 目标名已被占用时保留原名，避免产生同名重复条目
    expect(migrated.map((m) => m.name)).toEqual(['kimi-k2.6', 'kimi-k2.7-code'])
  })

  it('migrateModelEntries renames deepseek flash to the new model name', () => {
    const migrated = migrateModelEntries([
      makeModel({ id: '2', name: 'deepseek-v4-flash', isFast: true })
    ])
    // 保留原 id，仅升级名称，优选/服务勾选引用不失效
    expect(migrated[0]!.id).toBe('2')
    expect(migrated[0]!.name).toBe('deepseek-flash')
    expect(migrated[0]!.isFast).toBe(true)
  })

  it('migrateBuiltinModelName 把旧内置名映射到当前名', () => {
    expect(migrateBuiltinModelName('deepseek-v4-flash')).toBe('deepseek-flash')
    expect(migrateBuiltinModelName('kimi-k2.6')).toBe('kimi-k2.7-code')
    expect(migrateBuiltinModelName('  glm-5.1  ')).toBe('glm-5.3')
  })

  it('migrateBuiltinModelName 对未命中的名字原样返回（含用户自定义/已删除模型）', () => {
    expect(migrateBuiltinModelName('claude-sonnet-4-20250514')).toBe('claude-sonnet-4-20250514')
    expect(migrateBuiltinModelName('my-custom-model')).toBe('my-custom-model')
  })

  it('migrateBuiltinModelName 支持链式改名，并在出现环时停止', () => {
    expect(migrateBuiltinModelName('a', { a: 'b', b: 'c' })).toBe('c')
    expect(migrateBuiltinModelName('a', { a: 'b', b: 'a' })).toBe('b')
  })

  it('resolvePreferredModelId falls back through chain', () => {
    const available = getAvailableModels(models, services, ['s1'])
    expect(resolvePreferredModelId('language', available, 'missing')).toBe('1')
    expect(resolvePreferredModelId('fast', available, 'missing')).toBe('2')
    expect(resolvePreferredModelId('vision', available, 'missing')).toBe('2')
  })

  it('快速模型优选允许选择任意可用语言模型，不要求目录 isFast 标签', () => {
    const available = [makeModel({ id: 'ordinary', name: 'deepseek-v4-pro', isFast: false })]
    expect(resolvePreferredModelId('fast', available, 'ordinary')).toBe('ordinary')
    expect(resolvePreferredModelId('fast', available, 'missing')).toBe('ordinary')
  })

  it('vision eligibility follows pi-ai input=image metadata instead of the editable catalog flag', () => {
    const available = [
      makeModel({ id: 'pi-vision', name: 'kimi-k2.7-code', isVision: false }),
      makeModel({ id: 'local-only-vision', name: 'minimax-m2.7', isVision: true })
    ]

    expect(resolvePreferredModelId('vision', available, 'local-only-vision')).toBe('pi-vision')
  })

  it('buildChatModelOptions always uses service prefix in displayName', () => {
    const options = buildChatModelOptions(models, services, ['s1', 's2'])
    const pro = options.filter((o) => o.modelName === 'deepseek-v4-pro')
    expect(pro).toHaveLength(2)
    expect(pro.map((o) => o.displayName).sort()).toEqual(['Deep-deepseek-v4-pro', 'Volcano-deepseek-v4-pro'])

    const flash = options.find((o) => o.modelName === 'deepseek-flash')
    expect(flash?.displayName).toBe('Deep-deepseek-flash')
  })

  it('pruneMissingModelsFromServices removes ids absent from the model catalog', () => {
    const pruned = pruneMissingModelsFromServices(services, new Set(['1']))
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

  it('creates entries for unknown ids with capability defaults', () => {
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
    expect(haiku.isFast).toBe(false)
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
