import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { InlineInput } from './InlineInput'

describe('InlineInput', () => {
  it('renders with default value', () => {
    render(<InlineInput defaultValue="untitled" onConfirm={vi.fn()} onCancel={vi.fn()} />)
    const input = screen.getByRole('textbox')
    expect(input).toBeDefined()
    expect((input as HTMLInputElement).value).toBe('untitled')
  })

  it('confirms on Enter', () => {
    const onConfirm = vi.fn()
    render(<InlineInput defaultValue="test" onConfirm={onConfirm} onCancel={vi.fn()} />)
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledWith('test')
  })

  it('cancels on Escape', () => {
    const onCancel = vi.fn()
    render(<InlineInput defaultValue="test" onConfirm={vi.fn()} onCancel={onCancel} />)
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })

  it('confirms on blur', () => {
    const onConfirm = vi.fn()
    render(<InlineInput defaultValue="blurtest" onConfirm={onConfirm} onCancel={vi.fn()} />)
    const input = screen.getByRole('textbox')
    fireEvent.blur(input)
    expect(onConfirm).toHaveBeenCalledWith('blurtest')
  })

  it('trims whitespace on confirm', () => {
    const onConfirm = vi.fn()
    render(<InlineInput defaultValue="  spaced  " onConfirm={onConfirm} onCancel={vi.fn()} />)
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledWith('spaced')
  })

  it('does not confirm empty name', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<InlineInput defaultValue="  " onConfirm={onConfirm} onCancel={onCancel} />)
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalled()
  })
})