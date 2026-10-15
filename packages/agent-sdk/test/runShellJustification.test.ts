import { describe, expect, it } from 'vitest'
import { normalizeRunShellJustification, RUN_SHELL_JUSTIFICATION_MAX_CODE_POINTS } from '../src/runShellJustification'

describe('normalizeRunShellJustification', () => {
  it('trims and Unicode-normalizes a per-call reason without changing the command', () => {
    expect(normalizeRunShellJustification({ command: 'git status', justification: '  e\u0301  ' }))
      .toEqual({ command: 'git status', justification: 'é' })
  })

  it('omits empty values and truncates by Unicode code point with metadata', () => {
    expect(normalizeRunShellJustification({ command: 'pwd', justification: '  ' })).toEqual({ command: 'pwd' })
    const normalized = normalizeRunShellJustification({ command: 'pwd', justification: '😀'.repeat(RUN_SHELL_JUSTIFICATION_MAX_CODE_POINTS + 1) })
    expect(normalized.justification).toBe('😀'.repeat(RUN_SHELL_JUSTIFICATION_MAX_CODE_POINTS))
    expect(normalized._justificationTruncated).toBe(true)
  })

  it('does not coerce invalid values', () => {
    const input = { command: 'pwd', justification: 7 }
    expect(normalizeRunShellJustification(input)).toEqual({ command: 'pwd', justification: 7 })
    expect(normalizeRunShellJustification({ command: 'pwd', _justificationTruncated: true }))
      .toEqual({ command: 'pwd' })
  })
})
