import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const openUrl = vi.fn().mockResolvedValue(undefined)

vi.mock('../DetailPanel/DetailPanelContext', () => ({
  useDetailPanel: () => ({ openUrl })
}))

import { BrowserConfirmCard } from './BrowserConfirmCard'

describe('BrowserConfirmCard', () => {
  it('opens navigate URL in content viewer when URL is clicked', () => {
    render(
      <BrowserConfirmCard
        record={{
          id: 'tool-1',
          toolName: 'browser',
          input: { action: 'navigate', mode: 'open', url: 'https://example.com/docs' },
          status: 'confirming',
          riskLevel: 'medium'
        }}
        onConfirm={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'https://example.com/docs' }))
    expect(openUrl).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('shows trust domain checkbox for navigate open', () => {
    render(
      <BrowserConfirmCard
        record={{
          id: 'tool-2',
          toolName: 'browser',
          input: { action: 'navigate', mode: 'open', url: 'https://docs.github.com/x' },
          status: 'confirming',
          riskLevel: 'medium'
        }}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByLabelText(/信任此域名/)).toBeTruthy()
  })

  it('passes trustDomain when checkbox checked', () => {
    const onConfirm = vi.fn()
    render(
      <BrowserConfirmCard
        record={{
          id: 'tool-3',
          toolName: 'browser',
          input: { action: 'navigate', mode: 'open', url: 'https://docs.github.com/x' },
          status: 'confirming',
          riskLevel: 'medium'
        }}
        onConfirm={onConfirm}
      />
    )
    fireEvent.click(screen.getByLabelText(/信任此域名/))
    fireEvent.click(screen.getByRole('button', { name: '确认操作' }))
    expect(onConfirm).toHaveBeenCalledWith(true, { trustDomain: 'github.com' })
  })

  it('shows act trust checkbox and safety note from currentPageUrl', () => {
    render(
      <BrowserConfirmCard
        record={{
          id: 'tool-act',
          toolName: 'browser',
          input: { action: 'act', instruction: '点击 Issues' },
          currentPageUrl: 'https://github.com/foo/bar',
          status: 'confirming',
          riskLevel: 'medium'
        }}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByLabelText(/信任此域名的操作/)).toBeTruthy()
    expect(screen.getByText(/仅对常规操作/)).toBeTruthy()
  })

  it('passes trustActDomain when act checkbox checked', () => {
    const onConfirm = vi.fn()
    render(
      <BrowserConfirmCard
        record={{
          id: 'tool-act-trust',
          toolName: 'browser',
          input: { action: 'act', instruction: '点击 Issues' },
          currentPageUrl: 'https://docs.github.com/x',
          status: 'confirming',
          riskLevel: 'medium'
        }}
        onConfirm={onConfirm}
      />
    )
    fireEvent.click(screen.getByLabelText(/信任此域名的操作/))
    fireEvent.click(screen.getByRole('button', { name: '确认操作' }))
    expect(onConfirm).toHaveBeenCalledWith(true, { trustActDomain: 'github.com' })
  })

  it('danger act hides trust checkbox and shows user reason', () => {
    render(
      <BrowserConfirmCard
        record={{
          id: 'tool-danger',
          toolName: 'browser',
          input: { action: 'act', instruction: '提交订单' },
          currentPageUrl: 'https://shop.example.com',
          dangerInfo: {
            userReason: '指令提到「提交订单」',
            consequence: 'money',
            source: 'keyword'
          },
          status: 'confirming',
          riskLevel: 'medium'
        }}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.queryByLabelText(/信任此域名的操作/)).toBeNull()
    expect(screen.getByText('指令提到「提交订单」')).toBeTruthy()
    expect(screen.getByText(/可能导致实际付款/)).toBeTruthy()
    expect(screen.queryByText(/keyword|page-effect|target-effect/)).toBeNull()
  })

  it('masks fill preview long digits', () => {
    render(
      <BrowserConfirmCard
        record={{
          id: 'tool-fill',
          toolName: 'browser',
          input: { action: 'act', instruction: '填写卡号' },
          dangerInfo: {
            userReason: '填写敏感字段',
            consequence: 'money',
            source: 'target-effect',
            fillPreview: [{ selector: '#card', method: 'fill', value: '4111111111111234' }]
          },
          status: 'confirming',
          riskLevel: 'medium'
        }}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByText(/将填入：/)).toBeTruthy()
    expect(screen.getByText(/1234/)).toBeTruthy()
    expect(screen.queryByText(/4111111111111234/)).toBeNull()
  })

  it('shows session trusted hint when flagged', () => {
    render(
      <BrowserConfirmCard
        record={{
          id: 'tool-hint',
          toolName: 'browser',
          input: { action: 'act', instruction: '支付' },
          sessionTrustedHint: true,
          dangerInfo: {
            userReason: '指令提到「支付」',
            consequence: 'money',
            source: 'keyword'
          },
          status: 'confirming',
          riskLevel: 'medium'
        }}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByText(/本会话已信任该域名的常规操作/)).toBeTruthy()
  })
})
