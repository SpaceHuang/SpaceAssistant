import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getConfigValue, type AppDatabase } from '../database'
import { createTempDatabase } from '../database/testHelpers'
import { commitRemoteSecurityConfig } from './remoteSecurityConfigDb'
import { buildRemoteSecurityPreset } from '../../src/shared/remoteSecurityMigration'
import { CURRENT_REMOTE_SECURITY_CONFIG_VERSION } from '../../src/shared/imTypes'

const FEISHU_CONFIG_KEY = 'config.feishu'
const WECHAT_CONFIG_KEY = 'config.wechat'

describe('commitRemoteSecurityConfig', () => {
  let db: AppDatabase
  let cleanup: () => void

  beforeEach(() => {
    const temp = createTempDatabase('sa-remsec-')
    db = temp.db
    cleanup = temp.cleanup
  })

  afterEach(() => cleanup())

  it('writes version + preset source to both channels atomically', () => {
    const patch = buildRemoteSecurityPreset('recommended', { isNewInstall: true })
    const result = commitRemoteSecurityConfig(db, patch)

    expect(result.feishu.remoteSecurityConfigVersion).toBe(CURRENT_REMOTE_SECURITY_CONFIG_VERSION)
    expect(result.wechat.remoteSecurityConfigVersion).toBe(CURRENT_REMOTE_SECURITY_CONFIG_VERSION)
    expect(result.feishu.remoteSecurityPresetSource).toBe('new-install')
    expect(result.feishu.larkCliWriteRequiresConfirm).toBe(true)
    expect(result.feishu.remoteScriptRequiresConfirm).toBe(false)
    expect(result.wechat.remoteScriptRequiresConfirm).toBe(false)

    const storedFeishu = JSON.parse(getConfigValue(db, FEISHU_CONFIG_KEY)!)
    const storedWeChat = JSON.parse(getConfigValue(db, WECHAT_CONFIG_KEY)!)
    expect(storedFeishu.remoteSecurityConfigVersion).toBe(CURRENT_REMOTE_SECURITY_CONFIG_VERSION)
    expect(storedWeChat.remoteSecurityConfigVersion).toBe(CURRENT_REMOTE_SECURITY_CONFIG_VERSION)
  })

  it('rolls back all writes if wechat write fails (no partial version bump)', () => {
    const patch = buildRemoteSecurityPreset('safer', { isNewInstall: false })
    expect(() =>
      commitRemoteSecurityConfig(db, patch, {
        beforeWeChatWrite: () => {
          throw new Error('boom')
        }
      })
    ).toThrow('boom')

    // Feishu write must be rolled back — no persisted config version anywhere.
    expect(getConfigValue(db, FEISHU_CONFIG_KEY)).toBeUndefined()
    expect(getConfigValue(db, WECHAT_CONFIG_KEY)).toBeUndefined()
  })

  it('preserves pre-existing unrelated config fields', () => {
    const patch = buildRemoteSecurityPreset('recommended', { isNewInstall: false })
    // Seed a feishu config with an unrelated field.
    commitRemoteSecurityConfig(db, patch)
    const first = JSON.parse(getConfigValue(db, FEISHU_CONFIG_KEY)!)
    expect(first.region).toBeDefined()
  })
})
