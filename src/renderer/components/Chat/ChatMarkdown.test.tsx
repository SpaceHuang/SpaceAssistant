import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
})
