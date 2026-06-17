import { randomUUID } from 'crypto'
import type { LlmServiceProfile, ModelEntry } from '../src/shared/domainTypes'
import {
  getAvailableModels,
  getDefaultPreferredModelIds,
  getEnabledModelIds,
  migrateModelEntries,
  resolvePreferredModelEntry,
  resolveServiceForModel
} from '../src/shared/llmModelConfig'
import type { AppDatabase } from './database'
import { getConfigValue, setConfigValue } from './database'
import { assertValidOptionalAnthropicBaseUrl } from './claudeRequestGuards'
import { decryptSecret, encryptSecret, isSecretStorageAvailable } from './secureApiKey'

export const LLM_SERVICE_CONFIG_KEYS = {
  llmServices: 'config.llmServices',
  activeLlmServiceId: 'config.activeLlmServiceId',
  activeLlmServiceIds: 'config.activeLlmServiceIds',
  preferredLanguageModelId: 'config.preferredLanguageModelId',
  preferredFastLanguageModelId: 'config.preferredFastLanguageModelId',
  preferredVisionModelId: 'config.preferredVisionModelId',
  llmServiceKeys: 'secrets.llmServiceKeys',
  baseUrl: 'config.baseUrl',
  apiKeyEnc: 'secrets.apiKeyEnc'
} as const

export const MAX_LLM_SERVICES = 10
export const DEFAULT_LLM_SERVICE_NAME = '默认服务'

export type LlmServiceKeysMap = Record<string, string>

export type ValidateLlmServicesInput = {
  services: LlmServiceProfile[]
  activeLlmServiceIds: string[]
  keysPayload?: Record<string, string>
  existingKeys: LlmServiceKeysMap
  /** 已有服务 id 集合（保存前），用于判断新建 */
  previousServiceIds?: Set<string>
}

export class LlmServiceValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmServiceValidationError'
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

export function readLlmServiceKeysMap(db: AppDatabase): LlmServiceKeysMap {
  const raw = getConfigValue(db, LLM_SERVICE_CONFIG_KEYS.llmServiceKeys)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: LlmServiceKeysMap = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.trim()) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function writeLlmServiceKeysMap(db: AppDatabase, map: LlmServiceKeysMap): void {
  setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.llmServiceKeys, JSON.stringify(map))
}

export function getLlmServiceApiKey(db: AppDatabase, serviceId: string): Promise<string | null> {
  const map = readLlmServiceKeysMap(db)
  const enc = map[serviceId]
  if (!enc) return Promise.resolve(null)
  if (!isSecretStorageAvailable()) return Promise.resolve(null)
  try {
    return Promise.resolve(decryptSecret(enc))
  } catch {
    return Promise.resolve(null)
  }
}

export function setLlmServiceApiKey(db: AppDatabase, serviceId: string, plainKey: string): void {
  const map = readLlmServiceKeysMap(db)
  map[serviceId] = encryptSecret(plainKey.trim())
  writeLlmServiceKeysMap(db, map)
}

export function removeLlmServiceApiKeys(db: AppDatabase, serviceIds: string[]): void {
  if (serviceIds.length === 0) return
  const map = readLlmServiceKeysMap(db)
  let changed = false
  for (const id of serviceIds) {
    if (id in map) {
      delete map[id]
      changed = true
    }
  }
  if (changed) writeLlmServiceKeysMap(db, map)
}

function parseStoredServices(raw: string | undefined): LlmServiceProfile[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: LlmServiceProfile[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      const id = typeof o.id === 'string' ? o.id : ''
      const name = typeof o.name === 'string' ? o.name : ''
      if (!id) continue
      const supportedRaw = o.supportedModelIds
      const supportedModelIds = Array.isArray(supportedRaw)
        ? supportedRaw.filter((x): x is string => typeof x === 'string')
        : undefined
      out.push({
        id,
        name,
        baseUrl: typeof o.baseUrl === 'string' ? o.baseUrl : '',
        apiKeyPresent: false,
        supportedModelIds,
        createdAt: typeof o.createdAt === 'string' ? o.createdAt : undefined,
        updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : undefined
      })
    }
    return out
  } catch {
    return []
  }
}

