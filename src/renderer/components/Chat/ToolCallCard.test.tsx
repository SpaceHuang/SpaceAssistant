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
})
