import { randomUUID } from 'crypto'
import type { LlmServiceProfile, ModelEntry } from '../src/shared/domainTypes'
import type { AppDatabase } from './database'
import { getConfigValue, setConfigValue } from './database'
import { assertValidOptionalAnthropicBaseUrl } from './claudeRequestGuards'
import { decryptSecret, encryptSecret, isSecretStorageAvailable } from './secureApiKey'

export const LLM_SERVICE_CONFIG_KEYS = {
  llmServices: 'config.llmServices',
  activeLlmServiceId: 'config.activeLlmServiceId',
  llmServiceKeys: 'secrets.llmServiceKeys',
  baseUrl: 'config.baseUrl',
  apiKeyEnc: 'secrets.apiKeyEnc'
} as const

export const MAX_LLM_SERVICES = 10
export const DEFAULT_LLM_SERVICE_NAME = '默认服务'

export type LlmServiceKeysMap = Record<string, string>

export type ValidateLlmServicesInput = {
  services: LlmServiceProfile[]
  activeLlmServiceId: string
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
      out.push({
        id,
        name,
        baseUrl: typeof o.baseUrl === 'string' ? o.baseUrl : '',
        apiKeyPresent: false,
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

  const keysMap = readLlmServiceKeysMap(db)
  if (legacyEnc && !keysMap[id]) {
    keysMap[id] = legacyEnc
    writeLlmServiceKeysMap(db, keysMap)
  }
}

export function validateLlmServices(input: ValidateLlmServicesInput): void {
  const { services, activeLlmServiceId, keysPayload = {}, existingKeys, previousServiceIds } = input

  if (services.length === 0) {
    throw new LlmServiceValidationError('至少保留一套大模型服务')
  }
  if (services.length > MAX_LLM_SERVICES) {
    throw new LlmServiceValidationError(`最多配置 ${MAX_LLM_SERVICES} 套大模型服务`)
  }

  const active = services.find((s) => s.id === activeLlmServiceId)
  if (!active) {
    throw new LlmServiceValidationError('请选择当前使用的大模型服务')
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
    const hasStoredKey = Boolean(existingKeys[s.id]) || Boolean(keysPayload[s.id]?.trim())
    const hasDraftKey = Boolean(keysPayload[s.id]?.trim())
    if (isNew && !hasDraftKey) {
      throw new LlmServiceValidationError(`新建服务「${name}」须填写 API Key`)
    }
    if (!isNew && !s.apiKeyPresent && !hasDraftKey) {
      /* allow services without key only if they had key before - apiKeyPresent tracks stored */
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
  activeLlmServiceId: string,
  keysPayload?: Record<string, string>
): void {
  const previousIds = new Set(readLlmServices(db).map((s) => s.id))
  const existingKeys = readLlmServiceKeysMap(db)

  validateLlmServices({
    services,
    activeLlmServiceId,
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
      createdAt: old?.createdAt ?? s.createdAt ?? ts,
      updatedAt: ts
    }
  })

  setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.llmServices, JSON.stringify(toStore))
  setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.activeLlmServiceId, activeLlmServiceId)

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
  syncActiveServiceMirror(db, withPresent, activeLlmServiceId)
}

export function getActiveLlmService(db: AppDatabase): {
  id: string
  name: string
  baseUrl: string
  getApiKey: () => Promise<string | null>
} {
  migrateLegacyLlmServicesIfNeeded(db)
  const services = readLlmServices(db)
  let activeId = readActiveLlmServiceId(db)
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

const CONFIG_DEFAULT_MODEL_KEY = 'config.defaultModel'

/** 测试连接所用模型：优先默认模型，避免误用列表中第一个 enabled 项（如 kimi-k2.6）。 */
export function resolveTestConnectionModel(
  db: AppDatabase,
  models: ModelEntry[]
): ModelEntry | undefined {
  const enabled = models.filter((m) => m.enabled)
  if (enabled.length === 0) return undefined

  const byDefaultFlag = enabled.find((m) => m.isDefault)
  if (byDefaultFlag) return byDefaultFlag

  const defaultModelName = getConfigValue(db, CONFIG_DEFAULT_MODEL_KEY)
  if (defaultModelName) {
    const byConfig = enabled.find((m) => m.name === defaultModelName)
    if (byConfig) return byConfig
  }

  return enabled[0]
}

export function resolveTestConnectionCredentials(
  db: AppDatabase,
  options?: { serviceId?: string; apiKey?: string; baseUrl?: string }
): Promise<{ apiKey: string | null; baseUrl: string | undefined; error?: string }> {
  migrateLegacyLlmServicesIfNeeded(db)
  const services = readLlmServices(db)
  const activeId = readActiveLlmServiceId(db)
  const serviceId = options?.serviceId ?? activeId
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
