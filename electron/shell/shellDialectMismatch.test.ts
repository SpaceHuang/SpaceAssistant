import { describe, expect, it } from 'vitest'
import { MACOS_BASH_PROFILE, WINDOWS_POWERSHELL_PROFILE } from './shellProfiles'
import { detectShellDialectMismatch } from './shellDialectMismatch'

describe('detectShellDialectMismatch', () => {
  it('识别 PowerShell 中高置信 POSIX 语法并提供结构化修复提示', () => {
    const result = detectShellDialectMismatch('export FOO=bar; rm -rf dist', WINDOWS_POWERSHELL_PROFILE)
    expect(result?.code).toBe('SHELL_DIALECT_MISMATCH')
    expect(result?.expectedDialect).toBe('windows-powershell')
    expect(result?.signals).toEqual(expect.arrayContaining(['posix-export', 'posix-rm-rf']))
  })

  it('识别 Bash 中 PowerShell cmdlet，但不因普通同名程序误报', () => {
    expect(detectShellDialectMismatch('Get-ChildItem .', MACOS_BASH_PROFILE)?.signals).toContain('powershell-cmdlet')
    expect(detectShellDialectMismatch('rm -rf dist', MACOS_BASH_PROFILE)).toBeUndefined()
  })
})
