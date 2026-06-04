import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FileToolbar } from './FileToolbar'

describe('FileToolbar web mode', () => {
  it('submits address bar on Enter', () => {
    const onAddressSubmit = vi.fn()
    render(
      <FileToolbar
        viewMode="render"
        previewContent={null}
        showWebNavigation
        showAddressBar
        addressUrl="https://example.com/"
        canGoBack={false}
        canGoForward={false}
        onAddressChange={vi.fn()}
        onAddressSubmit={onAddressSubmit}
        onViewModeChange={vi.fn()}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
      />
    )

    const input = screen.getByPlaceholderText('输入 http(s):// URL 并回车')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAddressSubmit).toHaveBeenCalled()
  })

  it('disables back button when cannot navigate back', () => {
    render(
      <FileToolbar
        viewMode="render"
        previewContent={null}
        showWebNavigation
        showAddressBar
        addressUrl="https://example.com/"
        canGoBack={false}
        canGoForward={false}
        onNavigateBack={vi.fn()}
        onViewModeChange={vi.fn()}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
      />
    )

    expect((screen.getByLabelText('后退') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows html render/code toggle', () => {
    render(
      <FileToolbar
        filePath="index.html"
        fileType="html"
        viewMode="render"
        previewContent="<html></html>"
        onViewModeChange={vi.fn()}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
      />
    )

    expect(screen.getByRole('tablist', { name: 'HTML 视图' })).toBeTruthy()
  })
})
