import { describe, expect, it } from 'vitest'
import { resolveNonPythonScriptLaunch } from './scriptRunner'

describe('resolveNonPythonScriptLaunch', () => {
  it('JavaScript uses the configured Node interpreter and module mode', () => {
    expect(resolveNonPythonScriptLaunch('javascript', 'console.log(1)', { javascript: '/custom/node' }, 'darwin')).toEqual({
      command: '/custom/node', args: ['--input-type=module', '-e', 'console.log(1)'], interpreterName: 'node', code: 'console.log(1)'
    })
  })

  it('TypeScript transpiles to native ESM before Node execution', () => {
    const launch = resolveNonPythonScriptLaunch('typescript', 'const answer: number = 42; console.log(answer)', {}, 'linux')
    expect(launch.command).toBe('node')
    expect(launch.args.slice(0, 2)).toEqual(['--input-type=module', '-e'])
    expect(launch.args[2]).not.toContain(': number')
    expect(launch.args[2]).toContain('answer')
  })

  it('PowerShell encodes the program as UTF-16LE for the native command-line contract', () => {
    const launch = resolveNonPythonScriptLaunch('powershell', 'Write-Output "你好"', {}, 'win32')
    expect(launch).toMatchObject({ command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', expect.any(String)] })
    expect(Buffer.from(launch.args.at(-1)!, 'base64').toString('utf16le')).toBe('Write-Output "你好"')
  })

  it('uses pwsh outside Windows and rejects unknown language values', () => {
    expect(resolveNonPythonScriptLaunch('powershell', 'Get-Date', {}, 'linux').command).toBe('pwsh')
    expect(() => resolveNonPythonScriptLaunch('ruby' as never, 'puts 1', {}, 'linux')).toThrow('UNSUPPORTED_SCRIPT_LANGUAGE')
  })
})
