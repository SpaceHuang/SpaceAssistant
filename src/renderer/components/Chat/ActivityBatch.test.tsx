import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { AssistantActivityItem } from '../../../shared/assistantActivityTimeline'
import { ACTIVITY_BATCH_AUTO_COLLAPSE_DELAY_MS } from '../../../shared/activityBatchGrouping'
import { ActivityBatch } from './ActivityBatch'
import { changeAppLocale } from '../../i18n/localeSync'

const items: AssistantActivityItem[] = [
  { kind: 'thinking', segmentIndex: 0 },
  { kind: 'tool', toolId: 't1' }
]

const summary = {
  icon: <span data-testid="batch-icon">icon</span>,
  label: '读取 app.tsx 等 2 项'
}

describe('ActivityBatch', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    await changeAppLocale('zh-CN')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('collapsed by default when batch is completed', () => {
    render(
      <ActivityBatch
        items={items}
        isActive={false}
        summary={summary}
        renderItem={(item) => <div data-testid={`item-${item.kind}`}>{item.kind}</div>}
      />
    )
    expect(document.querySelector('.activity-batch--expanded')).toBeNull()
    expect(screen.getByRole('button', { name: '展开批次' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('item-thinking')).toBeNull()
  })

  it('expands and collapses on header click', () => {
    render(
      <ActivityBatch
        items={items}
        isActive={false}
        summary={summary}
        renderItem={(item) => <div data-testid={`item-${item.kind}`}>{item.kind}</div>}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '展开批次' }))
    expect(document.querySelector('.activity-batch--expanded')).not.toBeNull()
    expect(screen.getByTestId('item-thinking')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: '收起批次' }))
    expect(document.querySelector('.activity-batch--expanded')).toBeNull()
  })

  it('stays expanded while active', () => {
    render(
      <ActivityBatch
        items={items}
        isActive
        summary={summary}
        renderItem={(item) => <div data-testid={`item-${item.kind}`}>{item.kind}</div>}
      />
    )
    expect(document.querySelector('.activity-batch--expanded')).not.toBeNull()
    expect(screen.getByTestId('item-thinking')).toBeDefined()
  })

  it('auto collapses 5 seconds after batch completes', () => {
    const { rerender } = render(
      <ActivityBatch
        items={items}
        isActive
        summary={summary}
        renderItem={(item) => <div>{item.kind}</div>}
      />
    )
    expect(document.querySelector('.activity-batch--expanded')).not.toBeNull()
    rerender(
      <ActivityBatch
        items={items}
        isActive={false}
        summary={summary}
        renderItem={(item) => <div>{item.kind}</div>}
      />
    )
    expect(document.querySelector('.activity-batch--expanded')).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(ACTIVITY_BATCH_AUTO_COLLAPSE_DELAY_MS)
    })
    expect(document.querySelector('.activity-batch--expanded')).toBeNull()
  })

  it('pin prevents auto collapse', () => {
    const { rerender } = render(
      <ActivityBatch
        items={items}
        isActive
        summary={summary}
        renderItem={(item) => <div>{item.kind}</div>}
      />
    )
    rerender(
      <ActivityBatch
        items={items}
        isActive={false}
        summary={summary}
        renderItem={(item) => <div>{item.kind}</div>}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: '钉住批次' }))
    vi.advanceTimersByTime(ACTIVITY_BATCH_AUTO_COLLAPSE_DELAY_MS + 1000)
    expect(document.querySelector('.activity-batch--expanded')).not.toBeNull()
  })
})
