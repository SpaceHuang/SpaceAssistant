import { describe, expect, it } from 'vitest'
import { formatToolDuration } from './toolDurationFormat'

describe('formatToolDuration', () => {
  it.each([
    [0, '0ms'],
    [820, '820ms'],
    [1000, '1s'],
    [3400, '3.4s'],
    [60000, '1 分 00 秒'],
    [63000, '1 分 03 秒']
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatToolDuration(ms)).toBe(expected)
  })

  it('does not expose invalid duration values', () => {
    expect(formatToolDuration(-1)).toBeUndefined()
    expect(formatToolDuration(Number.NaN)).toBeUndefined()
  })
})
