import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ThinkingBlock } from './ThinkingBlock'
import { changeAppLocale } from '../../i18n/localeSync'

describe('ThinkingBlock', () => {
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
  })

  it('renders collapsed by default when not active', () => {
    render(<ThinkingBlock content="inner monologue" active={false} />)
    const toggle = screen.getByRole('button', { name: '展开思考过程' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.chat-thinking--expanded')).toBeNull()
  })

  it('expands and collapses on toggle', () => {
    render(<ThinkingBlock content="plan steps" active={false} />)
    const toggle = screen.getByRole('button', { name: '展开思考过程' })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('.chat-thinking--expanded')).not.toBeNull()
    expect(screen.getByText('plan steps')).toBeDefined()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.chat-thinking--expanded')).toBeNull()
  })

  it('uses plain text body while active', () => {
    render(<ThinkingBlock content="streaming thought" active />)
    expect(document.querySelector('pre.chat-stream-plain')).toBeNull()
    expect(document.querySelector('.chat-thinking__body')).not.toBeNull()
    expect(screen.getByText('streaming thought')).toBeDefined()
  })

  it('starts expanded when active', () => {
    render(<ThinkingBlock content="streaming thought" active />)
    expect(screen.getByText('streaming thought')).toBeDefined()
    expect(document.querySelector('.chat-thinking--expanded')).not.toBeNull()
  })

  it('collapses when active becomes false', () => {
    const { rerender } = render(<ThinkingBlock content="done thought" active />)
    expect(screen.getByText('done thought')).toBeDefined()
    rerender(<ThinkingBlock content="done thought" active={false} />)
    expect(document.querySelector('.chat-thinking--expanded')).toBeNull()
  })

  it('shows English label when locale is en-US', async () => {
    await changeAppLocale('en-US')
    render(<ThinkingBlock content="localized" active={false} />)
    expect(screen.getByText('Thinking')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Expand thinking' })).toBeDefined()
  })
})
