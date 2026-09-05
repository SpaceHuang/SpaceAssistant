import type { ShellDialect, ShellProfile } from './shellProfiles'

export interface ShellDialectMismatch {
  code: 'SHELL_DIALECT_MISMATCH'
  detectedSyntax: ShellDialect
  expectedDialect: ShellDialect
  shellProfileId: string
  executable: string
  signals: string[]
  hints: string[]
}

export function detectShellDialectMismatch(command: string, profile: ShellProfile): ShellDialectMismatch | undefined {
  const signals: string[] = []
  if (profile.dialect === 'windows-powershell') {
    if (/\bexport\s+[A-Za-z_][A-Za-z0-9_]*=/.test(command)) signals.push('posix-export')
    if (/(^|\s)\$[A-Za-z_][A-Za-z0-9_]*(?=\s|$|[;|])/.test(command)) signals.push('posix-variable')
    if (command.includes('/dev/null')) signals.push('posix-dev-null')
    if (/\brm\s+-[^\n]*\brf\b/.test(command)) signals.push('posix-rm-rf')
    if (/(^|\s)%[A-Za-z_][A-Za-z0-9_]*%/.test(command)) signals.push('cmd-variable')
    if (/(^|\s)([^\n]+)\s&&\s/.test(command)) signals.push('posix-operator')
    if (!signals.length) return undefined
    return {
      code: 'SHELL_DIALECT_MISMATCH', detectedSyntax: 'posix-bash', expectedDialect: profile.dialect,
      shellProfileId: profile.id, executable: profile.executable, signals,
      hints: ['使用 PowerShell 语法重写命令', '环境变量使用 $env:NAME，空输出使用 $null']
    }
  }

  if (/(^|\s)\$env:[A-Za-z_][A-Za-z0-9_]*|\$null\b/.test(command) ||
      /\b(?:Remove-Item|Get-ChildItem|Write-Output)\b/.test(command) ||
      /\{[^\n]*\}/.test(command)) {
    if (command.includes('$env:')) signals.push('powershell-variable')
    if (command.includes('$null')) signals.push('powershell-null')
    if (/\b(?:Remove-Item|Get-ChildItem|Write-Output)\b/.test(command)) signals.push('powershell-cmdlet')
    if (/\{[^\n]*\}/.test(command)) signals.push('powershell-script-block')
    return {
      code: 'SHELL_DIALECT_MISMATCH', detectedSyntax: 'windows-powershell', expectedDialect: profile.dialect,
      shellProfileId: profile.id, executable: profile.executable, signals,
      hints: ['使用 POSIX Bash 语法重写命令', '环境变量使用 $NAME，空输出使用 /dev/null']
    }
  }
  return undefined
}
