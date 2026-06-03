import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Empty } from 'antd'
import { ThemeProvider } from './ThemeProvider'
import { changeAppLocale } from '../i18n/localeSync'

describe('ThemeProvider', () => {
  it('uses Chinese Ant Design locale when app language is zh-CN', async () => {
    await changeAppLocale('zh-CN')
    const { container } = render(
      <ThemeProvider>
        <Empty />
      </ThemeProvider>
    )
    expect(container.querySelector('.ant-empty-description')?.textContent).toBe('暂无数据')
  })

  it('uses English Ant Design locale when app language is en-US', async () => {
    await changeAppLocale('en-US')
    const { container } = render(
      <ThemeProvider>
        <Empty />
      </ThemeProvider>
    )
    expect(container.querySelector('.ant-empty-description')?.textContent).toBe('No data')
  })
})
