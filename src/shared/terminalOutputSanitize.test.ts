import { describe, expect, it } from 'vitest'
import { normalizeTerminalOutput } from './terminalOutputSanitize'

describe('normalizeTerminalOutput', () => {
  it('strips ANSI SGR sequences', () => {
    const raw = 'Downloading Chrome\x1b[2m from https://example.com\x1b[22m'
    expect(normalizeTerminalOutput(raw)).toBe('Downloading Chrome from https://example.com')
  })

  it('keeps only the last segment after carriage return on a line', () => {
    const raw = '|          |   0%\r|==================|  50%\r|====================| 100%'
    expect(normalizeTerminalOutput(raw)).toBe('|====================| 100%')
  })

  it('collapses per-line carriage returns in multiline output', () => {
    const raw = 'line1\rline1b\nfoo\roverwritten'
    expect(normalizeTerminalOutput(raw)).toBe('line1b\noverwritten')
  })

  it('preserves plain text', () => {
    expect(normalizeTerminalOutput('added 47 packages in 3s')).toBe('added 47 packages in 3s')
  })

  it('preserves Windows CRLF lines', () => {
    expect(normalizeTerminalOutput('hello\r\nworld\r\n')).toBe('hello\nworld\n')
  })
})
