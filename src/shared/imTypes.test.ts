import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REMOTE_IM_COMMON_CONFIG,
  DEFAULT_REMOTE_TASK_BUDGET,
  mergeRemoteImCommonConfig,
  resolveRemoteTaskBudget
} from './imTypes'

describe('imTypes', () => {
  it('mergeRemoteImCommonConfig returns defaults for null', () => {
    const merged = mergeRemoteImCommonConfig(null)
    expect(merged.remoteEnabled).toBe(DEFAULT_REMOTE_IM_COMMON_CONFIG.remoteEnabled)
    expect(merged).not.toHaveProperty('remoteDenyOutbound')
    expect(merged).not.toHaveProperty('remoteAllowLocalWrite')
    expect(merged).not.toHaveProperty('remoteBrowserRequiresConfirm')
    expect(merged.remoteRateLimitPerMinute).toBe(60)
    expect(merged.remoteModelSelectionMode).toBe('inherit')
    expect(merged.remoteThinkingEffort).toBe('low')
    expect(merged.remoteProgressMode).toBe(DEFAULT_REMOTE_IM_COMMON_CONFIG.remoteProgressMode)
  })

  it('keeps remote model selection mode and thinking effort independent from security migration', () => {
    const merged = mergeRemoteImCommonConfig({
      remoteModelSelectionMode: 'explicit',
      remoteDefaultModelId: 'catalog-model-1',
      remoteThinkingEffort: 'high'
    })
    expect(merged).toMatchObject({
      remoteModelSelectionMode: 'explicit',
      remoteDefaultModelId: 'catalog-model-1',
      remoteThinkingEffort: 'high'
    })
    expect(merged).not.toHaveProperty('remoteSecurityConfigVersion')
  })

  it('deep-copies allowlist', () => {
    const allowlist = ['a', 'b']
    const merged = mergeRemoteImCommonConfig({ remoteSenderAllowlist: allowlist })
    expect(merged.remoteSenderAllowlist).toEqual(['a', 'b'])
    allowlist.push('c')
    expect(merged.remoteSenderAllowlist).toEqual(['a', 'b'])
  })

  it('merges progress fields via mergeRemoteProgressConfig', () => {
    const merged = mergeRemoteImCommonConfig({
      remoteProgressMode: 'off',
      remoteProgressMaxChars: 100
    })
    expect(merged.remoteProgressMode).toBe('off')
    expect(merged.remoteProgressMaxChars).toBe(100)
    expect(merged.remoteProgressHeartbeatSec).toBe(
      DEFAULT_REMOTE_IM_COMMON_CONFIG.remoteProgressHeartbeatSec
    )
  })

  it('does NOT fabricate remoteSecurityConfigVersion when fields missing', () => {
    const merged = mergeRemoteImCommonConfig({ remoteEnabled: true })
    expect(merged).not.toHaveProperty('remoteSecurityConfigVersion')
    expect(merged).not.toHaveProperty('remoteScriptRequiresConfirm')
    expect(merged).not.toHaveProperty('remoteBrowserNavigateRequiresConfirm')
    expect(merged).not.toHaveProperty('remoteBrowserActRequiresConfirm')
    expect(merged.remoteTaskBudget).toBeUndefined()
  })

  it('does not project legacy security version metadata into normalized runtime config', () => {
    const merged = mergeRemoteImCommonConfig({
      remoteSecurityConfigVersion: 1,
      remoteSecurityPresetSource: 'upgrade-recommended',
      remoteScriptRequiresConfirm: false,
      remoteBrowserNavigateRequiresConfirm: false,
      remoteBrowserActRequiresConfirm: true,
      remoteTaskBudget: { maxToolCalls: 20 } as never
    })
    expect(merged).not.toHaveProperty('remoteSecurityConfigVersion')
    expect(merged).not.toHaveProperty('remoteSecurityPresetSource')
    expect(merged).not.toHaveProperty('remoteScriptRequiresConfirm')
    expect(merged).not.toHaveProperty('remoteBrowserNavigateRequiresConfirm')
    expect(merged).not.toHaveProperty('remoteBrowserActRequiresConfirm')
    expect(merged.remoteTaskBudget).toEqual({
      maxToolCalls: 20,
      maxExecutionWallSec: DEFAULT_REMOTE_TASK_BUDGET.maxExecutionWallSec,
      maxConcurrentExecutions: DEFAULT_REMOTE_TASK_BUDGET.maxConcurrentExecutions,
      maxConsecutiveOutboundWrites: DEFAULT_REMOTE_TASK_BUDGET.maxConsecutiveOutboundWrites
    })
  })

  it('resolveRemoteTaskBudget fills defaults', () => {
    expect(resolveRemoteTaskBudget(null)).toEqual(DEFAULT_REMOTE_TASK_BUDGET)
    expect(resolveRemoteTaskBudget({ maxToolCalls: 5 }).maxToolCalls).toBe(5)
    expect(resolveRemoteTaskBudget({ maxToolCalls: -1 }).maxToolCalls).toBe(
      DEFAULT_REMOTE_TASK_BUDGET.maxToolCalls
    )
  })

})
