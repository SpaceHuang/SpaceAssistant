import { describe, expect, it } from 'vitest'
import { normalizeAsciiTables } from './markdownAsciiTableNormalize'

describe('normalizeAsciiTables', () => {
  it('converts box-drawing table to GFM', () => {
    const input = [
      '不要问用户「Agent 好不好用」，观察他们做了什么：',
      '',
      '    ┌─────────────────────┬──────────────────────────────┐',
      '    │ 行为信号             │ 含义                          │',
      '    ├─────────────────────┼──────────────────────────────┤',
      '    │ accepted_as_is      │ Agent 输出直接可用             │',
      '    │ rejected            │ 输出不可用，用户放弃            │',
      '    └─────────────────────┴──────────────────────────────┘'
    ].join('\n')

    const out = normalizeAsciiTables(input)
    expect(out).toContain('| 行为信号 | 含义 |')
    expect(out).toContain('| --- | --- |')
    expect(out).toContain('| accepted_as_is | Agent 输出直接可用 |')
    expect(out).not.toContain('┌')
  })

  it('converts pipe-framed table with dash header border', () => {
    const input = [
      '|-------------------|--------------------------------|',
      '| 行为信号           | 含义                            |',
      '| accepted_as_is    | Agent 输出直接可用               |'
    ].join('\n')

    const out = normalizeAsciiTables(input)
    expect(out).toContain('| 行为信号 | 含义 |')
    expect(out).toContain('| accepted_as_is | Agent 输出直接可用 |')
  })

  it('leaves fenced code blocks unchanged', () => {
    const input = [
      '```',
      '┌─────┬─────┐',
      '│  A  │  B  │',
      '└─────┴─────┘',
      '```'
    ].join('\n')

    expect(normalizeAsciiTables(input)).toBe(input)
  })

  it('does not convert single pipe row', () => {
    const input = '| only one row | here |'
    expect(normalizeAsciiTables(input)).toBe(input)
  })
})
