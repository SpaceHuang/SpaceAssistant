import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ArtifactSettingsTab } from './ArtifactSettingsTab'

describe('ArtifactSettingsTab', () => {
  it('shows artifact master switch and scratch Git policy without extension mapping UI', () => {
    render(
      <ArtifactSettingsTab
        value={{ artifactManagementEnabled: false, scratchGitPolicy: 'ask' }}
        onChange={() => {}}
      />
    )
    expect(screen.getByText('启用工作产物管理')).toBeTruthy()
    expect(screen.getByText('草稿 Git 策略')).toBeTruthy()
    expect(screen.queryByText('扩展名')).toBeNull()
    expect(screen.queryByText('新增映射')).toBeNull()
    expect(screen.queryByText('首次写入前确认写入目录')).toBeNull()
  })

  it('updates artifactManagementEnabled when toggled', () => {
    const onChange = vi.fn()
    render(
      <ArtifactSettingsTab
        value={{ artifactManagementEnabled: false, scratchGitPolicy: 'ask' }}
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledWith({ artifactManagementEnabled: true, scratchGitPolicy: 'ask' })
  })

  it('updates scratch Git policy choice', () => {
    const onChange = vi.fn()
    render(
      <ArtifactSettingsTab
        value={{ artifactManagementEnabled: true, scratchGitPolicy: 'ask' }}
        onChange={onChange}
      />
    )
    fireEvent.click(screen.getByText('加入 .gitignore（仅 .spaceassistant/runs/）'))
    expect(onChange).toHaveBeenCalledWith({ artifactManagementEnabled: true, scratchGitPolicy: 'add-ignore' })
  })
})
