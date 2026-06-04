import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { changeAppLocale } from '../../i18n/localeSync'
import { SearchPanel } from './SearchPanel'

vi.mock('./DetailPanelContext', () => ({
  useDetailPanel: () => ({
    previewContent: 'hello world',
    fileType: 'text',
    viewMode: 'code'
  })
}))

describe('SearchPanel i18n', () => {
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
  })

  it('shows Chinese find placeholder', () => {
    render(<SearchPanel open onClose={vi.fn()} onHighlightsChange={vi.fn()} />)
    expect(screen.getByPlaceholderText('查找')).toBeDefined()
  })

  it('shows English find placeholder', async () => {
    await changeAppLocale('en-US')
    render(<SearchPanel open onClose={vi.fn()} onHighlightsChange={vi.fn()} />)
    expect(screen.getByPlaceholderText('Find')).toBeDefined()
  })
})
