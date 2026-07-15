import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { FeishuSettingsTab } from './FeishuSettingsTab'
import { DEFAULT_FEISHU_CONFIG } from '../../../shared/feishuTypes'
import { changeAppLocale } from '../../i18n/localeSync'

describe('FeishuSettingsTab rebind confirm', () => {
  const feishuOwnerRebind = vi.fn().mockResolvedValue({ status: 'binding' })

  beforeEach(async () => {
    await changeAppLocale('zh-CN')
    feishuOwnerRebind.mockClear()
    window.api = {
      ...window.api,
      feishuDetectCli: vi.fn().mockResolvedValue({
        installed: true,
        version: '1.0.0',
        path: '/bin/lark',
        nodeAvailable: true,
        npmAvailable: true
      }),
      feishuAuthStatus: vi.fn().mockResolvedValue({ authorized: true }),
      feishuEventStatus: vi.fn().mockResolvedValue({ state: 'stopped', processedCount: 0 }),
      feishuOwnerRebind,
      feishuOwnerBindCancel: vi.fn().mockResolvedValue({ status: 'idle' }),
      feishuOwnerClear: vi.fn().mockResolvedValue({ status: 'idle' }),
      feishuEventStart: vi.fn().mockResolvedValue({ state: 'connecting', processedCount: 0 }),
      feishuEventStop: vi.fn().mockResolvedValue({ state: 'stopped', processedCount: 0 })
    } as typeof window.api
  })

  afterEach(() => {
    cleanup()
  })

  function renderTab() {
    return render(
      <ConfigProvider>
        <App>
          <FeishuSettingsTab
            feishu={{
              ...DEFAULT_FEISHU_CONFIG,
              enabled: true,
              remoteEnabled: true,
              remoteSenderAllowlist: ['ou_owner'],
              remoteOwnerBindWindowMinutes: 5
            }}
            onChange={vi.fn()}
          />
        </App>
      </ConfigProvider>
    )
  }

  it('shows confirm dialog before calling feishuOwnerRebind', async () => {
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '重新绑定' }))
    expect((await screen.findAllByText('确认重新绑定？')).length).toBeGreaterThan(0)
    expect(screen.getByText(/旧 Owner 将立即失效/)).toBeTruthy()
    expect(feishuOwnerRebind).not.toHaveBeenCalled()
  })

  it('confirm path calls IPC', async () => {
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '重新绑定' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认重新绑定' }))
    await waitFor(() => expect(feishuOwnerRebind).toHaveBeenCalledTimes(1))
  })

  it('cancel path does not call IPC', async () => {
    renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '重新绑定' }))
    expect((await screen.findAllByText('确认重新绑定？')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /^取\s*消$/ }))
    await waitFor(() => {
      expect(screen.queryAllByText('确认重新绑定？')).toHaveLength(0)
    })
    expect(feishuOwnerRebind).not.toHaveBeenCalled()
  })
})
