import { describe, expect, it } from 'vitest'
import { sliceFileLines } from './readFileRange'

describe('sliceFileLines', () => {
  const text = 'line1\nline2\nline3\nline4\nline5'

  it('returns full file when no range', () => {
    const r = sliceFileLines(text, {})
    expect(r.content).toBe(text)
    expect(r.totalLines).toBe(5)
    expect(r.startLine).toBe(1)
    expect(r.endLine).toBe(5)
    expect(r.hasMore).toBe(false)
  })

  it('returns first N lines with limit only', () => {
    const r = sliceFileLines(text, { limit: 2 })
    expect(r.content).toBe('line1\nline2')
    expect(r.startLine).toBe(1)
    expect(r.endLine).toBe(2)
    expect(r.hasMore).toBe(true)
  })

  it('returns window with offset and limit', () => {
    const r = sliceFileLines(text, { offset: 2, limit: 2 })
    expect(r.content).toBe('line2\nline3')
    expect(r.startLine).toBe(2)
    expect(r.endLine).toBe(3)
    expect(r.hasMore).toBe(true)
  })

  it('returns empty when offset past end', () => {
    const r = sliceFileLines(text, { offset: 10, limit: 5 })
    expect(r.content).toBe('')
    expect(r.hasMore).toBe(false)
  })

  it('handles CRLF', () => {
    const r = sliceFileLines('a\r\nb\r\nc', { offset: 2, limit: 2 })
    expect(r.content).toBe('b\r\nc')
    expect(r.totalLines).toBe(3)
  })
})
