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
  persistLlmServices,
  readLlmServices,
  readLlmServiceKeysMap,
  resolveTestConnectionModel,
  validateLlmServices
} from './llmServiceResolver'
import type { ModelEntry } from '../src/shared/domainTypes'

vi.mock('./secureApiKey', () => ({
  isSecretStorageAvailable: () => true,
  encryptSecret: (plain: string) => `enc:${plain}`,
  decryptSecret: (b64: string) => b64.replace(/^enc:/, '')
}))

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

    const activeId = getConfigValue(db, LLM_SERVICE_CONFIG_KEYS.activeLlmServiceId)
    expect(activeId).toBe(services[0]!.id)

    const keys = readLlmServiceKeysMap(db)
    expect(keys[services[0]!.id]).toBe('enc:sk-test')
  })

  it('does not migrate when llmServices already exists', () => {
    const existing = [{ id: 's1', name: 'A', baseUrl: '', createdAt: '1', updatedAt: '1' }]
    setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.llmServices, JSON.stringify(existing))
    setConfigValue(db, LLM_SERVICE_CONFIG_KEYS.activeLlmServiceId, 's1')

    migrateLegacyLlmServicesIfNeeded(db)

    expect(readLlmServices(db)).toHaveLength(1)
    expect(readLlmServices(db)[0]!.name).toBe('A')
  })

  it('mirrors active service to apiKeyEnc and baseUrl on persist', () => {
    migrateLegacyLlmServicesIfNeeded(db)
    const id = crypto.randomUUID()
    const services = [
      {
        id,
        name: 'Plan B',
        baseUrl: 'https://b.example.com',
        apiKeyPresent: false
      }
    ]
    persistLlmServices(db, services, id, { [id]: 'sk-b-key' })

    expect(getConfigValue(db, LLM_SERVICE_CONFIG_KEYS.baseUrl)).toBe('https://b.example.com')
    expect(getConfigValue(db, LLM_SERVICE_CONFIG_KEYS.apiKeyEnc)).toBe(`enc:sk-b-key`)
  })

  it('rejects duplicate service names', () => {
    migrateLegacyLlmServicesIfNeeded(db)
    const services = readLlmServices(db)
    const s2id = crypto.randomUUID()
    const next = [
      ...services,
      { id: s2id, name: services[0]!.name, baseUrl: '', apiKeyPresent: false }
    ]
    expect(() =>
      validateLlmServices({
        services: next,
        activeLlmServiceId: services[0]!.id,
        existingKeys: readLlmServiceKeysMap(db),
        previousServiceIds: new Set(services.map((s) => s.id))
      })
    ).toThrow(LlmServiceValidationError)
  })

  it('requires api key for new services', () => {
    const id = crypto.randomUUID()
    expect(() =>
      validateLlmServices({
        services: [{ id, name: 'New', baseUrl: '', apiKeyPresent: false }],
        activeLlmServiceId: id,
        existingKeys: {},
        previousServiceIds: new Set()
      })
    ).toThrow(/须填写 API Key/)
  })

  it('removes keys for deleted services on persist', () => {
    migrateLegacyLlmServicesIfNeeded(db)
    const s1 = readLlmServices(db)[0]!
    const s2id = crypto.randomUUID()
    persistLlmServices(
      db,
      [
        s1,
        { id: s2id, name: 'Second', baseUrl: '', apiKeyPresent: false }
      ],
      s1.id,
      { [s2id]: 'sk-2' }
    )
    expect(readLlmServiceKeysMap(db)[s2id]).toBeDefined()

    persistLlmServices(db, [s1], s1.id)
    expect(readLlmServiceKeysMap(db)[s2id]).toBeUndefined()
  })

  it('enforces max services limit', () => {
    const services = Array.from({ length: MAX_LLM_SERVICES + 1 }, (_, i) => ({
      id: `id-${i}`,
      name: `S${i}`,
      baseUrl: '',
      apiKeyPresent: true
    }))
    expect(() =>
      validateLlmServices({
        services,
        activeLlmServiceId: 'id-0',
        existingKeys: Object.fromEntries(services.map((s) => [s.id, 'enc:x'])),
        previousServiceIds: new Set()
      })
    ).toThrow(/最多配置/)
  })

  it('resolveTestConnectionModel prefers default model over first enabled', () => {
    const models: ModelEntry[] = [
      { id: '1', name: 'kimi-k2.6', maximumContext: 1, maxTokens: 1, isDefault: false, isFast: false, enabled: true },
      { id: '2', name: 'glm-5.1', maximumContext: 1, maxTokens: 1, isDefault: true, isFast: false, enabled: true },
      { id: '3', name: 'claude-sonnet-4-6', maximumContext: 1, maxTokens: 1, isDefault: false, isFast: false, enabled: true }
    ]
    expect(resolveTestConnectionModel(db, models)?.name).toBe('glm-5.1')
  })

  it('resolveTestConnectionModel falls back to config.defaultModel when no isDefault flag', () => {
    const models: ModelEntry[] = [
      { id: '1', name: 'kimi-k2.6', maximumContext: 1, maxTokens: 1, isDefault: false, isFast: false, enabled: true },
      { id: '2', name: 'claude-sonnet-4-6', maximumContext: 1, maxTokens: 1, isDefault: false, isFast: false, enabled: true }
    ]
    setConfigValue(db, 'config.defaultModel', 'claude-sonnet-4-6')
    expect(resolveTestConnectionModel(db, models)?.name).toBe('claude-sonnet-4-6')
  })

  it('resolveTestConnectionModel returns undefined when no enabled models', () => {
    const models: ModelEntry[] = [
      { id: '1', name: 'kimi-k2.6', maximumContext: 1, maxTokens: 1, isDefault: false, isFast: false, enabled: false }
    ]
    expect(resolveTestConnectionModel(db, models)).toBeUndefined()
  })
})