function attachApiKeyPresent(services: LlmServiceProfile[], keysMap: LlmServiceKeysMap): LlmServiceProfile[] {
  return services.map((s) => ({
    ...s,
    apiKeyPresent: Boolean(keysMap[s.id])
  }))
}

export function readLlmServices(db: AppDatabase): LlmServiceProfile[] {
  const raw = getConfigValue(db, LLM_SERVICE_CONFIG_KEYS.llmServices)
  const keysMap = readLlmServiceKeysMap(db)
  return attachApiKeyPresent(parseStoredServices(raw), keysMap)
}

export function readActiveLlmServiceId(db: AppDatabase): string | undefined {
  return getConfigValue(db, LLM_SERVICE_CONFIG_KEYS.activeLlmServiceId)
}

export function readActiveLlmServiceIds(db: AppDatabase): string[] {
  const raw = getConfigValue(db, LLM_SERVICE_CONFIG_KEYS.activeLlmServiceIds)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      }
    } catch {
      /* fall through */
    }
  }
  const legacy = readActiveLlmServiceId(db)
  return legacy ? [legacy] : []
}

export function readStoredModels(db: AppDatabase): ModelEntry[] {
  const raw = getConfigValue(db, 'config.models')
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as ModelEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function migrateMultiServiceModelConfig(db: AppDatabase, models: ModelEntry[]): {
  models: ModelEntry[]
  services: LlmServiceProfile[]
  activeLlmServiceIds: string[]
  preferredLanguageModelId: string
  preferredFastLanguageModelId: string
  preferredVisionModelId: string
} {
  migrateLegacyLlmServicesIfNeeded(db)
  let nextModels = migrateModelEntries(models)
  nextModels = nextModels.map((m) => ({ ...m, isDefault: false }))

  let services = readLlmServices(db)
  const enabledIds = getEnabledModelIds(nextModels)

  services = services.map((s) => ({
    ...s,
    supportedModelIds: s.supportedModelIds?.length ? s.supportedModelIds : [...enabledIds]
  }))

  let activeIds = readActiveLlmServiceIds(db)
  if (activeIds.length === 0) {
    activeIds = services[0]?.id ? [services[0].id] : []
  }
  activeIds = activeIds.filter((id) => services.some((s) => s.id === id))
  if (activeIds.length === 0 && services[0]) activeIds = [services[0].id]

  const defaults = getDefaultPreferredModelIds(nextModels)
  let preferredLanguageModelId = getConfigValue(db, LLM_SERVICE_CONFIG_KEYS.preferredLanguageModelId) ?? ''
  let preferredFastLanguageModelId = getConfigValue(db, LLM_SERVICE_CONFIG_KEYS.preferredFastLanguageModelId) ?? ''
  let preferredVisionModelId = getConfigValue(db, LLM_SERVICE_CONFIG_KEYS.preferredVisionModelId) ?? ''

  if (!preferredLanguageModelId) {
    const legacyDefault = nextModels.find((m) => m.isDefault)
    const legacyName = getConfigValue(db, 'config.defaultModel')
    preferredLanguageModelId =
      legacyDefault?.id ??
      nextModels.find((m) => m.name === legacyName)?.id ??
      defaults.preferredLanguageModelId
  }
  if (!preferredFastLanguageModelId) preferredFastLanguageModelId = defaults.preferredFastLanguageModelId
  if (!preferredVisionModelId) preferredVisionModelId = defaults.preferredVisionModelId

  setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.activeLlmServiceIds, JSON.stringify(activeIds))
  if (activeIds[0]) setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.activeLlmServiceId, activeIds[0])
  setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.preferredLanguageModelId, preferredLanguageModelId)
  setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.preferredFastLanguageModelId, preferredFastLanguageModelId)
  setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.preferredVisionModelId, preferredVisionModelId)
  setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.llmServices, JSON.stringify(
    services.map(({ apiKeyPresent: _ap, ...rest }) => rest)
  ))
  setConfigValue(db, 'config.models', JSON.stringify(nextModels))

  const languageEntry = nextModels.find((m) => m.id === preferredLanguageModelId)
  if (languageEntry) {
    setConfigValue(db, 'config.defaultModel', languageEntry.name)
    setConfigValue(db, 'config.model', languageEntry.name)
  }

  syncActiveServiceMirror(db, services, activeIds[0] ?? '')

  return {
    models: nextModels,
    services: attachApiKeyPresent(services, readLlmServiceKeysMap(db)),
    activeLlmServiceIds: activeIds,
    preferredLanguageModelId,
    preferredFastLanguageModelId,
    preferredVisionModelId
  }
}

