import { describe, expect, it, vi } from 'vitest'
import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import type { Message } from '../../../shared/domainTypes'
import { QueuedTaskBar } from './QueuedTaskBar'

vi.mock('../../i18n/useTypedTranslation', () => ({ useTypedTranslation: () => ({ t: (key: string, options?: { count?: number; preview?: string; index?: number }) => ({
  'queuedBar.heading': `排队中 · ${options?.count ?? 0}`, 'queuedBar.imageOnly': '图片消息', 'queuedBar.cancelAria': `取消排队：${options?.preview ?? ''}`, 'queuedBar.editAria': `编辑排队消息：${options?.preview ?? ''}`, 'queuedBar.dragHandle': `拖动调整顺序 #${options?.index ?? 0}`, 'queuedBar.cancel': '取消', 'queuedBar.save': '保存', 'queuedBar.discardEdit': '放弃修改'
}[key] ?? key) }) }))

function item(id: string, content: string): Message {
  return { id, sessionId: 's1', role: 'user', content, timestamp: 1, status: 'queued', schemaVersion: 1 }
}

const props = (overrides: Partial<React.ComponentProps<typeof QueuedTaskBar>> = {}) => ({
  items: [item('q1', 'first'), item('q2', 'second')], editingId: null, draft: '',
  onBeginEdit: vi.fn(), onDraftChange: vi.fn(), onSubmitEdit: vi.fn(), onCancelEdit: vi.fn(), onCancel: vi.fn(), onReorder: vi.fn(), ...overrides
})

