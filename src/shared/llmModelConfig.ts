import type { LlmServiceProfile, ModelEntry } from './domainTypes'
import { DEFAULT_MODEL_MAX_CONTEXT, DEFAULT_MODEL_MAX_TOKENS } from './domainTypes'

/** 内置模型快速/视觉标签默认值（§6.4） */
export const BUILTIN_MODEL_TAG_DEFAULTS: Record<string, { isFast: boolean; isVision: boolean }> = {
  'kimi-k2.6': { isFast: false, isVision: true },
  'glm-5.1': { isFast: false, isVision: true },
  'minimax-m2.7': { isFast: false, isVision: true },
  'deepseek-v4-pro': { isFast: false, isVision: false },
  'deepseek-v4-flash': { isFast: true, isVision: false },
  'claude-sonnet-4-6': { isFast: false, isVision: true },
  'claude-opus-4-7': { isFast: false, isVision: true },
  'claude-haiku-4-5': { isFast: true, isVision: true },
  'gpt-5.5': { isFast: false, isVision: true },
  'gemini-3.1-pro': { isFast: false, isVision: true },
  'gemini-3.1-flash-lite': { isFast: true, isVision: true }
}

export const PREFERRED_BUILTIN_MODEL_NAMES = {
  language: 'deepseek-v4-pro',
  fast: 'deepseek-v4-flash',
  vision: 'kimi-k2.6'
} as const

export type PreferredModelKind = 'language' | 'fast' | 'vision'

export function sortModelsFastFirst(models: ModelEntry[]): ModelEntry[] {
  const fast: ModelEntry[] = []
  const rest: ModelEntry[] = []
  for (const m of models) {
    if (m.isFast) fast.push(m)
    else rest.push(m)
  }
  return [...fast, ...rest]
}

export function normalizeModelEntry(entry: Partial<ModelEntry> & Pick<ModelEntry, 'id' | 'name'>): ModelEntry {
  const tags = BUILTIN_MODEL_TAG_DEFAULTS[entry.name]
  return {
    id: entry.id,
    name: entry.name,
    maximumContext: entry.maximumContext ?? DEFAULT_MODEL_MAX_CONTEXT,
    maxTokens: entry.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS,
    isDefault: false,
    isFast: entry.isFast ?? tags?.isFast ?? false,
    isVision: entry.isVision ?? tags?.isVision ?? false,
    enabled: entry.enabled ?? true
  }
}

export function migrateModelEntries(models: ModelEntry[]): ModelEntry[] {
  return models.map((m) => normalizeModelEntry(m))
}

export function getEnabledModelIds(models: ModelEntry[]): string[] {
  return models.filter((m) => m.enabled).map((m) => m.id)
}

export function getAvailableModels(
  models: ModelEntry[],
  services: LlmServiceProfile[],
  activeServiceIds: string[]
): ModelEntry[] {
  const activeSet = new Set(activeServiceIds)
  const supportedIds = new Set<string>()
  for (const s of services) {
    if (!activeSet.has(s.id)) continue
    for (const id of s.supportedModelIds ?? []) supportedIds.add(id)
  }
  return sortModelsFastFirst(models).filter((m) => m.enabled && supportedIds.has(m.id))
}

function tagFilter(kind: PreferredModelKind): (m: ModelEntry) => boolean {
  if (kind === 'fast') return (m) => m.isFast
  if (kind === 'vision') return (m) => m.isVision
  return () => true
}

function preferredBuiltinName(kind: PreferredModelKind): string {
  if (kind === 'fast') return PREFERRED_BUILTIN_MODEL_NAMES.fast
  if (kind === 'vision') return PREFERRED_BUILTIN_MODEL_NAMES.vision
  return PREFERRED_BUILTIN_MODEL_NAMES.language
}

/** §7.3 运行时回退链 */
export function resolvePreferredModelId(
  kind: PreferredModelKind,
  available: ModelEntry[],
  configuredId: string
): string | null {
  const filter = tagFilter(kind)
  const filtered = available.filter(filter)

  if (configuredId) {
    const configured = filtered.find((m) => m.id === configuredId)
    if (configured) return configured.id
  }

  const builtin = filtered.find((m) => m.name === preferredBuiltinName(kind))
  if (builtin) return builtin.id

  const first = filtered[0]
  if (first) return first.id

  if (kind === 'language') return available[0]?.id ?? null
  return null
}

