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
})
