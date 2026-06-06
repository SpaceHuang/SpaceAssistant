import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { ShellSettingsTab } from './ShellSettingsTab'
import { DEFAULT_SHELL_CONFIG } from '../../../shared/domainTypes'
import { changeAppLocale } from '../../i18n/localeSync'

describe('ShellSettingsTab', () => {
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
    window.api = {
      ...window.api,
      shellManageTrustedCommands: vi.fn().mockResolvedValue({ ok: true, commands: [] })
    } as typeof window.api
  })

  it('does not show auto allow switch on shell section', () => {
    render(
      <ConfigProvider>
        <App>
          <ShellSettingsTab shell={DEFAULT_SHELL_CONFIG} onChange={vi.fn()} />
        </App>
      </ConfigProvider>
    )
    expect(screen.queryByText('大模型生成的脚本自动允许执行')).toBeNull()
  })

  it('shows builtin deny rules', () => {
    render(
      <ConfigProvider>
        <App>
          <ShellSettingsTab shell={DEFAULT_SHELL_CONFIG} onChange={vi.fn()} />
        </App>
      </ConfigProvider>
    )
    expect(screen.getByText(/sudo:\*/)).toBeTruthy()
    expect(screen.getByText(/lark-cli:\*/)).toBeTruthy()
  })

  it('adds a rule when clicking add button (zh-CN)', () => {
    const onChange = vi.fn()
    render(
      <ConfigProvider>
        <App>
          <ShellSettingsTab shell={DEFAULT_SHELL_CONFIG} onChange={onChange} />
        </App>
      </ConfigProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: '添加规则' }))
    expect(onChange).toHaveBeenCalled()
    const updater = onChange.mock.calls[0]?.[0] as (prev: typeof DEFAULT_SHELL_CONFIG) => typeof DEFAULT_SHELL_CONFIG
    const next = updater(DEFAULT_SHELL_CONFIG)
    expect(next.rules?.length).toBe(1)
    expect(next.rules?.[0]?.decision).toBe('allow')
  })

  it('adds a rule when clicking add button (en-US)', async () => {
    await changeAppLocale('en-US')
    const onChange = vi.fn()
    render(
      <ConfigProvider>
        <App>
          <ShellSettingsTab shell={DEFAULT_SHELL_CONFIG} onChange={onChange} />
        </App>
      </ConfigProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    expect(onChange).toHaveBeenCalled()
  })
})
