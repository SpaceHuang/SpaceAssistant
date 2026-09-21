import { describe, expect, it } from 'vitest'
import { MACOS_BASH_PROFILE, WINDOWS_CMD_PROFILE, WINDOWS_POWERSHELL_PROFILE } from './shellProfiles'
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

  // 评审观察项 3：cmd 候选的 hints 必须 cmd 语境，不得落到 POSIX Bash 文案
  it('cmd 候选宿主：PowerShell 命令报方言错配，hints 为 cmd 语法而非 POSIX Bash', () => {
    const result = detectShellDialectMismatch('Get-ChildItem . | Out-Null', WINDOWS_CMD_PROFILE)
    expect(result?.code).toBe('SHELL_DIALECT_MISMATCH')
    expect(result?.expectedDialect).toBe('windows-cmd')
    expect(result?.signals).toContain('powershell-cmdlet')
    const hints = result?.hints.join(' ') ?? ''
    expect(hints).toContain('cmd')
    expect(hints).not.toContain('POSIX Bash')
  })

  it('cmd 候选宿主：&& 与 %VAR% 等 cmd 原生语法不误报', () => {
    expect(detectShellDialectMismatch('echo a && echo %PATH%', WINDOWS_CMD_PROFILE)).toBeUndefined()
  })
})
