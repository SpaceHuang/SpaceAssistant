import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import { WriteConfirmCard } from './WriteConfirmCard'

function record(partial: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'w1',
    toolName: 'write_file',
    input: { path: 'notes.txt', content: 'hello' },
    status: 'confirming',
    ...partial
  } as ToolCallRecord
}

describe('WriteConfirmCard', () => {
  it('renders diff preview for write content', () => {
    render(<WriteConfirmCard record={record()} confirmMode="diff" onConfirm={vi.fn()} />)
    expect(screen.getByText(/写入「notes.txt」/)).toBeDefined()
    expect(screen.getByText('hello')).toBeDefined()
  })

  it('shows expand control when diff exceeds collapsed line budget', () => {
    const lines = Array.from({ length: 14 }, (_, i) => `line-${i}`).join('\n')
    render(
      <WriteConfirmCard
        record={record({ input: { path: 'big.txt', content: lines } })}
        confirmMode="diff"
        onConfirm={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: /展开全部（共 14 行）/ })).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /展开全部（共 14 行）/ }))
    expect(screen.getByRole('button', { name: '收起预览' })).toBeDefined()
  })
})
