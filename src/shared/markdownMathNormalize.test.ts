import { describe, expect, it } from 'vitest'
import { normalizeMarkdownMath } from './markdownMathNormalize'

describe('normalizeMarkdownMath', () => {
  it('leaves standard dollar math unchanged', () => {
    const input = 'Inline $E=mc^2$ and block:\n\n$$\n\\frac{a}{b}\n$$'
    expect(normalizeMarkdownMath(input)).toBe(input)
  })

  it('converts \\[ \\] display delimiters', () => {
    expect(normalizeMarkdownMath(String.raw`\[ E=mc^2 \]`)).toBe('$$\nE=mc^2\n$$')
  })

  it('converts \\( \\) inline delimiters', () => {
    expect(normalizeMarkdownMath(String.raw`\( E=mc^2 \)`)).toBe('$E=mc^2$')
  })

  it('converts bracket-wrapped LaTeX blocks from LLM output', () => {
    const input = [
      '[',
      String.raw`\boxed{`,
      String.raw`P(B > A) = \int_{-\infty}^{+\infty} \int_{a}^{+\infty} f_A(a) , f_B(b) ; db ; da`,
      '}',
      ']'
    ].join('\n')

    const normalized = normalizeMarkdownMath(input)
    expect(normalized).toMatch(/^\$\$\n/)
    expect(normalized).not.toContain(String.raw`\boxed{`)
    expect(normalized).toContain('P(B > A)')
    expect(normalized).toMatch(/\n\$\$$/)
  })

  it('unwraps outer \\boxed when converting \\[ \\] delimiters', () => {
    expect(normalizeMarkdownMath(String.raw`\[ \boxed{E=mc^2} \]`)).toBe('$$\nE=mc^2\n$$')
  })

  it('keeps inner \\boxed inside a larger expression', () => {
    expect(normalizeMarkdownMath(String.raw`\[ E = \boxed{1} \]`)).toBe('$$\nE = \\boxed{1}\n$$')
  })

  it('unwraps nested-brace outer \\boxed', () => {
    expect(normalizeMarkdownMath(String.raw`\[ \boxed{\frac{a}{b}} \]`)).toBe('$$\n\\frac{a}{b}\n$$')
  })

  it('does not convert plain bracket lists without LaTeX commands', () => {
    const input = '[\nitem one\nitem two\n]'
    expect(normalizeMarkdownMath(input)).toBe(input)
  })

  it('converts latex environment blocks', () => {
    const input = String.raw`\begin{equation} E=mc^2 \end{equation}`
    expect(normalizeMarkdownMath(input)).toBe('$$\nE=mc^2\n$$')
  })

  it('unwraps outer \\boxed in inline dollar math', () => {
    const input = String.raw`$\boxed{E[f(X)] \approx f(\mu) + \frac{1}{2} f''(\mu) \cdot \sigma^2}$`
    const normalized = normalizeMarkdownMath(input)
    expect(normalized).not.toContain(String.raw`\boxed{`)
    expect(normalized).toContain('E[f(X)]')
    expect(normalized).toMatch(/^\$.*\$$/)
  })

  it('unwraps outer \\boxed in block dollar math on one line', () => {
    expect(normalizeMarkdownMath(String.raw`$$\boxed{E=mc^2}$$`)).toBe('$$E=mc^2$$')
  })
})
