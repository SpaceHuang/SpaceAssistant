import { describe, expect, it } from 'vitest'
import { DEFAULT_FEISHU_CONFIG, type FeishuConfig, type FeishuHealthCheck } from '../../../shared/feishuTypes'
import { resolveFeishuRemoteDisplayStatus } from './feishuRemoteDisplayStatus'

function readyConfig(over: Partial<FeishuConfig> = {}): FeishuConfig {
  return {
    ...DEFAULT_FEISHU_CONFIG,
    enabled: true,
    appConfigured: true,
    userAuthorized: true,
    remoteEnabled: true,
    ...over
  }
}

function readyHealth(over: Partial<FeishuHealthCheck> = {}): FeishuHealthCheck {
  return {
    cli: { installed: true, nodeAvailable: true, npmAvailable: true },
    event: { state: 'stopped', processedCount: 0 },
    pendingConfirms: 0,
    ...over
  }
}

describe('resolveFeishuRemoteDisplayStatus', () => {
  describe('§4.1 display states', () => {
    it('shows unconfigured when feishu disabled', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig({ enabled: false, remoteEnabled: false }),
        readyHealth()
      )
      expect(r.displayState).toBe('unconfigured')
      expect(r.subtextKey).toBe('goToSettings')
    })

    it('shows unconfigured when app not configured', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig({ appConfigured: false }),
        readyHealth()
      )
      expect(r.displayState).toBe('unconfigured')
    })

    it('shows unconfigured when user not authorized', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig({ userAuthorized: false }),
        readyHealth()
      )
      expect(r.displayState).toBe('unconfigured')
    })

    it('treats live auth as authorized when config flag is stale', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig({ userAuthorized: false }),
        readyHealth({ event: { state: 'stopped', processedCount: 0 } }),
        null,
        true
      )
      expect(r.displayState).toBe('stopped')
      expect(r.startEnabled).toBe(true)
    })

    it('shows unconfigured when CLI not installed', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig(),
        readyHealth({ cli: { installed: false, nodeAvailable: true, npmAvailable: true } })
      )
      expect(r.displayState).toBe('unconfigured')
    })

    it('prefers unconfigured over error when remote off and prerequisites fail', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig({ enabled: false, remoteEnabled: false }),
        readyHealth({ event: { state: 'error', processedCount: 0, lastError: 'boom' } })
      )
      expect(r.displayState).toBe('unconfigured')
    })

    it('shows listening when remoteEnabled and connecting even if health cli missing', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig(),
        readyHealth({
          cli: { installed: false, nodeAvailable: true, npmAvailable: true },
          event: { state: 'connecting', processedCount: 0 }
        }),
        { state: 'connecting', processedCount: 0 }
      )
      expect(r.displayState).toBe('listening')
      expect(r.subtextKey).toBe('connecting')
    })

    it('shows listening when remoteEnabled and connecting without feishu.enabled', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig({ enabled: false }),
        null,
        { state: 'connecting', processedCount: 0 }
      )
      expect(r.displayState).toBe('listening')
    })

    it('shows error when remoteEnabled and event error', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig(),
        readyHealth({ event: { state: 'error', processedCount: 3, lastError: '连接失败' } })
      )
      expect(r.displayState).toBe('error')
      expect(r.tooltipData?.lastError).toBe('连接失败')
      expect(r.tooltipData?.processedCount).toBe(3)
      expect(r.subtextKey).toBeUndefined()
    })

    it('shows stopped when remoteEnabled false', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig({ remoteEnabled: false }),
        readyHealth({ event: { state: 'connected', processedCount: 5 } })
      )
      expect(r.displayState).toBe('stopped')
      expect(r.subtextKey).toBe('remoteOff')
    })

    it('shows stopped when event stopped', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig(),
        readyHealth({ event: { state: 'stopped', processedCount: 0 } })
      )
      expect(r.displayState).toBe('stopped')
      expect(r.subtextKey).toBe('serviceStopped')
    })

    it('shows stopped when event override is undefined and remoteEnabled', () => {
      const r = resolveFeishuRemoteDisplayStatus(readyConfig(), readyHealth(), null)
      expect(r.displayState).toBe('stopped')
    })

    it('shows listening when connecting', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig(),
        readyHealth({ event: { state: 'connecting', processedCount: 0 } })
      )
      expect(r.displayState).toBe('listening')
      expect(r.subtextKey).toBe('connecting')
    })

    it('shows listening with processed count when connected', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig(),
        readyHealth({ event: { state: 'connected', processedCount: 12 } })
      )
      expect(r.displayState).toBe('listening')
      expect(r.subtextKey).toBe('processedCount')
      expect(r.subtextParams?.count).toBe(12)
    })
  })

  describe('§5.5.1 button enable matrix', () => {
    it('disables both when unconfigured', () => {
      const r = resolveFeishuRemoteDisplayStatus(DEFAULT_FEISHU_CONFIG, null)
      expect(r.startEnabled).toBe(false)
      expect(r.stopEnabled).toBe(false)
      expect(r.startDisabledKey).toBe('completeConfig')
    })

    it('disables both when remoteEnabled false', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig({ remoteEnabled: false }),
        readyHealth()
      )
      expect(r.startEnabled).toBe(false)
      expect(r.stopEnabled).toBe(false)
      expect(r.startDisabledKey).toBe('enableRemote')
    })

    it('enables start only when stopped with remoteEnabled', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig(),
        readyHealth({ event: { state: 'stopped', processedCount: 0 } })
      )
      expect(r.startEnabled).toBe(true)
      expect(r.stopEnabled).toBe(false)
    })

    it('enables stop only when listening', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig(),
        readyHealth({ event: { state: 'connected', processedCount: 1 } })
      )
      expect(r.startEnabled).toBe(false)
      expect(r.stopEnabled).toBe(true)
    })

    it('enables both when error with remoteEnabled', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig(),
        readyHealth({ event: { state: 'error', processedCount: 0, lastError: 'x' } })
      )
      expect(r.startEnabled).toBe(true)
      expect(r.stopEnabled).toBe(true)
    })
  })

  describe('error tooltip extras', () => {
    it('includes startedAt and inbound/reply times when present', () => {
      const startedAt = Date.UTC(2026, 4, 27, 10, 0, 0)
      const lastInboundAt = Date.UTC(2026, 4, 27, 11, 0, 0)
      const lastReplyAt = Date.UTC(2026, 4, 27, 11, 5, 0)
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig(),
        readyHealth({
          event: { state: 'error', processedCount: 7, lastError: 'stderr detail', startedAt },
          lastInboundAt,
          lastReplyAt
        })
      )
      expect(r.tooltipData?.lastError).toBe('stderr detail')
      expect(r.tooltipData?.processedCount).toBe(7)
      expect(r.tooltipData?.startedAt).toBe(startedAt)
      expect(r.tooltipData?.lastInboundAt).toBe(lastInboundAt)
      expect(r.tooltipData?.lastReplyAt).toBe(lastReplyAt)
    })

    it('omits lastError when missing', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig(),
        readyHealth({ event: { state: 'error', processedCount: 0 } })
      )
      expect(r.tooltipData?.lastError).toBeUndefined()
      expect(r.tooltipData?.processedCount).toBe(0)
    })
  })
})
