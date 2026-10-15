import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getConfigValue, setConfigValue } from '../database'
import { getDbConnection } from '../database'
import { createRemoteAuthorizationEpochStore } from '../remote/remoteAuthorizationEpochStore'
import { remoteAuthorizationRegistry } from '../remote/remoteAuthorizationRegistry'
import { backfillWeChatOwnerAllowlistIfMissing, persistWeChatConfig } from './weChatIpc'

describe('WeChat configuration persistence', () => {
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
      remoteScriptRequiresConfirm: false, larkCliWriteRequiresConfirm: true
    }))
    remoteAuthorizationRegistry.bindPersistentEpochStore(createRemoteAuthorizationEpochStore(db))

    persistWeChatConfig(db, { enabled: true, loggedIn: true, remoteEnabled: true, remoteTypingEnabled: false })

    const stored = JSON.parse(getConfigValue(db, 'config.wechat')!) as Record<string, unknown>
    expect(stored).toMatchObject({ enabled: true, loggedIn: true, remoteEnabled: true, remoteSenderAllowlist: ['bound-user@wechat'], remoteTypingEnabled: false })
    for (const key of ['remoteAllowLocalWrite', 'remoteDenyOutbound', 'remoteBrowserRequiresConfirm', 'remoteScriptRequiresConfirm', 'remoteSecurityConfigVersion', 'remoteSecurityPresetSource']) {
      expect(stored).not.toHaveProperty(key)
    }
    const snapshot = getDbConnection(db).prepare("SELECT snapshot_json FROM policy_behavior_snapshots WHERE domain='im'").get() as { snapshot_json: string }
    expect(JSON.parse(snapshot.snapshot_json)).toMatchObject({ denyWrite: true, denyOutbound: true, browserActRequiresConfirm: true, remoteScriptRequiresConfirm: true })
  })

  it('preserves the main-process binding when a stale renderer saves other settings', () => {
    const db = createMemoryAppDb()
    setConfigValue(db, 'config.wechat', JSON.stringify({
      enabled: true,
      loggedIn: true,
      remoteEnabled: true,
      remoteSenderAllowlist: ['bound-user@wechat']
    }))
    remoteAuthorizationRegistry.bindPersistentEpochStore(createRemoteAuthorizationEpochStore(db))

    persistWeChatConfig(db, {
      enabled: true,
      loggedIn: true,
      remoteEnabled: true,
      remoteSenderAllowlist: undefined,
      remoteTypingEnabled: false
    })

    const stored = JSON.parse(getConfigValue(db, 'config.wechat')!)
    expect(stored.remoteSenderAllowlist).toEqual(['bound-user@wechat'])
    expect(stored.remoteTypingEnabled).toBe(false)
  })

  it('replaces the binding only when the caller explicitly owns the binding flow', () => {
    const db = createMemoryAppDb()
    setConfigValue(db, 'config.wechat', JSON.stringify({
      enabled: true,
      loggedIn: true,
      remoteEnabled: true,
      remoteSenderAllowlist: ['old-user@wechat']
    }))
    remoteAuthorizationRegistry.bindPersistentEpochStore(createRemoteAuthorizationEpochStore(db))

    persistWeChatConfig(db, {
      enabled: true,
      loggedIn: true,
      remoteEnabled: true,
      remoteSenderAllowlist: ['new-user@wechat']
    }, { allowlist: 'replace' })

    const stored = JSON.parse(getConfigValue(db, 'config.wechat')!)
    expect(stored.remoteSenderAllowlist).toEqual(['new-user@wechat'])
  })

  it('backfills a missing binding from the authenticated SDK status without replacing an existing owner', () => {
    const db = createMemoryAppDb()
    setConfigValue(db, 'config.wechat', JSON.stringify({ enabled: true, loggedIn: true, remoteEnabled: true }))
    remoteAuthorizationRegistry.bindPersistentEpochStore(createRemoteAuthorizationEpochStore(db))

    expect(backfillWeChatOwnerAllowlistIfMissing(db, {
      loggedIn: true,
      boundUserId: 'sdk-owner@wechat',
      pollState: 'polling'
    })).toBe(true)
    expect(JSON.parse(getConfigValue(db, 'config.wechat')!).remoteSenderAllowlist).toEqual(['sdk-owner@wechat'])

    expect(backfillWeChatOwnerAllowlistIfMissing(db, {
      loggedIn: true,
      boundUserId: 'different-sdk-owner@wechat',
      pollState: 'polling'
    })).toBe(false)
    expect(JSON.parse(getConfigValue(db, 'config.wechat')!).remoteSenderAllowlist).toEqual(['sdk-owner@wechat'])
  })
})
