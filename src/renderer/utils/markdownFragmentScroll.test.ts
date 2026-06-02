import { describe, expect, it } from 'vitest'
import { scrollToMarkdownFragment } from './markdownFragmentScroll'

describe('scrollToMarkdownFragment', () => {
  it('scrolls to heading by slug id', () => {
    const root = document.createElement('div')
    const heading = document.createElement('h2')
    heading.id = 'section-name'
    heading.textContent = 'Section Name'
    root.appendChild(heading)
    const scrollIntoView = vi.fn()
    heading.scrollIntoView = scrollIntoView

    const ok = scrollToMarkdownFragment('section-name', root)
    expect(ok).toBe(true)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' })
  })

  it('returns false when anchor is missing', () => {
    const root = document.createElement('div')
    expect(scrollToMarkdownFragment('missing', root)).toBe(false)
  })
})
