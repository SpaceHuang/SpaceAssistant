import { describe, expect, it } from 'vitest'
import { extractCommandSignals } from './commandSequenceExtractor'

describe('command sequence effectiveCwd', () => {
  it('tracks POSIX cwd changes segment by segment', () => {
    const result = extractCommandSignals('cd src && cd ../tests && pwd', {
      os: 'darwin', workDir: '/workspace/project', sensitivePaths: []
    })
    const signal = result.signals[0]
    expect(signal.kind).toBe('command-sequence')
    if (signal.kind !== 'command-sequence') return
    expect(signal.commands.map((command) => command.effectiveCwd)).toEqual([
      '/workspace/project', '/workspace/project/src', '/workspace/project/tests'
    ])
  })

  it('tracks Windows PowerShell Set-Location with Windows path semantics', () => {
    const result = extractCommandSignals('Set-Location src; Get-Location', {
      os: 'win32', workDir: 'C:\\workspace\\project', sensitivePaths: []
    })
    const signal = result.signals[0]
    expect(signal.kind).toBe('command-sequence')
    if (signal.kind !== 'command-sequence') return
    expect(signal.commands[1]?.effectiveCwd).toMatch(/workspace[\\/]project[\\/]src$/i)
  })
})
