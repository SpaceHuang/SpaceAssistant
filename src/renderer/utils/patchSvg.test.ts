import { describe, it, expect } from 'vitest'
import { patchSvg } from './patchSvg'

const sample = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path fill="#09244B" d="M0 0"/></svg>'

describe('patchSvg', () => {
  it('adds viewBox and replaces fill color', () => {
    const result = patchSvg(sample)
    expect(result).toContain('viewBox="0 0 24 24"')
    expect(result).toContain('fill="currentColor"')
    expect(result).not.toContain('#09244B')
  })

  it('applies custom size', () => {
    const result = patchSvg(sample, 16)
    expect(result).toContain('width="16"')
    expect(result).toContain('height="16"')
  })

  it('strips embedded title and desc so native tooltips do not override button title', () => {
    const withTitle =
      '<svg width="24" height="24"><title>book_2_ai_line</title><desc>icon</desc><path fill="#09244b"/></svg>'
    const result = patchSvg(withTitle)
    expect(result).not.toContain('<title>')
    expect(result).not.toContain('book_2_ai_line')
    expect(result).not.toContain('<desc>')
  })
})
