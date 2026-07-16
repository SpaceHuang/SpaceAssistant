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
import { analyzeScriptContent } from '../shell/scriptContentSecurity'

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
    expect(shouldSkipRemoteFileWriteConfirm({ ...migrated, remoteAllowLocalWrite: true })).toBe(false)
    expect(shouldSkipRemoteFileWriteConfirm({ ...migrated })).toBe(false)
  })

  it('script allow skip only when migrated and script confirm disabled', () => {
    expect(shouldSkipRemoteScriptConfirmOnAllow({ remoteScriptRequiresConfirm: false })).toBe(false)
    expect(shouldSkipRemoteScriptConfirmOnAllow({ ...migrated })).toBe(false)
    expect(shouldSkipRemoteScriptConfirmOnAllow({ ...migrated, remoteScriptRequiresConfirm: true })).toBe(false)
    expect(shouldSkipRemoteScriptConfirmOnAllow({ ...migrated, remoteScriptRequiresConfirm: false })).toBe(true)
  })

  it('script confirm skip only ever matters when remote analysis itself returned allow (WP3)', () => {
    const skipEnabled = { ...migrated, remoteScriptRequiresConfirm: false }

    // A script that fails remote positive-allowlist certification never returns 'allow' from
    // analyzeScriptContent, so the skip switch has no effect — the caller never even reaches
    // the shouldSkipRemoteScriptConfirmOnAllow() branch for it.
    const uncertified = analyzeScriptContent("imp = __import__\nimp('os')", { remote: true })
    expect(uncertified.verdict).not.toBe('allow')

    // A script that IS certified safe on remote does return 'allow', and only then does the
    // skip switch decide whether confirmation can be bypassed.
    const certified = analyzeScriptContent("import os\nos.chdir('src')", { remote: true })
    expect(certified.verdict).toBe('allow')
    expect(shouldSkipRemoteScriptConfirmOnAllow(skipEnabled)).toBe(true)
    expect(shouldSkipRemoteScriptConfirmOnAllow(migrated)).toBe(false)
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
