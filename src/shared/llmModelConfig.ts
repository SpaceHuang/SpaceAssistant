import type { LlmServiceProfile, ModelEntry } from './domainTypes'
import { DEFAULT_MODEL_MAX_CONTEXT, DEFAULT_MODEL_MAX_TOKENS } from './domainTypes'

/** 内置模型快速/视觉标签默认值（§6.4） */
export const BUILTIN_MODEL_TAG_DEFAULTS: Record<string, { isFast: boolean; isVision: boolean }> = {
  'kimi-k2.7-code': { isFast: false, isVision: true },
  'glm-5.3': { isFast: false, isVision: false },
  'glm-5.3-flash': { isFast: true, isVision: true },
  'minimax-m2.7': { isFast: false, isVision: true },
  'deepseek-v4-pro': { isFast: false, isVision: false },
  'deepseek-flash': { isFast: true, isVision: false },
  'claude-sonnet-4-6': { isFast: false, isVision: true },
  'claude-opus-4-7': { isFast: false, isVision: true },
  'claude-haiku-4-5': { isFast: true, isVision: true },
  'gpt-5.5': { isFast: false, isVision: true }
}

export const PREFERRED_BUILTIN_MODEL_NAMES = {
  language: 'deepseek-v4-pro',
  fast: 'deepseek-flash',
  vision: 'kimi-k2.7-code'
} as const

/** 内置模型名升级映射：迁移旧名到新名（保留原 id 与作者配置） */
export const BUILTIN_MODEL_NAME_MIGRATIONS: Record<string, string> = {
  'kimi-k2.6': 'kimi-k2.7-code',
  'glm-5.1': 'glm-5.3',
  'deepseek-v4-flash': 'deepseek-flash'
}

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
  const existingNames = new Set(models.map((m) => m.name))
  return models.map((m) => {
    const target = BUILTIN_MODEL_NAME_MIGRATIONS[m.name]
    // 目标名已被其它条目占用时跳过重命名，避免产生同名重复条目（不可删、按名查找失效）
    const renamed = target && !existingNames.has(target) ? target : m.name
    return normalizeModelEntry({ ...m, name: renamed })
  })
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

/** 拉取到的服务模型信息（宽容解析后的最小结构） */
export interface FetchedModelInfo {
  /** 服务 API 返回的模型 id，映射为 ModelEntry.name */
  id: string
  displayName?: string
}

/** 模型列表拉取错误分类（主进程与渲染层统一使用，仅此一处定义） */
export type FetchServiceModelsError =
  | 'unauthorized'
  | 'not-found'
  | 'timeout'
  | 'network'
  | 'invalid-response'
  | 'no-api-key'
  | 'invalid-base-url'

export type FetchServiceModelsResult =
  | { ok: true; models: FetchedModelInfo[]; truncated: boolean }
  | { ok: false; error: FetchServiceModelsError; status?: number }

export interface MergeFetchedModelsResult {
  /** 合并后的全局模型目录（既有条目原样保留，新条目追加） */
  models: ModelEntry[]
  /** 该服务合并后的 supportedModelIds（替换语义：恰好等于本次拉取到的集合） */
  supportedModelIds: string[]
  /** 本次新建条目的 name 列表 */
  addedNames: string[]
  /** 原勾选中因不在本次拉取结果里而被移除的 ModelEntry.id */
  removedIds: string[]
  /** 目录是否发生变化（新增或重新启用条目）；为 false 时无需回写目录 */
  catalogChanged: boolean
}

/**
 * 拉取结果合并进全局目录并替换服务勾选（§6.4，应用前自动清空）：
 * - name 已存在：不新建、不覆盖用户字段，仅确保 enabled=true 并纳入勾选；
 * - name 不存在：按 normalizeModelEntry 兜底规则新建（内置标签表命中则用之）并纳入勾选；
 * - 原勾选但本次未拉到的：从 supportedModelIds 移除（目录条目保留），记入 removedIds。
 */
export function mergeFetchedModels(
  models: ModelEntry[],
  fetched: FetchedModelInfo[],
  serviceSupportedIds: string[],
  createId: () => string = () => crypto.randomUUID()
): MergeFetchedModelsResult {
  const nextModels = [...models]
  const supported: string[] = []
  const addedNames: string[] = []
  let catalogChanged = false
  for (const f of fetched) {
    const name = f.id
    const existing = nextModels.find((m) => m.name === name)
    if (existing) {
      if (!existing.enabled) {
        nextModels[nextModels.indexOf(existing)] = { ...existing, enabled: true }
        catalogChanged = true
      }
      if (!supported.includes(existing.id)) supported.push(existing.id)
      continue
    }
    const entry = normalizeModelEntry({ id: createId(), name })
    nextModels.push(entry)
    supported.push(entry.id)
    addedNames.push(name)
    catalogChanged = true
  }
  const supportedSet = new Set(supported)
  const removedIds = serviceSupportedIds.filter((id) => !supportedSet.has(id))
  return { models: nextModels, supportedModelIds: supported, addedNames, removedIds, catalogChanged }
}

export interface FetchedModelsDiff {
  /** supported − fetched：疑似已下线的已勾选模型（ModelEntry.id）。 */
  staleIds: string[]
}

/**
 * 失效模型检测（§6.2）：基于服务最近一次拉取结论计算差集。
 * 拉取为替换语义，fetched − supported 恒为空，故只产出 staleIds；
 * 该差集只出现在「上次拉取后用户手动勾选了别的模型」的场景。
 */
export function diffFetchedModels(
  supportedIds: string[],
  models: ModelEntry[],
  fetchedNames: string[]
): FetchedModelsDiff {
  const fetchedSet = new Set(fetchedNames)
  const byId = new Map(models.map((m) => [m.id, m]))
  const staleIds: string[] = []
  for (const id of supportedIds) {
    const entry = byId.get(id)
    if (!entry) continue
    if (!fetchedSet.has(entry.name)) staleIds.push(id)
  }
  return { staleIds }
}
