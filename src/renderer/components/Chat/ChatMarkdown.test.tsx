import { act, fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatMarkdown } from './ChatMarkdown'
import { maskSensitiveText } from '../../../shared/mcpSensitiveText'

describe('ChatMarkdown', () => {
  it('sanitizes MCP text after Markdown parsing, including escapes and entities', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'
    const { container } = render(<ChatMarkdown
      content={`## ghp\\_abcdefghijklmnopqrstuvwxyz1234567890\n\n## &#095;hp_abcdefghijklmnopqrstuvwxyz1234567890`}
      sanitizeText={maskSensitiveText}
    />)
    expect(container.querySelector('.chat-md-assistant')?.textContent).not.toContain(token)
  })
  it('sanitizes credentials split across inline Markdown nodes and link attributes', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'
    const { container } = render(<ChatMarkdown
      content={`**ghp**_abcdefghijklmnopqrstuvwxyz1234567890\n\n[report](https://example.test/?token=${token} "title-${token}")\n\n![image](https://example.test/${token}.png "alt-${token}")`}
      sanitizeText={maskSensitiveText}
    />)
    const root = container.querySelector('.chat-md-assistant') as HTMLElement
    expect(root.textContent).not.toContain(token)
    expect(root.querySelector('a')?.getAttribute('href')).not.toContain(token)
    expect(root.querySelector('a')?.getAttribute('title')).not.toContain(token)
    expect(root.querySelector('img')?.getAttribute('src')).not.toContain(token)
    expect(root.querySelector('img')?.getAttribute('alt')).not.toContain(token)
    expect(root.querySelector('a')?.textContent).toContain('report')
  })
  it('keeps links between multiple credential replacements intact', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'
    const { container } = render(<ChatMarkdown content={`ghp_abcdefghijklmnopqrstuvwxyz1234567890 [正常链接](https://example.test) ghp_abcdefghijklmnopqrstuvwxyz1234567890`} sanitizeText={maskSensitiveText} />)
    expect(container.querySelector('a')?.textContent).toBe('正常链接')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.test/')
    expect(container.textContent).not.toContain(token)
  })
  it('maps cross-node credentials to their real source range', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890'
    const { container } = render(<ChatMarkdown
      content={'状态 OK；**ghp**_abcdefghijklmnopqrstuvwxyz1234567890 OK；'}
      sanitizeText={maskSensitiveText}
    />)
    expect(container.textContent).toContain('状态 OK；<secret:redacted> OK；')
    expect(container.textContent).not.toContain(token)
  })
  it('does not replace normal links before a credential', () => {
    const { container } = render(<ChatMarkdown
      content={'[下载业务报告](https://example.test/report)：&#103;hp_abcdefghijklmnopqrstuvwxyz1234567890。'}
      sanitizeText={maskSensitiveText}
    />)
    expect(container.querySelector('a')?.textContent).toBe('下载业务报告')
    expect(container.textContent).toContain('下载业务报告：<secret:redacted>。')
  })
  it('keeps a link label after an inline authorization header', () => {
    const { container } = render(<ChatMarkdown
      content={'请求 Authorization: Basic dXNlcjpwYXNzd29yZA==；下载 [业务报告](https://example.test/report)。'}
      sanitizeText={maskSensitiveText}
    />)
    expect(container.querySelector('a')?.textContent).toBe('业务报告')
  })
  it('preserves the prefix when a credential is the final text', () => {
    const { container } = render(<ChatMarkdown
      content={'业务前缀：ghp_abcdefghijklmnopqrstuvwxyz1234567890'}
      sanitizeText={maskSensitiveText}
    />)
    expect(container.textContent).toBe('业务前缀：<secret:redacted>')
  })
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
