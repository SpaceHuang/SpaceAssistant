import { describe, expect, it } from 'vitest'
import {
  applyMigrationConservativeOverlay,
  isRemoteSecurityMigrationComplete,
  shellCommandNeverTrustable,
  shouldSkipRemoteBrowserActConfirm,
} from './remoteToolPolicy'

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

describe('shellCommandNeverTrustable', () => {
  it('flags metasyntax commands', () => {
    expect(shellCommandNeverTrustable('npm test $(x)')).toBe(true)
    expect(shellCommandNeverTrustable('npm test')).toBe(false)
  })
})
