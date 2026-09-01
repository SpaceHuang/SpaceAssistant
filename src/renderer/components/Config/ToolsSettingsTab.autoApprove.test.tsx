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

describe('ToolsSettingsTab script auto allow', () => {
  function renderScriptSection(autoAllow = false) {
    const setShellUi = vi.fn()
    render(
      <App>
        <ToolsSettingsTab
          section="script"
          toolUi={{
            confirmMode: 'diff',
            deniedTools: [],
            pythonPath: 'python',
            scriptTimeout: 300,
            fileCheckpointingEnabled: true,
            maxFileSnapshots: 100,
            grepTimeoutSec: 60
          }}
          setToolUi={vi.fn()}
          browserUi={DEFAULT_BROWSER_CONFIG}
          setBrowserUi={vi.fn()}
          shellUi={{ ...DEFAULT_SHELL_CONFIG, autoAllowScriptExecution: autoAllow }}
          setShellUi={setShellUi}
          onShellEnabledChange={vi.fn()}
          models={[]}
          pyTest={null}
          pyTesting={false}
          onTestPython={vi.fn()}
        />
      </App>
    )
    return { setShellUi }
  }

  it('renders auto allow switch on script section', () => {
    renderScriptSection()
    expect(screen.getByText(/大模型生成的脚本自动允许执行/)).toBeTruthy()
  })

  it('opens confirm modal when enabling auto allow', () => {
    const { setShellUi } = renderScriptSection(false)
    fireEvent.click(screen.getByRole('switch'))
    expect(screen.getAllByText('确认开启？').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '确认开启' }))
    expect(setShellUi).toHaveBeenCalled()
  })
})

describe('ToolsSettingsTab auto approve', () => {
  it('file section no longer hosts confirmation mode (moved to security)', () => {
    renderFileSection()
    // 确认模式已迁移到「工具与安全」页，文件操作仅保留历史备份/快照
    expect(screen.queryByText('展示文件修改内容')).toBeNull()
    expect(screen.queryByText('直接确认')).toBeNull()
    expect(screen.queryByText('自动放行安全写入')).toBeNull()
    expect(screen.getByText('文件历史备份')).toBeTruthy()
    expect(screen.getByText('每文件最多快照数')).toBeTruthy()
  })
})
