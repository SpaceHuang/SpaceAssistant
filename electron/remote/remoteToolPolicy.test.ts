import { describe, expect, it } from 'vitest'
import {
  applyMigrationConservativeOverlay,
  isRemoteSecurityMigrationComplete,
  shellCommandNeverTrustable,
  shouldSkipRemoteBrowserActConfirm,
  shouldSkipRemoteBrowserNavigateConfirm,
  shouldSkipRemoteLarkWriteConfirm,
  shouldSkipRemoteScriptConfirmOnAllow
} from './remoteToolPolicy'
import { analyzeScriptContent } from '../shell/scriptContentSecurity'

const policySnapshot = (snapshot: Record<string, unknown> = {}): { policySnapshot: { domain: 'im'; policyBehaviorVersion: string; revision: number; snapshot: Record<string, unknown> } } => ({
  policySnapshot: { domain: 'im', policyBehaviorVersion: 'im-v1.6', revision: 1, snapshot }
})
const migrated = policySnapshot()

describe('remoteToolPolicy migration completeness', () => {
  it('treats unsupported policy behavior versions as unmigrated and fail-closed', () => {
    const unknown = { ...migrated, policySnapshot: { ...migrated.policySnapshot, policyBehaviorVersion: 'im-v99' } }
    expect(isRemoteSecurityMigrationComplete(unknown)).toBe(false)
    expect(applyMigrationConservativeOverlay(unknown)).toEqual({
      fileWriteRequiresConfirm: true,
      scriptAllowRequiresConfirm: true,
      browserActRequiresConfirm: true,
      larkWriteRequiresConfirm: true
    })
  })

  it('is complete only at current version', () => {
    expect(isRemoteSecurityMigrationComplete(undefined)).toBe(false)
    expect(isRemoteSecurityMigrationComplete({})).toBe(false)
    expect(isRemoteSecurityMigrationComplete({ remoteSecurityConfigVersion: 1 })).toBe(false)
    expect(isRemoteSecurityMigrationComplete({ remoteSecurityConfigVersion: 999 })).toBe(false)
    expect(isRemoteSecurityMigrationComplete(migrated)).toBe(true)
  })
})

describe('applyMigrationConservativeOverlay', () => {
  it('consumes the common im snapshot and ignores legacy channel fields at runtime', () => {
    const common = {
      policySnapshot: {
        domain: 'im' as const,
        policyBehaviorVersion: 'im-v1.6',
        revision: 3,
        snapshot: { remoteAllowLocalWrite: true, remoteScriptRequiresConfirm: false, remoteBrowserActRequiresConfirm: true, larkCliWriteRequiresConfirm: true }
      },
      remoteSecurityConfigVersion: 1,
      remoteAllowLocalWrite: false,
      remoteScriptRequiresConfirm: true
    }
    expect(applyMigrationConservativeOverlay(common)).toMatchObject({ fileWriteRequiresConfirm: false, scriptAllowRequiresConfirm: false })
    expect(applyMigrationConservativeOverlay({ ...common, policySnapshot: undefined })).toMatchObject({ fileWriteRequiresConfirm: true, scriptAllowRequiresConfirm: true })
  })
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
    const overlay = applyMigrationConservativeOverlay(policySnapshot({
      remoteAllowLocalWrite: true,
      remoteScriptRequiresConfirm: false,
      remoteBrowserActRequiresConfirm: false,
      larkCliWriteRequiresConfirm: false
    }))
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
  it('script allow skip only when migrated and script confirm disabled', () => {
    expect(shouldSkipRemoteScriptConfirmOnAllow({ remoteScriptRequiresConfirm: false })).toBe(false)
    expect(shouldSkipRemoteScriptConfirmOnAllow({ ...migrated })).toBe(false)
    expect(shouldSkipRemoteScriptConfirmOnAllow(policySnapshot({ remoteScriptRequiresConfirm: true }))).toBe(false)
    expect(shouldSkipRemoteScriptConfirmOnAllow(policySnapshot({ remoteScriptRequiresConfirm: false }))).toBe(true)
  })

  it('script confirm skip only ever matters when remote analysis itself returned allow (WP3)', () => {
    const skipEnabled = policySnapshot({ remoteScriptRequiresConfirm: false })

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

  it('browser navigate skip reads only the common snapshot and fails closed when missing', () => {
    expect(shouldSkipRemoteBrowserNavigateConfirm({ remoteBrowserRequiresConfirm: false })).toBe(false)
    expect(shouldSkipRemoteBrowserNavigateConfirm(policySnapshot({ remoteBrowserNavigateRequiresConfirm: true }))).toBe(false)
    expect(shouldSkipRemoteBrowserNavigateConfirm(policySnapshot({ remoteBrowserNavigateRequiresConfirm: false }))).toBe(true)
  })

  it('browser act skip gated by migration and defaults to confirm', () => {
    expect(shouldSkipRemoteBrowserActConfirm({ remoteBrowserActRequiresConfirm: false })).toBe(false)
    expect(shouldSkipRemoteBrowserActConfirm({ ...migrated })).toBe(false)
    expect(shouldSkipRemoteBrowserActConfirm(policySnapshot({ remoteBrowserActRequiresConfirm: false }))).toBe(true)
    expect(shouldSkipRemoteBrowserActConfirm(policySnapshot({ remoteBrowserActRequiresConfirm: true }))).toBe(false)
  })

  it('lark write skip gated by migration', () => {
    expect(shouldSkipRemoteLarkWriteConfirm({ larkCliWriteRequiresConfirm: false })).toBe(false)
    expect(shouldSkipRemoteLarkWriteConfirm(policySnapshot({ larkCliWriteRequiresConfirm: false }))).toBe(true)
    expect(shouldSkipRemoteLarkWriteConfirm(policySnapshot({ larkCliWriteRequiresConfirm: true }))).toBe(false)
    expect(shouldSkipRemoteLarkWriteConfirm({ ...migrated })).toBe(false)
  })
})

describe('shellCommandNeverTrustable', () => {
  it('flags metasyntax commands', () => {
    expect(shellCommandNeverTrustable('npm test $(x)')).toBe(true)
    expect(shellCommandNeverTrustable('npm test')).toBe(false)
  })
})
