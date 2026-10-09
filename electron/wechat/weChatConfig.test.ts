import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getConfigValue, setConfigValue } from '../database'
import { createRemoteAuthorizationEpochStore } from '../remote/remoteAuthorizationEpochStore'
import { remoteAuthorizationRegistry } from '../remote/remoteAuthorizationRegistry'
import { backfillWeChatOwnerAllowlistIfMissing, persistWeChatConfig } from './weChatIpc'

describe('WeChat configuration persistence', () => {
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
