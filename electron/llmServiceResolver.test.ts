import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase, getConfigValue, setConfigValue, type AppDatabase } from './database'
import {
  DEFAULT_LLM_SERVICE_NAME,
  LLM_SERVICE_CONFIG_KEYS,
  LlmServiceValidationError,
  MAX_LLM_SERVICES,
  migrateLegacyLlmServicesIfNeeded,
  migrateMultiServiceModelConfig,
  persistLlmServices,
  readLlmServices,
  readLlmServiceKeysMap,
  readActiveLlmServiceIds,
  resolveLanguagePreferredModelName,
  resolveLlmCredentialsForModel,
  resolveTestConnectionModel,
  validateLlmServices
} from './llmServiceResolver'
import type { ModelEntry } from '../src/shared/domainTypes'
import { DEFAULT_MODELS } from '../src/shared/domainTypes'

vi.mock('./secureApiKey', () => ({
  isSecretStorageAvailable: () => true,
  encryptSecret: (plain: string) => `enc:${plain}`,
  decryptSecret: (b64: string) => b64.replace(/^enc:/, '')
}))

function makeModels(): ModelEntry[] {
  return DEFAULT_MODELS.map((m, i) => ({ id: String(i + 1), ...m }))
}

describe('llmServiceResolver', () => {
  let dbPath: string
  let db: AppDatabase

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `sa-llm-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    db = openDatabase(dbPath)
  })

  afterEach(() => {
    try {
      fs.unlinkSync(dbPath)
    } catch {
      /* ignore */
    }
  })

  it('migrates legacy apiKeyEnc and baseUrl into default service', () => {
    setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.apiKeyEnc, 'enc:sk-test')
    setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.baseUrl, 'https://proxy.example.com')

    migrateLegacyLlmServicesIfNeeded(db)

    const services = readLlmServices(db)
    expect(services).toHaveLength(1)
    expect(services[0]!.name).toBe(DEFAULT_LLM_SERVICE_NAME)
    expect(services[0]!.baseUrl).toBe('https://proxy.example.com')
    expect(services[0]!.apiKeyPresent).toBe(true)

    const activeIds = readActiveLlmServiceIds(db)
    expect(activeIds).toEqual([services[0]!.id])

    const keys = readLlmServiceKeysMap(db)
    expect(keys[services[0]!.id]).toBe('enc:sk-test')
  })

  it('does not migrate when llmServices already exists', () => {
    const existing = [{ id: 's1', name: 'A', baseUrl: '', createdAt: '1', updatedAt: '1' }]
    setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.llmServices, JSON.stringify(existing))
    setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.activeLlmServiceId, 's1')
    setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.activeLlmServiceIds, JSON.stringify(['s1']))

    migrateLegacyLlmServicesIfNeeded(db)

    expect(readLlmServices(db)).toHaveLength(1)
    expect(readLlmServices(db)[0]!.name).toBe('A')
  })

  it('mirrors first active service to apiKeyEnc and baseUrl on persist', () => {
    migrateLegacyLlmServicesIfNeeded(db)
    const id = crypto.randomUUID()
    const services = [
      {
        id,
        name: 'Plan B',
        baseUrl: 'https://b.example.com',
        apiKeyPresent: false,
        supportedModelIds: ['1']
      }
    ]
    persistLlmServices(db, services, [id], { [id]: 'sk-b-key' })

    expect(getConfigValue(db, LLM_SERVICE_CONFIG_KEYS.baseUrl)).toBe('https://b.example.com')
    expect(getConfigValue(db, LLM_SERVICE_CONFIG_KEYS.apiKeyEnc)).toBe(`enc:sk-b-key`)
  })

  it('supports multiple active services', () => {
    migrateLegacyLlmServicesIfNeeded(db)
    const s1 = readLlmServices(db)[0]!
    const s2id = crypto.randomUUID()
    persistLlmServices(
      db,
      [
        { ...s1, supportedModelIds: ['1', '2'] },
        { id: s2id, name: 'Second', baseUrl: '', apiKeyPresent: false, supportedModelIds: ['3'] }
      ],
      [s1.id, s2id],
      { [s2id]: 'sk-2' }
    )
    expect(readActiveLlmServiceIds(db)).toEqual([s1.id, s2id])
  })

  it('rejects duplicate service names', () => {
    migrateLegacyLlmServicesIfNeeded(db)
    const services = readLlmServices(db)
    const s2id = crypto.randomUUID()
    const next = [
      { ...services[0]!, supportedModelIds: ['1'] },
      { id: s2id, name: services[0]!.name, baseUrl: '', apiKeyPresent: false, supportedModelIds: ['1'] }
    ]
    expect(() =>
      validateLlmServices({
        services: next,
        activeLlmServiceIds: [services[0]!.id],
        existingKeys: readLlmServiceKeysMap(db),
        previousServiceIds: new Set(services.map((s) => s.id))
      })
    ).toThrow(LlmServiceValidationError)
  })

  it('requires api key for new services', () => {
    const id = crypto.randomUUID()
    expect(() =>
      validateLlmServices({
        services: [{ id, name: 'New', baseUrl: '', apiKeyPresent: false, supportedModelIds: ['1'] }],
        activeLlmServiceIds: [id],
        existingKeys: {},
        previousServiceIds: new Set()
      })
    ).toThrow(/须填写 API Key/)
  })

  it('requires every service to support at least one model', () => {
    migrateLegacyLlmServicesIfNeeded(db)
    const s = readLlmServices(db)[0]!
    expect(() =>
      validateLlmServices({
        services: [{ ...s, supportedModelIds: [] }],
        activeLlmServiceIds: [s.id],
        existingKeys: readLlmServiceKeysMap(db),
        previousServiceIds: new Set([s.id])
      })
    ).toThrow(/须至少支持一个模型/)
  })

  it('requires inactive service to support at least one model', () => {
    migrateLegacyLlmServicesIfNeeded(db)
    const services = readLlmServices(db)
    const s1 = services[0]!
    const s2id = crypto.randomUUID()
    expect(() =>
      validateLlmServices({
        services: [
          { ...s1, supportedModelIds: ['1'] },
          { id: s2id, name: 'Inactive Empty', baseUrl: '', apiKeyPresent: true, supportedModelIds: [] }
        ],
        activeLlmServiceIds: [s1.id],
        keysPayload: { [s2id]: 'sk-test' },
        existingKeys: readLlmServiceKeysMap(db),
        previousServiceIds: new Set([s1.id])
      })
    ).toThrow(/须至少支持一个模型/)
  })

  it('removes keys for deleted services on persist', () => {
    migrateLegacyLlmServicesIfNeeded(db)
    const s1 = readLlmServices(db)[0]!
    const s2id = crypto.randomUUID()
    persistLlmServices(
      db,
      [
        { ...s1, supportedModelIds: ['1'] },
        { id: s2id, name: 'Second', baseUrl: '', apiKeyPresent: false, supportedModelIds: ['2'] }
      ],
      [s1.id],
      { [s2id]: 'sk-2' }
    )
    expect(readLlmServiceKeysMap(db)[s2id]).toBeDefined()

    persistLlmServices(db, [{ ...s1, supportedModelIds: ['1'] }], [s1.id])
    expect(readLlmServiceKeysMap(db)[s2id]).toBeUndefined()
  })

  it('enforces max services limit', () => {
    const services = Array.from({ length: MAX_LLM_SERVICES + 1 }, (_, i) => ({
      id: `id-${i}`,
      name: `S${i}`,
      baseUrl: '',
      apiKeyPresent: true,
      supportedModelIds: ['1']
    }))
    expect(() =>
      validateLlmServices({
        services,
        activeLlmServiceIds: ['id-0'],
        existingKeys: Object.fromEntries(services.map((s) => [s.id, 'enc:x'])),
        previousServiceIds: new Set()
      })
    ).toThrow(/最多配置/)
  })

  it('migrateMultiServiceModelConfig sets supportedModelIds and preferred ids', () => {
    migrateLegacyLlmServicesIfNeeded(db)
    const models = makeModels()
    const result = migrateMultiServiceModelConfig(db, models)
    expect(result.services[0]!.supportedModelIds?.length).toBeGreaterThan(0)
    expect(result.preferredLanguageModelId).toBeTruthy()
    expect(result.models.every((m) => m.isDefault === false)).toBe(true)
    expect(result.models.find((m) => m.name === 'kimi-k2.6')?.isVision).toBe(true)
  })

  it('resolveTestConnectionModel uses service intersection and language preferred', () => {
    migrateLegacyLlmServicesIfNeeded(db)
    const models = makeModels()
    migrateMultiServiceModelConfig(db, models)
    const s = readLlmServices(db)[0]!
    const pro = models.find((m) => m.name === 'deepseek-v4-pro')!
    setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.preferredLanguageModelId, pro.id)
    persistLlmServices(db, [{ ...s, supportedModelIds: [pro.id, '2'] }], [s.id])
    expect(resolveTestConnectionModel(db, models, s.id)?.name).toBe('deepseek-v4-pro')
  })

  it('resolveTestConnectionModel for inactive service uses its own supported models', () => {
    migrateLegacyLlmServicesIfNeeded(db)
    const models = makeModels()
    migrateMultiServiceModelConfig(db, models)
    const s1 = readLlmServices(db)[0]!
    const s2id = crypto.randomUUID()
    const kimi = models.find((m) => m.name === 'kimi-k2.6')!
    const pro = models.find((m) => m.name === 'deepseek-v4-pro')!
    setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.preferredLanguageModelId, pro.id)
    persistLlmServices(
      db,
      [
        { ...s1, supportedModelIds: [pro.id] },
        { id: s2id, name: 'Plan B', baseUrl: '', apiKeyPresent: false, supportedModelIds: [kimi.id] }
      ],
      [s1.id],
      { [s2id]: 'sk-b' }
    )
    expect(resolveTestConnectionModel(db, models, s2id)?.name).toBe('kimi-k2.6')
  })

  it('resolveTestConnectionModel accepts draft supportedModelIds override', () => {
    migrateLegacyLlmServicesIfNeeded(db)
    const models = makeModels()
    migrateMultiServiceModelConfig(db, models)
    const s = readLlmServices(db)[0]!
    const flash = models.find((m) => m.name === 'deepseek-v4-flash')!
    persistLlmServices(db, [{ ...s, supportedModelIds: ['1'] }], [s.id])
    expect(
      resolveTestConnectionModel(db, models, s.id, { supportedModelIds: [flash.id] })?.name
    ).toBe('deepseek-v4-flash')
  })

  it('resolveTestConnectionModel falls back when preferred not in this service', () => {
    migrateLegacyLlmServicesIfNeeded(db)
    const models = makeModels()
    migrateMultiServiceModelConfig(db, models)
    const s1 = readLlmServices(db)[0]!
    const s2id = crypto.randomUUID()
    const kimi = models.find((m) => m.name === 'kimi-k2.6')!
    const pro = models.find((m) => m.name === 'deepseek-v4-pro')!
    setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.preferredLanguageModelId, pro.id)
    persistLlmServices(
      db,
      [
        { ...s1, supportedModelIds: [pro.id] },
        { id: s2id, name: 'Volcano', baseUrl: '', apiKeyPresent: false, supportedModelIds: [kimi.id] }
      ],
      [s1.id, s2id],
      { [s2id]: 'sk-volcano' }
    )
    expect(resolveTestConnectionModel(db, models, s2id)?.name).toBe('kimi-k2.6')
  })

  it('resolveLlmCredentialsForModel picks first matching active service', async () => {
    migrateLegacyLlmServicesIfNeeded(db)
    const models = makeModels()
    migrateMultiServiceModelConfig(db, models)
    const s = readLlmServices(db)[0]!
    const pro = models.find((m) => m.name === 'deepseek-v4-pro')!
    persistLlmServices(db, [{ ...s, supportedModelIds: [pro.id] }], [s.id], { [s.id]: 'sk-test' })
    const creds = await resolveLlmCredentialsForModel(db, 'deepseek-v4-pro', { models })
    expect(creds.serviceId).toBe(s.id)
    expect(await creds.getApiKey()).toBe('sk-test')
  })

  it('resolveLanguagePreferredModelName returns deepseek-v4-pro by default', () => {
    migrateLegacyLlmServicesIfNeeded(db)
    const models = makeModels()
    migrateMultiServiceModelConfig(db, models)
    expect(resolveLanguagePreferredModelName(db, models)).toBe('deepseek-v4-pro')
  })
})