export function migrateLegacyLlmServicesIfNeeded(db: AppDatabase): void {
  const existing = getConfigValue(db, LLM_SERVICE_CONFIG_KEYS.llmServices)
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown
      if (Array.isArray(parsed) && parsed.length > 0) return
    } catch {
      /* fall through to migrate */
    }
  }

  const id = randomUUID()
  const baseUrl = getConfigValue(db, LLM_SERVICE_CONFIG_KEYS.baseUrl) ?? ''
  const legacyEnc = getConfigValue(db, LLM_SERVICE_CONFIG_KEYS.apiKeyEnc)
  const ts = nowIso()

  const service: LlmServiceProfile = {
    id,
    name: DEFAULT_LLM_SERVICE_NAME,
    baseUrl,
    apiKeyPresent: Boolean(legacyEnc),
    createdAt: ts,
    updatedAt: ts
  }

  setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.llmServices, JSON.stringify([service]))
  setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.activeLlmServiceId, id)
  setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.activeLlmServiceIds, JSON.stringify([id]))

  const keysMap = readLlmServiceKeysMap(db)
  if (legacyEnc && !keysMap[id]) {
    keysMap[id] = legacyEnc
    writeLlmServiceKeysMap(db, keysMap)
  }
}

export function validateLlmServices(input: ValidateLlmServicesInput): void {
  const { services, activeLlmServiceIds, keysPayload = {}, existingKeys, previousServiceIds } = input

  if (services.length === 0) {
    throw new LlmServiceValidationError('至少保留一套大模型服务')
  }
  if (services.length > MAX_LLM_SERVICES) {
    throw new LlmServiceValidationError(`最多配置 ${MAX_LLM_SERVICES} 套大模型服务`)
  }

  if (activeLlmServiceIds.length === 0) {
    throw new LlmServiceValidationError('至少选择一个当前使用的服务')
  }

  const activeSet = new Set(activeLlmServiceIds)
  for (const id of activeLlmServiceIds) {
    if (!services.some((s) => s.id === id)) {
      throw new LlmServiceValidationError('请选择当前使用的大模型服务')
    }
  }

  const names = new Set<string>()
  for (const s of services) {
    const name = s.name.trim()
    if (!name) {
      throw new LlmServiceValidationError('服务名称不能为空')
    }
    if (name.length > 32) {
      throw new LlmServiceValidationError('服务名称不能超过 32 个字符')
    }
    const key = name.toLowerCase()
    if (names.has(key)) {
      throw new LlmServiceValidationError(`服务名称「${name}」重复`)
    }
    names.add(key)

    try {
      assertValidOptionalAnthropicBaseUrl(s.baseUrl || undefined)
    } catch (e) {
      throw new LlmServiceValidationError(
        e instanceof Error ? e.message : `服务「${name}」的 Base URL 无效`
      )
    }

    const isNew = previousServiceIds ? !previousServiceIds.has(s.id) : false
    const hasDraftKey = Boolean(keysPayload[s.id]?.trim())
    if (isNew && !hasDraftKey) {
      throw new LlmServiceValidationError(`新建服务「${name}」须填写 API Key`)
    }

    if ((s.supportedModelIds?.length ?? 0) === 0) {
      throw new LlmServiceValidationError(`服务「${name}」须至少支持一个模型`)
    }
  }
}

export function syncActiveServiceMirror(
  db: AppDatabase,
  services: LlmServiceProfile[],
  activeId: string
): void {
  const active = services.find((s) => s.id === activeId)
  if (!active) return

  setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.baseUrl, active.baseUrl ?? '')

  const keysMap = readLlmServiceKeysMap(db)
  const enc = keysMap[activeId]
  if (enc) {
    setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.apiKeyEnc, enc)
  } else {
    const row = db.data.configs[LLM_SERVICE_CONFIG_KEYS.apiKeyEnc]
    if (row) {
      delete db.data.configs[LLM_SERVICE_CONFIG_KEYS.apiKeyEnc]
    }
  }
}

