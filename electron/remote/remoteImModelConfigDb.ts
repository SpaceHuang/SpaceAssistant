import type { AppDatabase } from '../database'
import { getConfigValue, getDbConnection, setConfigValue } from '../database'
import { runInTransaction } from '../database/transaction'
import type { ModelEntry } from '../../src/shared/domainTypes'
import { mergeFeishuConfig, type FeishuConfig } from '../../src/shared/feishuTypes'
import { mergeWeChatConfig, type WeChatConfig } from '../../src/shared/wechatTypes'
import { CURRENT_REMOTE_MODEL_CONFIG_VERSION } from '../../src/shared/imTypes'
import { readStoredModels, resolveLanguagePreferredModelName } from '../llmServiceResolver'
import { logAgentEvent } from '../agentLogger/agentLogger'

const FEISHU_CONFIG_KEY = 'config.feishu'
const WECHAT_CONFIG_KEY = 'config.wechat'
const MIGRATION_MARKER_KEY = 'config.remoteImModelConfigVersion'

type ModelConfigFields = Pick<FeishuConfig, 'remoteModelSelectionMode' | 'remoteDefaultModelId' | 'remoteThinkingEffort'>

function readRaw<T>(db: AppDatabase, key: string): T {
  const raw = getConfigValue(db, key)
  if (!raw) return {} as T
  try { return JSON.parse(raw) as T } catch { return {} as T }
}

function normalizeFeishuModelConfig(db: AppDatabase, raw: Partial<FeishuConfig>, models: ModelEntry[]): ModelConfigFields {
  const defaultName = resolveLanguagePreferredModelName(db, models)
  const defaultEntry = models.find((model) => model.name === defaultName)
  const oldValue = raw.remoteDefaultModelId?.trim()
  const oldEntry = oldValue ? models.find((model) => model.id === oldValue || model.name === oldValue) : undefined
  const mode = raw.remoteModelSelectionMode ?? (oldEntry ? 'explicit' : 'inherit')
  return {
    remoteModelSelectionMode: mode,
    ...(mode === 'explicit'
      ? (oldEntry ? { remoteDefaultModelId: oldEntry.id } : oldValue ? { remoteDefaultModelId: oldValue } : {})
      : (defaultEntry ? { remoteDefaultModelId: defaultEntry.id } : {})),
    remoteThinkingEffort: raw.remoteThinkingEffort && ['off', 'low', 'medium', 'high', 'xhigh'].includes(raw.remoteThinkingEffort)
      ? raw.remoteThinkingEffort
      : 'low'
  }
}

/** Normalize both channel configs before any production IM caller consumes either one. */
export function ensureRemoteImModelConfigMigrated(db: AppDatabase): void {
  const version = Number(getConfigValue(db, MIGRATION_MARKER_KEY) ?? 0)
  if (version >= CURRENT_REMOTE_MODEL_CONFIG_VERSION) return

  let legacyModelMatched = false
  let priorSelectionMode: string | undefined
  let didMigrate = false
  runInTransaction(getDbConnection(db), () => {
    const currentVersion = Number(getConfigValue(db, MIGRATION_MARKER_KEY) ?? 0)
    if (currentVersion >= CURRENT_REMOTE_MODEL_CONFIG_VERSION) return

    const feishuRaw = readRaw<Partial<FeishuConfig>>(db, FEISHU_CONFIG_KEY)
    const wechatRaw = readRaw<Partial<WeChatConfig>>(db, WECHAT_CONFIG_KEY)
    const models = readStoredModels(db)
    priorSelectionMode = feishuRaw.remoteModelSelectionMode
    const legacyValue = feishuRaw.remoteDefaultModelId?.trim()
    legacyModelMatched = Boolean(legacyValue && models.some((model) => model.id === legacyValue || model.name === legacyValue))
    const common = normalizeFeishuModelConfig(db, feishuRaw, models)
    const feishu = mergeFeishuConfig({ ...feishuRaw, ...common })
    const wechat = mergeWeChatConfig({ ...wechatRaw, ...common })

    setConfigValue(db, FEISHU_CONFIG_KEY, JSON.stringify(feishu))
    setConfigValue(db, WECHAT_CONFIG_KEY, JSON.stringify(wechat))
    setConfigValue(db, MIGRATION_MARKER_KEY, String(CURRENT_REMOTE_MODEL_CONFIG_VERSION))
    didMigrate = true
  })
  if (!didMigrate) return
  logAgentEvent('info', 'remote_im.model_config_migrated', {
    source: 'feishu',
    fromVersion: version,
    toVersion: CURRENT_REMOTE_MODEL_CONFIG_VERSION,
    outcome: 'completed',
    previousSelectionMode: priorSelectionMode ?? 'missing',
    legacyModelMatched
  })
}

export const remoteImModelConfigDbKeys = {
  feishu: FEISHU_CONFIG_KEY,
  wechat: WECHAT_CONFIG_KEY,
  marker: MIGRATION_MARKER_KEY
} as const