export function resolvePreferredModelEntry(
  kind: PreferredModelKind,
  models: ModelEntry[],
  available: ModelEntry[],
  configuredId: string
): ModelEntry | undefined {
  const id = resolvePreferredModelId(kind, available, configuredId)
  if (!id) return undefined
  return models.find((m) => m.id === id)
}

export function getDefaultPreferredModelIds(models: ModelEntry[]): {
  preferredLanguageModelId: string
  preferredFastLanguageModelId: string
  preferredVisionModelId: string
} {
  const findId = (name: string) => models.find((m) => m.name === name)?.id ?? ''
  return {
    preferredLanguageModelId: findId(PREFERRED_BUILTIN_MODEL_NAMES.language) || models[0]?.id || '',
    preferredFastLanguageModelId: findId(PREFERRED_BUILTIN_MODEL_NAMES.fast),
    preferredVisionModelId: findId(PREFERRED_BUILTIN_MODEL_NAMES.vision)
  }
}

export function isPreferredModelAvailable(
  modelId: string,
  available: ModelEntry[],
  kind: PreferredModelKind
): boolean {
  if (!modelId) return false
  const m = available.find((x) => x.id === modelId)
  if (!m) return false
  const filter = tagFilter(kind)
  return filter(m)
}

export type ChatModelOption = {
  serviceId: string
  serviceName: string
  modelId: string
  modelName: string
  model: ModelEntry
  displayName: string
}

/** §9 聊天区模型列表：按服务顺序 × 模型排序展开；展示名统一为「服务名-模型名」 */
export function buildChatModelOptions(
  models: ModelEntry[],
  services: LlmServiceProfile[],
  activeServiceIds: string[]
): ChatModelOption[] {
  const available = getAvailableModels(models, services, activeServiceIds)

  const options: ChatModelOption[] = []
  for (const serviceId of activeServiceIds) {
    const service = services.find((s) => s.id === serviceId)
    if (!service) continue
    for (const modelId of service.supportedModelIds ?? []) {
      const model = available.find((m) => m.id === modelId)
      if (!model) continue
      const displayName = `${service.name.trim()}-${model.name}`
      options.push({
        serviceId,
        serviceName: service.name,
        modelId,
        modelName: model.name,
        model,
        displayName
      })
    }
  }
  return options
}

export function findChatModelOption(
  options: ChatModelOption[],
  serviceId: string | undefined,
  modelName: string
): ChatModelOption | undefined {
  if (serviceId) {
    return options.find((o) => o.serviceId === serviceId && o.modelName === modelName)
  }
  const matches = options.filter((o) => o.modelName === modelName)
  return matches.length === 1 ? matches[0] : undefined
}

export function pruneDisabledModelsFromServices(
  services: LlmServiceProfile[],
  enabledModelIds: Set<string>
): LlmServiceProfile[] {
  return services.map((s) => ({
    ...s,
    supportedModelIds: (s.supportedModelIds ?? []).filter((id) => enabledModelIds.has(id))
  }))
}

export function resolveServiceForModel(
  services: LlmServiceProfile[],
  activeServiceIds: string[],
  modelId: string,
  explicitServiceId?: string,
  hasApiKey?: (serviceId: string) => boolean
): LlmServiceProfile | undefined {
  if (explicitServiceId) {
    const explicit = services.find((s) => s.id === explicitServiceId)
    if (explicit && (explicit.supportedModelIds ?? []).includes(modelId)) {
      if (!hasApiKey || hasApiKey(explicit.id)) return explicit
    }
  }
  for (const id of activeServiceIds) {
    const s = services.find((x) => x.id === id)
    if (!s) continue
    if (!(s.supportedModelIds ?? []).includes(modelId)) continue
    if (hasApiKey && !hasApiKey(s.id)) continue
    return s
  }
  return undefined
}