describe('QueuedTaskBar', () => {
  it('无排队项时不渲染', () => { const { container } = render(<QueuedTaskBar {...props({ items: [] })} />); expect(container.firstChild).toBeNull() })
  it('单条显示序号 #1 与正文摘要', () => { render(<QueuedTaskBar {...props({ items: [item('q1', 'hello')] })} />); expect(screen.getByText('#1')).toBeTruthy(); expect(screen.getByText('hello')).toBeTruthy() })
  it('多条按传入顺序排列且序号连续', () => { const { container } = render(<QueuedTaskBar {...props()} />); expect([...container.querySelectorAll('.queued-task-bar__summary')].map((el) => el.textContent)).toEqual(['first', 'second']); expect([...container.querySelectorAll('.queued-task-bar__index')].map((el) => el.textContent)).toEqual(['#1', '#2']) })
  it('标题行始终显示共 N 条', () => { render(<QueuedTaskBar {...props()} />); expect(screen.getByText('排队中 · 2')).toBeTruthy() })
  it('纯图片消息摘要显示占位文案', () => { render(<QueuedTaskBar {...props({ items: [item('q1', '')] })} />); expect(screen.getByText('图片消息')).toBeTruthy() })
  it('长文本保留全文 title', () => { const full = 'a'.repeat(100); render(<QueuedTaskBar {...props({ items: [item('q1', full)] })} />); expect(screen.getByTitle(full)).toBeTruthy() })
  it('点击取消按钮回调 messageId', () => { const onCancel = vi.fn(); const { container } = render(<QueuedTaskBar {...props({ items: [item('q1', 'hello')], onCancel })} />); fireEvent.click(container.querySelector('.queued-task-bar__cancel')!); expect(onCancel).toHaveBeenCalledWith('q1') })
  it('点击主体回调 onBeginEdit', () => { const onBeginEdit = vi.fn(); const { container } = render(<QueuedTaskBar {...props({ items: [item('q1', 'hello')], onBeginEdit })} />); fireEvent.click(container.querySelector('.queued-task-bar__summary')!); expect(onBeginEdit).toHaveBeenCalledWith('q1') })
  it('把拖动项放到目标项下半部后提交新的队列顺序', () => {
    const onReorder = vi.fn()
    const { container } = render(<QueuedTaskBar {...props({ onReorder })} />)
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(() => 'q1'), effectAllowed: 'none' }
    fireEvent.dragStart(screen.getByRole('button', { name: '拖动调整顺序 #1' }), { dataTransfer })
    const target = container.querySelectorAll('.queued-task-bar__row')[1]!
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 36, height: 36 } as DOMRect)
    fireEvent.dragOver(target)
    const drop = createEvent.drop(target, { dataTransfer })
    Object.defineProperty(drop, 'clientY', { value: 30 })
    fireEvent(target, drop)
    expect(onReorder).toHaveBeenCalledWith(['q2', 'q1'])
  })
  it('聚焦拖动把手后按方向键也可调整顺序', () => {
    const onReorder = vi.fn()
    render(<QueuedTaskBar {...props({ onReorder })} />)
    fireEvent.keyDown(screen.getByRole('button', { name: '拖动调整顺序 #2' }), { key: 'ArrowUp' })
    expect(onReorder).toHaveBeenCalledWith(['q2', 'q1'])
  })
  it('编辑态显示 textarea 和草稿', () => { render(<QueuedTaskBar {...props({ items: [item('q1', 'hello')], editingId: 'q1', draft: 'draft' })} />); expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('draft') })
  it('Enter 提交且 Shift+Enter 不提交', () => { const onSubmitEdit = vi.fn(); render(<QueuedTaskBar {...props({ items: [item('q1', 'hello')], editingId: 'q1', draft: 'draft', onSubmitEdit })} />); const editor = screen.getByRole('textbox'); fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true }); expect(onSubmitEdit).not.toHaveBeenCalled(); fireEvent.keyDown(editor, { key: 'Enter' }); expect(onSubmitEdit).toHaveBeenCalledTimes(1) })
  it('空白草稿按 Enter 不提交', () => { const onSubmitEdit = vi.fn(); render(<QueuedTaskBar {...props({ items: [item('q1', 'hello')], editingId: 'q1', draft: '  \n ', onSubmitEdit })} />); fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' }); expect(onSubmitEdit).not.toHaveBeenCalled() })
  it('Esc 取消编辑', () => { const onCancelEdit = vi.fn(); render(<QueuedTaskBar {...props({ items: [item('q1', 'hello')], editingId: 'q1', draft: 'draft', onCancelEdit })} />); fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' }); expect(onCancelEdit).toHaveBeenCalledOnce() })
  it('空白草稿禁用保存', () => { const { container } = render(<QueuedTaskBar {...props({ items: [item('q1', 'hello')], editingId: 'q1', draft: '  ' })} />); expect((container.querySelector('.queued-task-bar__save') as HTMLButtonElement).disabled).toBe(true) })
  it('submitting 时禁用保存', () => { const { container } = render(<QueuedTaskBar {...props({ items: [item('q1', 'hello')], editingId: 'q1', draft: 'yes', submitting: true })} />); expect((container.querySelector('.queued-task-bar__save') as HTMLButtonElement).disabled).toBe(true) })
  it('进入编辑后获得焦点且光标置末尾', () => { render(<QueuedTaskBar {...props({ items: [item('q1', 'hello')], editingId: 'q1', draft: 'draft' })} />); const editor = screen.getByRole('textbox') as HTMLTextAreaElement; expect(document.activeElement).toBe(editor); expect(editor.selectionStart).toBe(5) })
  it('退出编辑后焦点回到该行主体', () => { const p = props({ items: [item('q1', 'hello')] }); const { rerender, container } = render(<QueuedTaskBar {...p} />); rerender(<QueuedTaskBar {...p} editingId="q1" draft="x" />); rerender(<QueuedTaskBar {...p} editingId={null} draft="" />); expect(document.activeElement).toBe(container.querySelector('.queued-task-bar__summary')) })
  it('编辑行消失且还有其他项时焦点移至列表', () => { const p = props({ items: [item('q1', 'hello'), item('q2', 'other')] }); const { rerender, container } = render(<QueuedTaskBar {...p} editingId="q1" draft="x" />); rerender(<QueuedTaskBar {...p} items={[item('q2', 'other')]} editingId={null} draft="" />); expect(document.activeElement).toBe(container.querySelector('.queued-task-bar__list')) })
  it('列表容器可编程聚焦', () => { const { container } = render(<QueuedTaskBar {...props()} />); expect(container.querySelector('.queued-task-bar__list')?.getAttribute('tabindex')).toBe('-1') })
})
