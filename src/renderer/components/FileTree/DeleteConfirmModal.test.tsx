import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DeleteConfirmModal } from './DeleteConfirmModal'

describe('DeleteConfirmModal', () => {
  it('shows file-specific message', () => {
    render(<DeleteConfirmModal open={true} name="test.txt" isDirectory={false} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText(/test.txt/)).toBeDefined()
    expect(screen.getByText(/不可撤销/)).toBeDefined()
  })

  it('shows directory-specific message', () => {
    render(<DeleteConfirmModal open={true} name="mydir" isDirectory={true} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByText(/mydir/)).toBeDefined()
    expect(screen.getByText(/一并删除/)).toBeDefined()
  })

  it('calls onCancel when cancel is clicked', () => {
    const onCancel = vi.fn()
    render(<DeleteConfirmModal open={true} name="f" isDirectory={false} onConfirm={vi.fn()} onCancel={onCancel} />)
    const cancelBtn = document.body.querySelector('.ant-modal-footer button:first-child')
    expect(cancelBtn).toBeTruthy()
    fireEvent.click(cancelBtn as HTMLElement)
    expect(onCancel).toHaveBeenCalled()
  })

  it('calls onConfirm when delete is clicked', () => {
    const onConfirm = vi.fn()
    render(<DeleteConfirmModal open={true} name="f" isDirectory={false} onConfirm={onConfirm} onCancel={vi.fn()} />)
    const deleteBtn = document.body.querySelector('.ant-modal-footer button:last-child')
    expect(deleteBtn).toBeTruthy()
    fireEvent.click(deleteBtn as HTMLElement)
    expect(onConfirm).toHaveBeenCalled()
  })
})
