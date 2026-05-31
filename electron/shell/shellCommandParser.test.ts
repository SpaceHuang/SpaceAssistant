import { describe, expect, it } from 'vitest'
import { parseShellSegments } from './shellCommandParser'

describe('shellCommandParser', () => {
  it('splits && segments', () => {
    expect(parseShellSegments('npm install && npm test')).toEqual(['npm install', 'npm test'])
  })

  it('splits pipe outside quotes', () => {
    expect(parseShellSegments('git status | head')).toEqual(['git status', 'head'])
  })

  it('preserves quotes', () => {
    expect(parseShellSegments('"a && b" || c')).toEqual(['"a && b"', 'c'])
  })

  it('rejects too many segments', () => {
    const parts = Array.from({ length: 51 }, (_, i) => `echo ${i}`).join(' && ')
    expect(() => parseShellSegments(parts)).toThrow(/段数过多/)
  })
})
