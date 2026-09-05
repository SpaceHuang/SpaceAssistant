import { describe, expect, it } from 'vitest'
import { normalizeExternalToolName } from './toolNameCompatibility'

describe('normalizeExternalToolName', () => {
  it.each(['Bash', 'bash'])('maps legacy %s only at the external boundary', (name) => {
    expect(normalizeExternalToolName(name)).toEqual({ canonicalName: 'run_shell', originalName: name })
  })

  it('leaves canonical and unrelated names unchanged', () => {
    expect(normalizeExternalToolName('run_shell')).toEqual({ canonicalName: 'run_shell' })
    expect(normalizeExternalToolName('browser')).toEqual({ canonicalName: 'browser' })
  })
})