export function persistLlmServices(
  db: AppDatabase,
  services: LlmServiceProfile[],
  activeLlmServiceIds: string[],
  keysPayload?: Record<string, string>
): void {
  const previousIds = new Set(readLlmServices(db).map((s) => s.id))
  const existingKeys = readLlmServiceKeysMap(db)

  validateLlmServices({
    services,
    activeLlmServiceIds,
    keysPayload,
    existingKeys,
    previousServiceIds: previousIds
  })

  const ts = nowIso()
  const previousServices = readLlmServices(db)
  const toStore = services.map((s) => {
    const old = previousServices.find((x) => x.id === s.id)
    return {
      id: s.id,
      name: s.name.trim(),
      baseUrl: s.baseUrl.trim(),
      supportedModelIds: s.supportedModelIds ?? old?.supportedModelIds ?? [],
      createdAt: old?.createdAt ?? s.createdAt ?? ts,
      updatedAt: ts
    }
  })

  setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.llmServices, JSON.stringify(toStore))
  setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.activeLlmServiceIds, JSON.stringify(activeLlmServiceIds))
  const primaryActive = activeLlmServiceIds[0] ?? ''
  if (primaryActive) setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.activeLlmServiceId, primaryActive)

  const keysMap = { ...existingKeys }
  if (keysPayload) {
    for (const [id, plain] of Object.entries(keysPayload)) {
      if (plain?.trim()) {
        keysMap[id] = encryptSecret(plain.trim())
      }
    }
  }
  const newIds = new Set(services.map((s) => s.id))
  for (const id of Object.keys(keysMap)) {
    if (!newIds.has(id)) delete keysMap[id]
  }
  writeLlmServiceKeysMap(db, keysMap)

  const withPresent = attachApiKeyPresent(
    toStore.map((s) => ({ ...s, apiKeyPresent: false })),
    keysMap
  )
  syncActiveServiceMirror(db, withPresent, primaryActive)
}

export function getActiveLlmService(db: AppDatabase): {
  id: string
  name: string
  baseUrl: string
  getApiKey: () => Promise<string | null>
} {
  migrateLegacyLlmServicesIfNeeded(db)
  const services = readLlmServices(db)
  const activeIds = readActiveLlmServiceIds(db)
  let activeId = activeIds[0]
  let active = services.find((s) => s.id === activeId)
  if (!active && services.length > 0) {
    active = services[0]
    activeId = active.id
  }
  if (!active || !activeId) {
    return {
      id: '',
      name: '',
      baseUrl: '',
      getApiKey: async () => null
    }
  }
  return {
    id: activeId,
    name: active.name,
    baseUrl: active.baseUrl,
    getApiKey: () => getLlmServiceApiKey(db, activeId)
  }
}

export function resolveLlmCredentialsForModel(
  db: AppDatabase,
  modelName: string,
  options?: { serviceId?: string; models?: ModelEntry[] }
): Promise<{ serviceId: string; baseUrl: string | undefined; getApiKey: () => Promise<string | null>; error?: string }> {
  migrateLegacyLlmServicesIfNeeded(db)
  const services = readLlmServices(db)
  const activeIds = readActiveLlmServiceIds(db)
  const models = options?.models ?? readStoredModels(db)
  const modelEntry = models.find((m) => m.name === modelName)
  if (!modelEntry) {
    return Promise.resolve({ serviceId: '', baseUrl: undefined, getApiKey: async () => null, error: `未知模型「${modelName}」` })
  }

  const keysMap = readLlmServiceKeysMap(db)
  const service = resolveServiceForModel(
    services,
    activeIds,
    modelEntry.id,
    options?.serviceId,
    (id) => Boolean(keysMap[id])
  )

  if (!service) {
    return Promise.resolve({
      serviceId: '',
      baseUrl: undefined,
      getApiKey: async () => null,
      error: `当前无可用服务支持模型「${modelName}」`
    })
  }

  const baseUrl = assertValidOptionalAnthropicBaseUrl(service.baseUrl || undefined)
  return Promise.resolve({
    serviceId: service.id,
    baseUrl,
    getApiKey: () => getLlmServiceApiKey(db, service.id)
  })
}

