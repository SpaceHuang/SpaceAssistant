import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import { ToolCallCard } from './ToolCallCard'

function writeRecord(status: ToolCallRecord['status'], extra: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'tool-1',
    toolName: 'write_file',
    input: { path: 'notes.txt', content: 'hello' },
    status,
    riskLevel: 'medium',
    ...extra
  }
}

describe('ToolCallCard file write expand behavior', () => {
  it('shows write confirm card with icon actions while confirming', () => {
    render(
      <ToolCallCard
        record={writeRecord('confirming', {
          confirmDiff: { oldContent: '', newContent: 'hello', oldPath: 'notes.txt' }
        })}
        confirmMode="diff"
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: '允许' })).toBeDefined()
    expect(screen.getByRole('button', { name: '拒绝' })).toBeDefined()
    expect(screen.getByText('notes.txt')).toBeDefined()
    expect(document.querySelector('.write-confirm-card')).not.toBeNull()
  })

  it('shows write success card after completion', () => {
    const onOpenFile = vi.fn()
    const { rerender } = render(
      <ToolCallCard
        record={writeRecord('confirming')}
        confirmMode="direct"
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: '允许' })).toBeDefined()

    rerender(
      <ToolCallCard
        record={writeRecord('completed', {
          result: { success: true },
          completedAt: Date.now(),
          confirmDiff: { oldContent: '', newContent: 'hello', oldPath: 'notes.txt' }
        })}
        confirmMode="direct"
        onOpenFile={onOpenFile}
      />
    )
    expect(screen.queryByRole('button', { name: '允许' })).toBeNull()
    expect(document.querySelector('.write-success-card')).not.toBeNull()
    expect(screen.getByText('notes.txt')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '查看' }))
    expect(onOpenFile).toHaveBeenCalledWith('notes.txt')
  })

  it('keeps list_directory collapsed by default when completed', () => {
    render(
      <ToolCallCard
        record={{
          id: 'tool-2',
          toolName: 'list_directory',
          input: { path: 'src' },
          status: 'completed',
          riskLevel: 'low',
          result: { success: true, data: [{ name: 'a.ts', type: 'file' }] },
          completedAt: Date.now()
        }}
        confirmMode="direct"
      />
    )
    expect(document.querySelector('.tool-row-detail')).toBeNull()
  })

  it('calls onConfirm when allow or deny icon is clicked', () => {
    const onConfirm = vi.fn()
    render(
      <ToolCallCard record={writeRecord('confirming')} confirmMode="direct" onConfirm={onConfirm} />
    )
    fireEvent.click(screen.getByRole('button', { name: '允许' }))
    expect(onConfirm).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it('does not show per-card cancel while browser is executing', () => {
    render(
      <ToolCallCard
        record={{
          id: 'tool-browser-exec',
          toolName: 'browser',
          input: { action: 'navigate', mode: 'open', url: 'https://example.com' },
          status: 'executing',
          riskLevel: 'medium'
        }}
        confirmMode="direct"
        onCancel={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: '取消执行' })).toBeNull()
  })

  it('keeps browser list row collapsed except confirm card', () => {
    const cases: ToolCallRecord[] = [
      {
        id: 'nav',
        toolName: 'browser',
        input: { action: 'navigate', mode: 'open', url: 'https://example.com' },
        status: 'executing',
        riskLevel: 'medium'
      },
      {
        id: 'extract',
        toolName: 'browser',
        input: { action: 'extract', instruction: 'get titles' },
        status: 'executing',
        riskLevel: 'medium'
      },
      {
        id: 'failed',
        toolName: 'browser',
        input: { action: 'observe', instruction: 'x' },
        status: 'failed',
        riskLevel: 'medium',
        result: { success: false, error: '失败' }
      }
    ]
    for (const record of cases) {
      const { container, unmount } = render(<ToolCallCard record={record} confirmMode="direct" />)
      expect(container.querySelector('.tool-row-detail')).toBeNull()
      expect(container.querySelector('.tool-row--expanded')).toBeNull()
      unmount()
    }
  })

  it('still shows per-card cancel for other tools while executing', () => {
    const onCancel = vi.fn()
    render(
      <ToolCallCard
        record={{
          id: 'tool-grep',
          toolName: 'grep',
          input: { pattern: 'foo' },
          status: 'executing',
          riskLevel: 'low'
        }}
        confirmMode="direct"
        onCancel={onCancel}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '取消执行' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('shows browser confirm card with URL while confirming navigate', () => {
    render(
      <ToolCallCard
        record={{
          id: 'tool-browser',
          toolName: 'browser',
          input: { action: 'navigate', mode: 'open', url: 'https://www.zhihu.com/billboard' },
          status: 'confirming',
          riskLevel: 'medium'
        }}
        confirmMode="direct"
        onConfirm={vi.fn()}
      />
    )
    expect(document.querySelector('.browser-confirm-card')).not.toBeNull()
    expect(screen.getByText('https://www.zhihu.com/billboard')).toBeDefined()
    expect(screen.getByText('URL')).toBeDefined()
    expect(screen.getByRole('button', { name: '确认' })).toBeDefined()
  })
})
