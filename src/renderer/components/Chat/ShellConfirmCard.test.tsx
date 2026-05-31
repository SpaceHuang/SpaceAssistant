import { render, screen } from '@testing-library/react'
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
    expect(screen.getByText('Shell 命令')).toBeTruthy()
    expect(screen.getByText(/下载 Playwright Chromium/)).toBeTruthy()
    expect(screen.getByText(/npm install/)).toBeTruthy()
    expect(document.querySelector('.shell-tui-fallback')).toBeNull()
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
