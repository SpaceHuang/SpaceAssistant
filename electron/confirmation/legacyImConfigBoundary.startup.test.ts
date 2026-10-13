import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { getConfigValue, getDbConnection, setConfigValue } from '../database'
import { readImPolicySnapshot } from './imPolicyStore'
import { ensureImPolicySnapshotAtStartup } from './legacyImConfigBoundary'

describe('legacy IM policy migration at startup', () => {
  it('creates a frozen policy snapshot from existing channel config without rewriting channel config', () => {
    const db = createMemoryAppDb('legacy-im-startup')
    const legacyConfig = {
      enabled: true,
      remoteEnabled: true,
      remoteConfirmPolicy: 'ask',
      remoteAllowLocalWrite: true,
      remoteDenyOutbound: false,
      remoteScriptRequiresConfirm: true,
      remoteBrowserRequiresConfirm: true
    }
    setConfigValue(db, 'config.wechat', JSON.stringify(legacyConfig))

    ensureImPolicySnapshotAtStartup(db)

    const snapshot = readImPolicySnapshot(getDbConnection(db), { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })
    expect(snapshot.policyBehaviorVersion).toBe('im-v1.6')
    expect(snapshot.snapshot).toBeTruthy()
    expect(JSON.parse(getConfigValue(db, 'config.wechat')!)).toEqual(legacyConfig)
    db.close()
  })

  it('does nothing when a fresh installation has no legacy channel config', () => {
    const db = createMemoryAppDb('legacy-im-startup-empty')

    expect(() => ensureImPolicySnapshotAtStartup(db)).not.toThrow()
    expect(() => readImPolicySnapshot(getDbConnection(db), { supportedBehaviorVersions: ['im-v1.6', 'im-standard-v2'] })).toThrow(/IM policy snapshot is missing/)
    db.close()
  })
})
