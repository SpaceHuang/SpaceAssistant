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
})
