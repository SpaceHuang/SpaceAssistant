import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getConfigValue, setConfigValue } from '../database'
import { getDbConnection } from '../database'
import { createRemoteAuthorizationEpochStore } from '../remote/remoteAuthorizationEpochStore'
import { remoteAuthorizationRegistry } from '../remote/remoteAuthorizationRegistry'
import { persistFeishuConfig } from './feishuIpc'

describe('Feishu configuration persistence', () => {
  it('migrates legacy security settings before stripping them from channel JSON', () => {
    const db = createMemoryAppDb()
    setConfigValue(db, 'config.wechat', JSON.stringify({
      enabled: true, loggedIn: true, remoteEnabled: true, remoteSenderAllowlist: ['bound-user@wechat'],
      remoteAllowLocalWrite: false, remoteDenyOutbound: true, remoteBrowserRequiresConfirm: true,
      remoteScriptRequiresConfirm: true
    }))
    setConfigValue(db, 'config.feishu', JSON.stringify({
      enabled: true, appConfigured: true, userAuthorized: true, remoteEnabled: true, remoteSenderAllowlist: ['ou_owner'],
      remoteAllowLocalWrite: true, remoteDenyOutbound: false, remoteBrowserRequiresConfirm: false,
      remoteScriptRequiresConfirm: false, larkCliWriteRequiresConfirm: true,
      remoteSecurityConfigVersion: 1, remoteSecurityPresetSource: 'custom'
    }))
    remoteAuthorizationRegistry.bindPersistentEpochStore(createRemoteAuthorizationEpochStore(db))

    persistFeishuConfig(db, { enabled: true, appConfigured: true, userAuthorized: true, remoteTypingEnabled: false })

    const stored = JSON.parse(getConfigValue(db, 'config.feishu')!) as Record<string, unknown>
    expect(stored).toMatchObject({ enabled: true, appConfigured: true, userAuthorized: true, remoteSenderAllowlist: ['ou_owner'], remoteTypingEnabled: false })
    for (const key of ['remoteAllowLocalWrite', 'remoteDenyOutbound', 'remoteBrowserRequiresConfirm', 'remoteScriptRequiresConfirm', 'larkCliWriteRequiresConfirm', 'remoteSecurityConfigVersion', 'remoteSecurityPresetSource']) {
      expect(stored).not.toHaveProperty(key)
    }
    const snapshot = getDbConnection(db).prepare("SELECT snapshot_json FROM policy_behavior_snapshots WHERE domain='im'").get() as { snapshot_json: string }
    expect(JSON.parse(snapshot.snapshot_json)).toMatchObject({ denyWrite: true, denyOutbound: true, browserActRequiresConfirm: true, remoteScriptRequiresConfirm: true })
  })
})
