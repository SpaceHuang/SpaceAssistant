import { act, fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatMarkdown } from './ChatMarkdown'

describe('ChatMarkdown', () => {
  it('renders inline and block LaTeX math', () => {
    const content = ['Inline $E=mc^2$ and block:', '', '$$', '\\frac{a}{b}', '$$'].join('\n')
    const { container } = render(<ChatMarkdown content={content} />)
    const root = container.querySelector('.chat-md-assistant') as HTMLElement
    expect(root.querySelector('.katex')).toBeTruthy()
    expect(root.querySelector('.katex-display')).toBeTruthy()
    expect(root.textContent).toContain('E=mc')
  })

  it('renders LLM bracket-wrapped LaTeX blocks', () => {
    const content = [
      '[',
      String.raw`\boxed{`,
      String.raw`P(B > A) = \int_{-\infty}^{+\infty} \int_{a}^{+\infty} f_A(a) , f_B(b) ; db ; da`,
      '}',
      ']'
    ].join('\n')
    const { container } = render(<ChatMarkdown content={content} />)
    const root = container.querySelector('.chat-md-assistant') as HTMLElement
    expect(root.querySelector('.katex-display')).toBeTruthy()
    expect(root.textContent).toContain('P')
  })

  it('renders inline dollar math without redundant \\boxed border', () => {
    const content = String.raw`$\boxed{E[f(X)] \approx f(\mu) + \frac{1}{2} f''(\mu) \cdot \sigma^2}$`
    const { container } = render(<ChatMarkdown content={content} />)
    const root = container.querySelector('.chat-md-assistant') as HTMLElement
    expect(root.querySelector('.katex')).toBeTruthy()
    expect(root.querySelector('.stretchy.fbox')).toBeNull()
    expect(root.textContent).toContain('E')
  })

  it('shows a Markdown copy button for tables and copies the table structure', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { container } = render(
      <ChatMarkdown content={'| Name | State |\n| --- | --- |\n| Alpha | Ready |'} />
    )

    const button = container.querySelector('.chat-md-table-copy') as HTMLButtonElement
    expect(button).toBeTruthy()
    fireEvent.click(button)
    await Promise.resolve()

    expect(writeText).toHaveBeenCalledWith('| Name | State |\n| --- | --- |\n| Alpha | Ready |')
  })

  it('resets the copied state when leaving the table', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { container } = render(
      <ChatMarkdown content={'| Name | State |\n| --- | --- |\n| Alpha | Ready |'} />
    )

    const shell = container.querySelector('.chat-md-table-shell') as HTMLElement
    const button = shell.querySelector('.chat-md-table-copy') as HTMLButtonElement
    await act(async () => {
      fireEvent.click(button)
      await Promise.resolve()
    })
    expect(button.textContent).toContain('已复制')

    fireEvent.mouseLeave(shell)
    expect(button.textContent).toContain('复制 Markdown 表格')
    expect(shell.classList.contains('chat-md-table-shell--mouse-left')).toBe(true)
  })
})
