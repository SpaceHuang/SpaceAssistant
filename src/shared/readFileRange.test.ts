import { describe, expect, it } from 'vitest'
import { sliceFileLines, sliceFileTailLines } from './readFileRange'

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

describe('sliceFileTailLines', () => {
  const text = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10'

  it('A1: returns last N lines in file order with hasMoreBefore', () => {
    const r = sliceFileTailLines(text, 3)
    expect(r.content).toBe('line8\nline9\nline10')
    expect(r.linesReturned).toBe(3)
    expect(r.hasMoreBefore).toBe(true)
  })

  it('A2: returns full file when tail exceeds total lines', () => {
    const r = sliceFileTailLines(text, 100)
    expect(r.content).toBe(text)
    expect(r.linesReturned).toBe(10)
    expect(r.hasMoreBefore).toBe(false)
  })

  it('ignores trailing empty line from terminating newline', () => {
    const r = sliceFileTailLines('a\nb\nc\n', 2)
    expect(r.content).toBe('b\nc')
    expect(r.linesReturned).toBe(2)
    expect(r.hasMoreBefore).toBe(true)
  })

  it('A11: preserves CRLF style', () => {
    const r = sliceFileTailLines('a\r\nb\r\nc\r\nd', 2)
    expect(r.content).toBe('c\r\nd')
    expect(r.linesReturned).toBe(2)
    expect(r.hasMoreBefore).toBe(true)
  })
})
