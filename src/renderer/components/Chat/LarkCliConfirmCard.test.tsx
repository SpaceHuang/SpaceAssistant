import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import { LarkCliConfirmCard } from './LarkCliConfirmCard'

function record(partial: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'lark-1',
    toolName: 'run_lark_cli',
    input: {
      args: ['message', 'send', '--chat-id', 'oc_x', '--text', 'hello']
    },
    status: 'confirming',
    riskLevel: 'high',
    ...partial
  }
}

describe('LarkCliConfirmCard', () => {
  it('uses shared confirm card chrome with write badge for send', () => {
    const onConfirm = vi.fn()
    render(<LarkCliConfirmCard record={record()} onConfirm={onConfirm} />)

    expect(document.querySelector('.write-confirm-card.lark-cli-confirm-card')).not.toBeNull()
    expect(screen.getByText('飞书 message send')).toBeDefined()
    expect(screen.getByText('写入')).toBeDefined()
    expect(screen.getByText(/lark-cli message send/)).toBeDefined()
    expect(screen.getByRole('button', { name: '确认飞书写入' })).toBeDefined()
    expect(screen.getByRole('button', { name: '拒绝写入' })).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: '确认飞书写入' }))
    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it('shows read-only confirm label for search', () => {
    render(
      <LarkCliConfirmCard
        record={record({ input: { args: ['message', 'search', '--query', 'hi'] } })}
        onConfirm={vi.fn()}
      />
    )
    expect(screen.queryByText('写入')).toBeNull()
    expect(screen.getByRole('button', { name: '确认飞书命令' })).toBeDefined()
    expect(screen.getByRole('button', { name: '拒绝命令' })).toBeDefined()
  })
})
