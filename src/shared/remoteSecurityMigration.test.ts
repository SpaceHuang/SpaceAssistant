import { describe, expect, it } from 'vitest'
import { CURRENT_REMOTE_SECURITY_CONFIG_VERSION } from './imTypes'
import {
  buildRemoteSecurityPreset,
  isRemoteSecurityMigrated,
  planRemoteSecurityMigration
} from './remoteSecurityMigration'

describe('remoteSecurityMigration planner', () => {
  it('new install with no config needs summary', () => {
    const plan = planRemoteSecurityMigration({ isNewInstall: true })
    expect(plan.needsSummary).toBe(true)
    expect(plan.isMigrated).toBe(false)
  })

  it('stock config missing new fields needs summary and keeps everything at confirm', () => {
    const plan = planRemoteSecurityMigration({
      isNewInstall: false,
      feishu: { remoteEnabled: true }
    })
    expect(plan.needsSummary).toBe(true)
    expect(plan.effectiveStrength.fileWrite).toBe('confirm')
    expect(plan.effectiveStrength.scriptAllow).toBe('confirm')
    expect(plan.effectiveStrength.browserAct).toBe('confirm')
    expect(plan.effectiveStrength.larkWrite).toBe('confirm')
  })

  it('does not need summary once both present configs are at current version', () => {
    const plan = planRemoteSecurityMigration({
      isNewInstall: false,
      feishu: { remoteSecurityConfigVersion: CURRENT_REMOTE_SECURITY_CONFIG_VERSION },
      wechat: { remoteSecurityConfigVersion: CURRENT_REMOTE_SECURITY_CONFIG_VERSION }
    })
    expect(plan.isMigrated).toBe(true)
    expect(plan.needsSummary).toBe(false)
  })

  it('still needs summary when only one channel migrated', () => {
    const plan = planRemoteSecurityMigration({
      isNewInstall: false,
      feishu: { remoteSecurityConfigVersion: CURRENT_REMOTE_SECURITY_CONFIG_VERSION },
      wechat: { remoteEnabled: true }
    })
    expect(plan.needsSummary).toBe(true)
  })

  it('remote_read_only maps to deny write + deny outbound in both presets, unaffected by preset', () => {
    const input = { isNewInstall: false, feishu: { remoteConfirmPolicy: 'remote_read_only' } }
    const plan = planRemoteSecurityMigration(input)
    expect(plan.legacyReadOnly).toBe(true)
    expect(plan.effectiveStrength.fileWrite).toBe('deny')
    expect(plan.effectiveStrength.larkWrite).toBe('deny')
    for (const preset of [plan.recommended, plan.safer]) {
      expect(preset.common.remoteAllowLocalWrite).toBe(false)
      expect(preset.common.remoteDenyOutbound).toBe(true)
    }
    expect(plan.legacyMappings).toContain('remote_read_only→deny_write+deny_outbound')
  })

  it('browser legacy true forces navigate+act confirm even in recommended', () => {
    const plan = planRemoteSecurityMigration({
      isNewInstall: false,
      feishu: { remoteBrowserRequiresConfirm: true }
    })
    expect(plan.legacyBrowserCombined).toBe(true)
    expect(plan.recommended.common.remoteBrowserNavigateRequiresConfirm).toBe(true)
    expect(plan.recommended.common.remoteBrowserActRequiresConfirm).toBe(true)
    expect(plan.effectiveStrength.browserNavigate).toBe('confirm')
  })

  it('browser legacy false keeps act confirm on upgrade (recommended)', () => {
    const plan = planRemoteSecurityMigration({
      isNewInstall: false,
      feishu: { remoteBrowserRequiresConfirm: false }
    })
    expect(plan.recommended.common.remoteBrowserActRequiresConfirm).toBe(true)
    expect(plan.recommended.common.remoteBrowserNavigateRequiresConfirm).toBe(false)
  })

  it('recommended preset: script/navigate skip, act/lark confirm', () => {
    const preset = buildRemoteSecurityPreset('recommended', { isNewInstall: true })
    expect(preset.common.remoteScriptRequiresConfirm).toBe(false)
    expect(preset.common.remoteBrowserNavigateRequiresConfirm).toBe(false)
    expect(preset.common.remoteBrowserActRequiresConfirm).toBe(true)
    expect(preset.feishu.larkCliWriteRequiresConfirm).toBe(true)
    expect(preset.common.remoteSecurityConfigVersion).toBe(CURRENT_REMOTE_SECURITY_CONFIG_VERSION)
    expect(preset.common.remoteSecurityPresetSource).toBe('new-install')
  })

  it('safer preset: everything confirm', () => {
    const preset = buildRemoteSecurityPreset('safer', { isNewInstall: false })
    expect(preset.common.remoteScriptRequiresConfirm).toBe(true)
    expect(preset.common.remoteBrowserNavigateRequiresConfirm).toBe(true)
    expect(preset.common.remoteBrowserActRequiresConfirm).toBe(true)
    expect(preset.feishu.larkCliWriteRequiresConfirm).toBe(true)
    expect(preset.common.remoteSecurityPresetSource).toBe('upgrade-safer')
  })

  it('isRemoteSecurityMigrated false when no configs', () => {
    expect(isRemoteSecurityMigrated({ isNewInstall: true })).toBe(false)
  })
})
