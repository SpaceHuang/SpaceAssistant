import { describe, expect, it } from 'vitest'
import {
  CURRENT_REMOTE_SECURITY_CONFIG_VERSION,
  applyMigrationConservativeOverlay,
  isRemoteSecurityMigrationComplete,
  shellCommandNeverTrustable,
  shouldSkipRemoteBrowserActConfirm,
  shouldSkipRemoteBrowserNavigateConfirm,
  shouldSkipRemoteFileWriteConfirm,
  shouldSkipRemoteLarkWriteConfirm,
  shouldSkipRemoteScriptConfirmOnAllow
} from './remoteToolPolicy'

const migrated = { remoteSecurityConfigVersion: CURRENT_REMOTE_SECURITY_CONFIG_VERSION }

describe('remoteToolPolicy migration completeness', () => {
  it('is complete only at current version', () => {
    expect(isRemoteSecurityMigrationComplete(undefined)).toBe(false)
    expect(isRemoteSecurityMigrationComplete({})).toBe(false)
    expect(isRemoteSecurityMigrationComplete({ remoteSecurityConfigVersion: 0 })).toBe(false)
    expect(isRemoteSecurityMigrationComplete({ remoteSecurityConfigVersion: 999 })).toBe(false)
    expect(isRemoteSecurityMigrationComplete(migrated)).toBe(true)
  })
})

describe('applyMigrationConservativeOverlay', () => {
  it('forces ask for all overlay-gated tools when unmigrated', () => {
    const overlay = applyMigrationConservativeOverlay({ remoteAllowLocalWrite: true })
    expect(overlay).toEqual({
      fileWriteRequiresConfirm: true,
      scriptAllowRequiresConfirm: true,
      browserActRequiresConfirm: true,
      larkWriteRequiresConfirm: true
    })
  })

  it('follows per-tool switches when migrated', () => {
    const overlay = applyMigrationConservativeOverlay({
      ...migrated,
      remoteAllowLocalWrite: true,
      remoteScriptRequiresConfirm: false,
      remoteBrowserActRequiresConfirm: false,
      larkCliWriteRequiresConfirm: false
    })
    expect(overlay).toEqual({
      fileWriteRequiresConfirm: false,
      scriptAllowRequiresConfirm: false,
      browserActRequiresConfirm: false,
      larkWriteRequiresConfirm: false
    })
  })

  it('keeps conservative defaults for missing switches when migrated', () => {
    const overlay = applyMigrationConservativeOverlay({ ...migrated })
    expect(overlay.scriptAllowRequiresConfirm).toBe(true)
    expect(overlay.browserActRequiresConfirm).toBe(true)
    expect(overlay.larkWriteRequiresConfirm).toBe(true)
  })
})

describe('per-tool confirm skip decisions', () => {
  it('file write skip only when migrated and write allowed', () => {
    expect(shouldSkipRemoteFileWriteConfirm({ remoteAllowLocalWrite: true })).toBe(false)
    expect(shouldSkipRemoteFileWriteConfirm({ ...migrated, remoteAllowLocalWrite: false })).toBe(false)
    expect(shouldSkipRemoteFileWriteConfirm({ ...migrated, remoteAllowLocalWrite: true })).toBe(true)
    expect(shouldSkipRemoteFileWriteConfirm({ ...migrated })).toBe(true)
  })

  it('script allow skip only when migrated and script confirm disabled', () => {
    expect(shouldSkipRemoteScriptConfirmOnAllow({ remoteScriptRequiresConfirm: false })).toBe(false)
    expect(shouldSkipRemoteScriptConfirmOnAllow({ ...migrated })).toBe(false)
    expect(shouldSkipRemoteScriptConfirmOnAllow({ ...migrated, remoteScriptRequiresConfirm: true })).toBe(false)
    expect(shouldSkipRemoteScriptConfirmOnAllow({ ...migrated, remoteScriptRequiresConfirm: false })).toBe(true)
  })

  it('browser navigate skip is not gated by migration', () => {
    expect(shouldSkipRemoteBrowserNavigateConfirm({ remoteBrowserRequiresConfirm: false })).toBe(true)
    expect(shouldSkipRemoteBrowserNavigateConfirm({ remoteBrowserRequiresConfirm: true })).toBe(false)
    expect(
      shouldSkipRemoteBrowserNavigateConfirm({ remoteBrowserNavigateRequiresConfirm: true })
    ).toBe(false)
    expect(
      shouldSkipRemoteBrowserNavigateConfirm({ remoteBrowserNavigateRequiresConfirm: false })
    ).toBe(true)
  })

  it('browser act skip gated by migration and defaults to confirm', () => {
    expect(shouldSkipRemoteBrowserActConfirm({ remoteBrowserActRequiresConfirm: false })).toBe(false)
    expect(shouldSkipRemoteBrowserActConfirm({ ...migrated })).toBe(false)
    expect(shouldSkipRemoteBrowserActConfirm({ ...migrated, remoteBrowserActRequiresConfirm: false })).toBe(true)
    expect(shouldSkipRemoteBrowserActConfirm({ ...migrated, remoteBrowserActRequiresConfirm: true })).toBe(false)
  })

  it('lark write skip gated by migration', () => {
    expect(shouldSkipRemoteLarkWriteConfirm({ larkCliWriteRequiresConfirm: false })).toBe(false)
    expect(shouldSkipRemoteLarkWriteConfirm({ ...migrated, larkCliWriteRequiresConfirm: false })).toBe(true)
    expect(shouldSkipRemoteLarkWriteConfirm({ ...migrated, larkCliWriteRequiresConfirm: true })).toBe(false)
    expect(shouldSkipRemoteLarkWriteConfirm({ ...migrated })).toBe(false)
  })
})

describe('shellCommandNeverTrustable', () => {
  it('flags metasyntax commands', () => {
    expect(shellCommandNeverTrustable('npm test $(x)')).toBe(true)
    expect(shellCommandNeverTrustable('npm test')).toBe(false)
  })
})
