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
    pendingPlans: 0,
    ...over
  }
}

describe('resolveFeishuRemoteDisplayStatus', () => {
  describe('§4.1 display states', () => {
    it('shows 未配置 when feishu disabled', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig({ enabled: false, remoteEnabled: false }),
        readyHealth()
      )
      expect(r.label).toBe('未配置')
      expect(r.displayState).toBe('unconfigured')
      expect(r.subtext).toBe('前往设置完成配置')
    })

    it('shows 未配置 when app not configured', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig({ appConfigured: false }),
        readyHealth()
      )
      expect(r.label).toBe('未配置')
    })

    it('shows 未配置 when user not authorized', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig({ userAuthorized: false }),
        readyHealth()
      )
      expect(r.label).toBe('未配置')
    })

    it('shows 未配置 when CLI not installed', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig(),
        readyHealth({ cli: { installed: false, nodeAvailable: true, npmAvailable: true } })
      )
      expect(r.label).toBe('未配置')
    })

    it('prefers 未配置 over error when remote off and prerequisites fail', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig({ enabled: false, remoteEnabled: false }),
        readyHealth({ event: { state: 'error', processedCount: 0, lastError: 'boom' } })
      )
      expect(r.label).toBe('未配置')
    })

    it('shows 监听中 when remoteEnabled and connecting even if health cli missing', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig(),
        readyHealth({
          cli: { installed: false, nodeAvailable: true, npmAvailable: true },
          event: { state: 'connecting', processedCount: 0 }
        }),
        { state: 'connecting', processedCount: 0 }
      )
      expect(r.label).toBe('监听中')
      expect(r.subtext).toBe('正在连接…')
    })

    it('shows 监听中 when remoteEnabled and connecting without feishu.enabled', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig({ enabled: false }),
        null,
        { state: 'connecting', processedCount: 0 }
      )
      expect(r.label).toBe('监听中')
    })

    it('shows 出错 when remoteEnabled and event error', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig(),
        readyHealth({ event: { state: 'error', processedCount: 3, lastError: '连接失败' } })
      )
      expect(r.label).toBe('出错')
      expect(r.displayState).toBe('error')
      expect(r.tooltip).toContain('连接失败')
      expect(r.subtext).toBeUndefined()
    })

    it('shows 已停止 when remoteEnabled false', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig({ remoteEnabled: false }),
        readyHealth({ event: { state: 'connected', processedCount: 5 } })
      )
      expect(r.label).toBe('已停止')
      expect(r.subtext).toBe('远程监听已关闭')
    })

    it('shows 已停止 when event stopped', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig(),
        readyHealth({ event: { state: 'stopped', processedCount: 0 } })
      )
      expect(r.label).toBe('已停止')
      expect(r.subtext).toBe('服务已停止')
    })

    it('shows 已停止 when event override is undefined and remoteEnabled', () => {
      const r = resolveFeishuRemoteDisplayStatus(readyConfig(), readyHealth(), null)
      expect(r.label).toBe('已停止')
    })

    it('shows 监听中 when connecting', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig(),
        readyHealth({ event: { state: 'connecting', processedCount: 0 } })
      )
      expect(r.label).toBe('监听中')
      expect(r.subtext).toBe('正在连接…')
    })

    it('shows 监听中 with processed count when connected', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig(),
        readyHealth({ event: { state: 'connected', processedCount: 12 } })
      )
      expect(r.label).toBe('监听中')
      expect(r.subtext).toBe('已处理 12')
    })
  })

  describe('§5.5.1 button enable matrix', () => {
    it('disables both when unconfigured', () => {
      const r = resolveFeishuRemoteDisplayStatus(DEFAULT_FEISHU_CONFIG, null)
      expect(r.startEnabled).toBe(false)
      expect(r.stopEnabled).toBe(false)
      expect(r.startDisabledReason).toBe('请先完成飞书配置')
    })

    it('disables both when remoteEnabled false', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig({ remoteEnabled: false }),
        readyHealth()
      )
      expect(r.startEnabled).toBe(false)
      expect(r.stopEnabled).toBe(false)
      expect(r.startDisabledReason).toBe('请先在设置中启用远程指令监听')
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
      expect(r.tooltip).toContain('stderr detail')
      expect(r.tooltip).toContain('已处理：7')
      expect(r.tooltip).toContain('启动时间：')
      expect(r.tooltip).toContain('最近入站：')
      expect(r.tooltip).toContain('最近回复：')
    })

    it('uses 未知错误 when lastError missing', () => {
      const r = resolveFeishuRemoteDisplayStatus(
        readyConfig(),
        readyHealth({ event: { state: 'error', processedCount: 0 } })
      )
      expect(r.tooltip).toContain('未知错误')
    })
  })
})
