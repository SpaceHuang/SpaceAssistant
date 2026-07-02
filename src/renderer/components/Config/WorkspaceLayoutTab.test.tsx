import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WorkspaceLayoutTab } from './WorkspaceLayoutTab'

const baseConfig = {
  enabled: false,
  writeDirConfirmEnabled: true,
  extensionSubdirMap: [{ extension: 'py', subdir: 'Script' }]
}

describe('WorkspaceLayoutTab', { timeout: 60000 }, () => {
  it('disables map table when enabled is false', () => {
    render(<WorkspaceLayoutTab value={baseConfig} onChange={() => {}} />)
    expect((screen.getByDisplayValue('py') as HTMLInputElement).disabled).toBe(true)
  })

  it('enables map table when enabled is true', () => {
    render(<WorkspaceLayoutTab value={{ ...baseConfig, enabled: true }} onChange={() => {}} />)
    expect((screen.getByDisplayValue('py') as HTMLInputElement).disabled).toBe(false)
  })

  it('adds a new mapping row', () => {
    const onChange = vi.fn()
    render(<WorkspaceLayoutTab value={{ ...baseConfig, enabled: true }} onChange={onChange} />)
    fireEvent.click(screen.getByText('新增映射'))
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionSubdirMap: expect.arrayContaining([expect.objectContaining({ extension: '', subdir: '' })])
      })
    )
  })

  it('rejects subdir with path separator', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <WorkspaceLayoutTab value={{ ...baseConfig, enabled: true }} onChange={onChange} />
    )
    fireEvent.change(screen.getByDisplayValue('Script'), { target: { value: 'a/b' } })
    const next = onChange.mock.calls[0]?.[0] as typeof baseConfig
    rerender(<WorkspaceLayoutTab value={next} onChange={onChange} />)
    expect(screen.getByText(/不能包含路径分隔符/)).toBeTruthy()
  })
})
