import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { WebView } from './WebView'

describe('WebView', () => {
  it('renders webview element with url and registers controller', () => {
    const onControllerRegister = vi.fn()
    const { container } = render(
      <WebView
        url="https://example.com/"
        onControllerRegister={onControllerRegister}
        onLoadStart={vi.fn()}
        onLoadFinish={vi.fn()}
      />
    )

    const webview = container.querySelector('webview')
    expect(webview).toBeTruthy()
    expect(webview?.getAttribute('src')).toBe('https://example.com/')
    expect(onControllerRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        reload: expect.any(Function),
        stop: expect.any(Function)
      })
    )
  })

  it('shows loading overlay when isLoading', () => {
    const { container } = render(<WebView url="https://example.com/" isLoading />)
    expect(container.querySelector('.detail-webview-loading')).toBeTruthy()
  })

  it('shows error message when error is set', () => {
    render(<WebView url="https://example.com/" error="加载失败" />)
    expect(document.body.textContent).toContain('加载失败')
  })
})