export function resolveLanguagePreferredModelName(db: AppDatabase, models: ModelEntry[]): string {
  const services = readLlmServices(db)
  const activeIds = readActiveLlmServiceIds(db)
  const available = getAvailableModels(models, services, activeIds)
  const configuredId = getConfigValue(db, LLM_SERVICE_CONFIG_KEYS.preferredLanguageModelId) ?? ''
  const entry = resolvePreferredModelEntry('language', models, available, configuredId)
  return entry?.name ?? models.find((m) => m.id === configuredId)?.name ?? 'deepseek-v4-pro'
}

export function resolveFastPreferredModelName(db: AppDatabase, models: ModelEntry[]): string | null {
  const services = readLlmServices(db)
  const activeIds = readActiveLlmServiceIds(db)
  const available = getAvailableModels(models, services, activeIds)
  const configuredId = getConfigValue(db, LLM_SERVICE_CONFIG_KEYS.preferredFastLanguageModelId) ?? ''
  const fast = resolvePreferredModelEntry('fast', models, available, configuredId)
  if (fast) return fast.name
  const language = resolvePreferredModelEntry(
    'language',
    models,
    available,
    getConfigValue(db, LLM_SERVICE_CONFIG_KEYS.preferredLanguageModelId) ?? ''
  )
  return language?.name ?? null
}

const CONFIG_DEFAULT_MODEL_KEY = 'config.defaultModel'

/** 测试连接：被测服务 supportedModelIds ∩ 已启用模型；优先语言优选（§8.4，不受多服务激活影响） */
export function resolveTestConnectionModel(
  db: AppDatabase,
  models: ModelEntry[],
  serviceId?: string,
  options?: { supportedModelIds?: string[] }
): ModelEntry | undefined {
  if (!serviceId) return undefined

  const services = readLlmServices(db)
  const service = services.find((s) => s.id === serviceId)
  if (!service) return undefined

  const supported = new Set(options?.supportedModelIds ?? service.supportedModelIds ?? [])
  if (supported.size === 0) return undefined

  const candidates = models.filter((m) => m.enabled && supported.has(m.id))
  if (candidates.length === 0) return undefined

  const preferredId = getConfigValue(db, LLM_SERVICE_CONFIG_KEYS.preferredLanguageModelId)
  if (preferredId) {
    const preferred = candidates.find((m) => m.id === preferredId)
    if (preferred) return preferred
  }

  const defaultModelName = getConfigValue(db, CONFIG_DEFAULT_MODEL_KEY)
  if (defaultModelName) {
    const byConfig = candidates.find((m) => m.name === defaultModelName)
    if (byConfig) return byConfig
  }

  return candidates[0]
}

export function resolveTestConnectionCredentials(
  db: AppDatabase,
  options?: { serviceId?: string; apiKey?: string; baseUrl?: string }
): Promise<{ apiKey: string | null; baseUrl: string | undefined; error?: string }> {
  migrateLegacyLlmServicesIfNeeded(db)
  const services = readLlmServices(db)
  const activeIds = readActiveLlmServiceIds(db)
  const serviceId = options?.serviceId ?? activeIds[0] ?? readActiveLlmServiceId(db)
  const service = services.find((s) => s.id === serviceId)

  const draftKey = options?.apiKey?.trim()
  if (draftKey) {
    const baseUrl = assertValidOptionalAnthropicBaseUrl(
      options?.baseUrl !== undefined ? options.baseUrl : service?.baseUrl
    )
    return Promise.resolve({ apiKey: draftKey, baseUrl })
  }

  if (!serviceId) {
    return Promise.resolve({ apiKey: null, baseUrl: undefined, error: '未指定大模型服务' })
  }

  return getLlmServiceApiKey(db, serviceId).then((storedKey) => {
    if (!storedKey) {
      return { apiKey: null, baseUrl: undefined, error: 'API Key 未配置' }
    }
    const baseUrl = assertValidOptionalAnthropicBaseUrl(
      options?.baseUrl !== undefined ? options.baseUrl : service?.baseUrl
    )
    return { apiKey: storedKey, baseUrl }
  })
}
