import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ThinkingBlock } from './ThinkingBlock'

describe('ThinkingBlock', () => {
  it('renders collapsed by default when not active', () => {
    render(<ThinkingBlock content="inner monologue" active={false} />)
    const toggle = screen.getByRole('button', { name: /思考/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('inner monologue')).toBeNull()
  })

  it('expands and collapses on toggle', () => {
    render(<ThinkingBlock content="plan steps" active={false} />)
    const toggle = screen.getByRole('button', { name: /思考/ })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('plan steps')).toBeDefined()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('plan steps')).toBeNull()
  })

  it('starts expanded when active', () => {
    render(<ThinkingBlock content="streaming thought" active />)
    expect(screen.getByText('streaming thought')).toBeDefined()
  })

  it('collapses when active becomes false', () => {
    const { rerender } = render(<ThinkingBlock content="done thought" active />)
    expect(screen.getByText('done thought')).toBeDefined()
    rerender(<ThinkingBlock content="done thought" active={false} />)
    expect(screen.queryByText('done thought')).toBeNull()
  })
})
