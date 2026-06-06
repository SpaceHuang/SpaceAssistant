import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ShellConfirmCard } from './ShellConfirmCard'
import type { ToolCallRecord } from '../../../shared/domainTypes'

function record(partial: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 't1',
    toolName: 'run_shell',
    input: { command: 'npm install' },
    status: 'confirming',
    riskLevel: 'high',
    ...partial
  } as ToolCallRecord
}

describe('ShellConfirmCard', () => {
  it('shows risk ack button when required', () => {
    render(
      <ShellConfirmCard
        record={record({
          shellSecurityHints: {
            requiresRiskAck: true,
            outsideWorkDirRisk: true,
            warnings: ['命令包含工作目录外的路径']
          }
        })}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: '我了解风险，确认执行' })).toBeTruthy()
    expect(screen.getByText('高风险')).toBeTruthy()
    expect(screen.getAllByText(/npm install|rm -rf/).length).toBeGreaterThan(0)
    expect(screen.getByText(/路径安全警示/)).toBeTruthy()
  })

  it('shows normal confirm without warnings', () => {
    render(
      <ShellConfirmCard
        record={record({ input: { command: 'npm install', description: '下载 Playwright Chromium 浏览器（约 150-200MB，需联网）' } })}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: '确认执行' })).toBeTruthy()
    expect(screen.getByText('执行 Shell 命令')).toBeTruthy()
    expect(screen.getByText(/下载 Playwright Chromium/)).toBeTruthy()
    expect(screen.getByText(/npm install/)).toBeTruthy()
    expect(document.querySelector('.shell-tui-fallback')).toBeNull()
  })

  it('shows security warning for weak deny validators', () => {
    render(
      <ShellConfirmCard
        record={record({
          input: { command: 'git reset --hard origin/main' },
          shellSecurityHints: {
            requiresRiskAck: true,
            outsideWorkDirRisk: false,
            validatorId: 'dangerous_git',
            denyType: 'weak',
            securityWarning: '警告：此操作可能导致数据丢失\n\ngit reset --hard 会永久删除未提交的修改。\n\n确认执行？'
          }
        })}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByText('警告：此操作可能导致数据丢失')).toBeTruthy()
    expect(screen.getByText(/会永久删除未提交的修改/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '我了解风险，确认执行' })).toBeTruthy()
  })

  it('shows trust checkbox when canTrust', () => {
    render(
      <ShellConfirmCard
        record={record({
          shellSecurityHints: {
            requiresRiskAck: false,
            outsideWorkDirRisk: false,
            canTrust: true
          }
        })}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByLabelText(/信任此命令/)).toBeTruthy()
  })

  it('hides trust checkbox when canTrust is false', () => {
    render(
      <ShellConfirmCard
        record={record({
          shellSecurityHints: {
            requiresRiskAck: true,
            outsideWorkDirRisk: false,
            canTrust: false
          }
        })}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.queryByLabelText(/信任此命令/)).toBeNull()
  })

  it('passes trustCommand when checkbox checked and approved', () => {
    const onConfirm = vi.fn()
    render(
      <ShellConfirmCard
        record={record({
          input: { command: 'npm install' },
          shellSecurityHints: { requiresRiskAck: false, outsideWorkDirRisk: false, canTrust: true }
        })}
        onConfirm={onConfirm}
      />
    )
    fireEvent.click(screen.getByLabelText(/信任此命令/))
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }))
    expect(onConfirm).toHaveBeenCalledWith(true, { trustCommand: 'npm install' })
  })

  it('shows TUI fallback hint for vim', () => {
    render(
      <ShellConfirmCard
        record={record({ input: { command: 'vim src/main.ts' } })}
        workDir="E:\\work"
        onConfirm={vi.fn()}
      />
    )
    expect(document.querySelector('.shell-tui-fallback')).not.toBeNull()
    expect(document.body.textContent).toMatch(/交互式终端/)
  })
})
