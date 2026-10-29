import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { changeAppLocale } from '../../i18n/localeSync'
import type { SystemOperationRecord } from '../../../shared/domainTypes'
import { SystemOperationRow } from './SystemOperationRow'

const operation = (status: SystemOperationRecord['status'], extra: Partial<SystemOperationRecord> = {}): SystemOperationRecord => ({
  id: 'op-1', kind: 'context-compaction', status, startedAt: 1, ...extra
})

describe('SystemOperationRow', () => {
  beforeEach(async () => { await changeAppLocale('zh-CN') })

  it('shows the live state, committed usage, and cancellation without inventing ratios', () => {
    const { rerender } = render(<SystemOperationRow operation={operation('running')} />)
    expect(screen.getByRole('status').textContent).toContain('正在自动压缩')
    rerender(<SystemOperationRow operation={operation('succeeded', { beforePercent: 82, afterPercent: 41 })} />)
    expect(screen.getByRole('status').textContent).toContain('已压缩，占用 82% → 41%')
    rerender(<SystemOperationRow operation={operation('skipped', { reason: 'NO_GAIN' })} />)
    expect(screen.getByRole('status').textContent).toContain('未压缩（无收益）')
    expect(screen.getByRole('status').textContent).not.toContain('%')
    rerender(<SystemOperationRow operation={operation('cancelled')} />)
    expect(screen.getByRole('status').textContent).toContain('已取消')
    expect(screen.getByRole('status').textContent).not.toContain('压缩失败')
  })

  it('reveals a failure reason only after the user expands it', () => {
    render(<SystemOperationRow operation={operation('failed', { reason: 'SUMMARY_TIMEOUT' })} />)
    expect(screen.getByRole('status').textContent).toContain('压缩失败')
    expect(screen.queryByText(/摘要请求超时/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看原因' }))
    expect(screen.getByText(/摘要请求超时/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '收起原因' }))
    expect(screen.queryByText(/摘要请求超时/)).toBeNull()
  })

  it('renders structural and late-discard skips without occupancy ratios', () => {
    const { rerender } = render(<SystemOperationRow operation={operation('skipped', { reason: 'UNCOMPRESSIBLE' })} />)
    expect(screen.getByRole('status').textContent).toContain('未压缩（无法获得收益）')
    expect(screen.getByRole('status').textContent).not.toContain('%')
    rerender(<SystemOperationRow operation={operation('skipped', { reason: 'LATE_DISCARDED' })} />)
    expect(screen.getByRole('status').textContent).toContain('未压缩（上下文已变化）')
    expect(screen.getByRole('status').textContent).not.toContain('%')
  })

  it('tells the user when a lost compaction was replayed, re-split, or left fully expanded', () => {
    const { rerender } = render(<SystemOperationRow operation={operation('succeeded', { reason: 'REPAIR_ORIGINAL_WINDOW' })} />)
    expect(screen.getByRole('status').textContent).toContain('早期摘要已按原窗口重新生成')
    rerender(<SystemOperationRow operation={operation('succeeded', { reason: 'REPAIR_NEW_SPLIT' })} />)
    expect(screen.getByRole('status').textContent).toContain('早期上下文已按当前历史重新切分')
    rerender(<SystemOperationRow operation={operation('failed', { reason: 'REPAIR_FALLBACK_FULL_EXPAND' })} />)
    fireEvent.click(screen.getByRole('button', { name: '查看原因' }))
    expect(screen.getByText(/完整历史已保留/)).toBeTruthy()
  })
})
