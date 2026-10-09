import { afterEach, describe, expect, it } from 'vitest'
import { getConfigValue, getDbConnection, setConfigValue } from '../database'
import { createTempDatabase } from '../database/testHelpers'
import { normalizeModelEntry } from '../../src/shared/llmModelConfig'
import { ensureRemoteImModelConfigMigrated, remoteImModelConfigDbKeys } from './remoteImModelConfigDb'

describe('ensureRemoteImModelConfigMigrated', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

  it('uses the Feishu legacy model choice for both channels without opening settings', () => {
    const { db, cleanup } = createTempDatabase('remote-im-model-migration-')
    cleanups.push(cleanup)
    const models = [normalizeModelEntry({ id: 'model-a', name: 'provider-a' }), normalizeModelEntry({ id: 'model-b', name: 'provider-b' })]
    setConfigValue(db, 'config.models', JSON.stringify(models))
    setConfigValue(db, remoteImModelConfigDbKeys.feishu, JSON.stringify({ remoteDefaultModelId: 'model-a', remoteEnabled: true }))
    setConfigValue(db, remoteImModelConfigDbKeys.wechat, JSON.stringify({ remoteDefaultModelId: 'model-b', remoteEnabled: true }))

    ensureRemoteImModelConfigMigrated(db)

    expect(JSON.parse(getConfigValue(db, remoteImModelConfigDbKeys.feishu)!)).toMatchObject({ remoteModelSelectionMode: 'explicit', remoteDefaultModelId: 'model-a', remoteThinkingEffort: 'low' })
    expect(JSON.parse(getConfigValue(db, remoteImModelConfigDbKeys.wechat)!)).toMatchObject({ remoteModelSelectionMode: 'explicit', remoteDefaultModelId: 'model-a', remoteThinkingEffort: 'low' })
    expect(getConfigValue(db, remoteImModelConfigDbKeys.marker)).toBe('1')
  })

  it('rolls back both config writes and the marker when either channel write fails', () => {
    const { db, cleanup } = createTempDatabase('remote-im-model-migration-failure-')
    cleanups.push(cleanup)
    setConfigValue(db, remoteImModelConfigDbKeys.feishu, JSON.stringify({ remoteDefaultModelId: 'legacy-feishu' }))
    setConfigValue(db, remoteImModelConfigDbKeys.wechat, JSON.stringify({ remoteDefaultModelId: 'legacy-wechat' }))
    getDbConnection(db).exec("CREATE TRIGGER fail_wechat_model_migration BEFORE UPDATE ON configs WHEN NEW.key = 'config.wechat' BEGIN SELECT RAISE(ABORT, 'write failed'); END")

    expect(() => ensureRemoteImModelConfigMigrated(db)).toThrow()
    expect(JSON.parse(getConfigValue(db, remoteImModelConfigDbKeys.feishu)!)).toEqual({ remoteDefaultModelId: 'legacy-feishu' })
    expect(JSON.parse(getConfigValue(db, remoteImModelConfigDbKeys.wechat)!)).toEqual({ remoteDefaultModelId: 'legacy-wechat' })
    expect(getConfigValue(db, remoteImModelConfigDbKeys.marker)).toBeUndefined()
  })

  it('always uses Feishu as the migration source when only WeChat has a legacy value', () => {
    const { db, cleanup } = createTempDatabase('remote-im-model-migration-wechat-only-')
    cleanups.push(cleanup)
    const models = [normalizeModelEntry({ id: 'model-a', name: 'provider-a' })]
    setConfigValue(db, 'config.models', JSON.stringify(models))
    setConfigValue(db, remoteImModelConfigDbKeys.feishu, JSON.stringify({ remoteEnabled: true }))
    setConfigValue(db, remoteImModelConfigDbKeys.wechat, JSON.stringify({ remoteDefaultModelId: 'model-a', remoteEnabled: true }))

    ensureRemoteImModelConfigMigrated(db)

    expect(JSON.parse(getConfigValue(db, remoteImModelConfigDbKeys.feishu)!)).toMatchObject({ remoteModelSelectionMode: 'inherit' })
    expect(JSON.parse(getConfigValue(db, remoteImModelConfigDbKeys.wechat)!)).toMatchObject({ remoteModelSelectionMode: 'inherit' })
  })

  it('is idempotent and does not overwrite a completed shared choice', () => {
    const { db, cleanup } = createTempDatabase('remote-im-model-migration-repeat-')
    cleanups.push(cleanup)
    setConfigValue(db, remoteImModelConfigDbKeys.feishu, JSON.stringify({ remoteModelSelectionMode: 'explicit', remoteDefaultModelId: 'chosen' }))
    setConfigValue(db, remoteImModelConfigDbKeys.wechat, JSON.stringify({ remoteModelSelectionMode: 'explicit', remoteDefaultModelId: 'chosen' }))
    ensureRemoteImModelConfigMigrated(db)
    setConfigValue(db, remoteImModelConfigDbKeys.feishu, JSON.stringify({ remoteModelSelectionMode: 'explicit', remoteDefaultModelId: 'later-user-choice' }))

    ensureRemoteImModelConfigMigrated(db)

    expect(JSON.parse(getConfigValue(db, remoteImModelConfigDbKeys.feishu)!)).toMatchObject({ remoteDefaultModelId: 'later-user-choice' })
  })
})
