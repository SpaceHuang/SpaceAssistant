import { fireEvent, render, screen } from '@testing-library/react'
import { App } from 'antd'
import { describe, expect, it, vi } from 'vitest'
import { ToolsSettingsTab } from './ToolsSettingsTab'
import { DEFAULT_BROWSER_CONFIG, DEFAULT_SHELL_CONFIG } from '../../../shared/domainTypes'

function renderFileSection(confirmMode: 'diff' | 'direct' | 'auto' = 'diff') {
  const setToolUi = vi.fn()
  render(
    <App>
      <ToolsSettingsTab
        section="file"
        toolUi={{
          confirmMode,
          deniedTools: [],
          pythonPath: 'python',
          scriptTimeout: 300,
          fileCheckpointingEnabled: true,
          maxFileSnapshots: 100,
          grepTimeoutSec: 60
        }}
        setToolUi={setToolUi}
        browserUi={DEFAULT_BROWSER_CONFIG}
        setBrowserUi={vi.fn()}
        shellUi={DEFAULT_SHELL_CONFIG}
        setShellUi={vi.fn()}
        onShellEnabledChange={vi.fn()}
        models={[]}
        pyTest={null}
        pyTesting={false}
        onTestPython={vi.fn()}
      />
    </App>
  )
  return { setToolUi }
}

describe('ToolsSettingsTab auto approve', () => {
  it('renders three confirmation mode options', () => {
    renderFileSection()
    expect(screen.getByText('展示文件修改内容')).toBeTruthy()
    expect(screen.getByText('直接确认')).toBeTruthy()
    expect(screen.getByText('自动放行安全写入')).toBeTruthy()
  })

  it('shows auto approve hints when mode is auto', () => {
    renderFileSection('auto')
    expect(screen.getByText(/满足以下全部条件时自动执行/)).toBeTruthy()
  })

  it('opens confirm modal when switching to auto', () => {
    const { setToolUi } = renderFileSection('diff')
    fireEvent.click(screen.getByText('自动放行安全写入'))
    expect(screen.getAllByText('确认切换为自动放行安全写入？').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '确认开启' }))
    expect(setToolUi).toHaveBeenCalled()
  })
})
