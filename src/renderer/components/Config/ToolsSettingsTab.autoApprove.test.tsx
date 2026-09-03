import { render, screen } from '@testing-library/react'
import { App } from 'antd'
import { describe, expect, it, vi } from 'vitest'
import { ToolsSettingsTab } from './ToolsSettingsTab'
import { DEFAULT_BROWSER_CONFIG, DEFAULT_SHELL_CONFIG } from '../../../shared/domainTypes'
import { DEFAULT_FEISHU_CONFIG } from '../../../shared/feishuTypes'

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
        feishuUi={DEFAULT_FEISHU_CONFIG}
        setFeishuUi={vi.fn()}
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
  it('file section no longer hosts confirmation mode (moved to security)', () => {
    renderFileSection()
    // 确认模式已迁移到「安全策略」页，文件操作仅保留历史备份/快照
    expect(screen.queryByText('展示文件修改内容')).toBeNull()
    expect(screen.queryByText('直接确认')).toBeNull()
    expect(screen.queryByText('自动放行安全写入')).toBeNull()
    expect(screen.getByText('文件历史备份')).toBeTruthy()
    expect(screen.getByText('每文件最多快照数')).toBeTruthy()
  })
})
