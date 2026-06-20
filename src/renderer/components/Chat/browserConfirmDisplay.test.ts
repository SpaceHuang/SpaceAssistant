import { describe, expect, it } from 'vitest'
import {
  formatBrowserToolLabel,
  formatBrowserToolLabelTitle,
  summarizeBrowserConfirmInput
} from './browserConfirmDisplay'

describe('summarizeBrowserConfirmInput', () => {
  it('shows URL for navigate open', () => {
    const s = summarizeBrowserConfirmInput({
      action: 'navigate',
      mode: 'open',
      url: 'https://www.zhihu.com/billboard'
    })
    expect(s?.headline).toBe('打开网页')
    expect(s?.detailLabel).toBe('URL')
    expect(s?.detailValue).toBe('https://www.zhihu.com/billboard')
  })

  it('shows instruction for act', () => {
    const s = summarizeBrowserConfirmInput({
      action: 'act',
      instruction: 'Click the Submit button'
    })
    expect(s?.headline).toBe('浏览器操作')
    expect(s?.detailLabel).toBe('指令')
    expect(s?.detailValue).toBe('Click the Submit button')
  })

  it('includes current page url when provided for act', () => {
    const s = summarizeBrowserConfirmInput(
      { action: 'act', instruction: 'click' },
      'https://github.com/foo'
    )
    expect(s?.pageUrl).toBe('https://github.com/foo')
  })
})

describe('formatBrowserToolLabel', () => {
  it('uses hostname in row label', () => {
    expect(
      formatBrowserToolLabel({
        action: 'navigate',
        mode: 'open',
        url: 'https://www.zhihu.com/billboard'
      })
    ).toBe('打开 www.zhihu.com/billboard')
  })
})

describe('formatBrowserToolLabelTitle', () => {
  it('keeps full URL in title', () => {
    expect(
      formatBrowserToolLabelTitle({
        action: 'navigate',
        mode: 'open',
        url: 'https://www.zhihu.com/billboard'
      })
    ).toBe('https://www.zhihu.com/billboard')
  })
})
