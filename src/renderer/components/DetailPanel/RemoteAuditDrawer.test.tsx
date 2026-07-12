import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import { RemoteAuditDrawer } from './RemoteAuditDrawer'
import { changeAppLocale } from '../../i18n/localeSync'

vi.mock('../Config/FeishuAuditDrawer', () => ({
  FeishuAuditTable: () => <div data-testid="feishu-audit-table" />
}))

vi.mock('../Config/WeChatAuditDrawer', () => ({
  WeChatAuditTable: () => <div data-testid="wechat-audit-table" />
}))

describe('RemoteAuditDrawer', () => {
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
  })

  it('shows dual channel tabs when both enabled', () => {
    render(
      <ConfigProvider>
        <RemoteAuditDrawer open showFeishu showWechat onClose={vi.fn()} />
      </ConfigProvider>
    )
    expect(screen.getByText('飞书')).toBeTruthy()
    expect(screen.getByText('微信')).toBeTruthy()
    expect(screen.getByTestId('feishu-audit-table')).toBeTruthy()
  })

  it('switches to wechat tab', () => {
    render(
      <ConfigProvider>
        <RemoteAuditDrawer open showFeishu showWechat initialChannel="feishu" onClose={vi.fn()} />
      </ConfigProvider>
    )
    fireEvent.click(screen.getByText('微信'))
    expect(screen.getByTestId('wechat-audit-table')).toBeTruthy()
  })
})
