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

function hasPowerShellScriptBlock(command: string): boolean {
  // Bash parameter expansion such as ${PIPESTATUS[0]} is not a PowerShell block.
  return /\b(?:ForEach-Object|Where-Object|ForEach|Where)\s*\{/.test(command) || /\|\s*\{/.test(command)
}

// P0-B（§4.2.1）：仅当出现 PowerShell「无法解释」的 POSIX 变量形态时才计 posix-variable。
// 位置/特殊参数 $1/$@/$*（$? 在 PowerShell 中合法且常用，不计；$$ 在 PowerShell 中为上一行最后一个
// token 的自动变量，同样合法，不计）。
const POSIX_POSITIONAL_PARAM_PATTERN = /\$[0-9@*]/
// bash 参数展开修饰符：${VAR:…} ${VAR#…} ${VAR%…} ${VAR/…} ${VAR[…]}；PowerShell 的 ${name} 仅支持纯名称。
const POSIX_EXPANSION_PATTERN = /\$\{[A-Za-z_][A-Za-z0-9_]*[:#%/\[]/

// P0-B（§4.2.2）：cmd 方言信号（此前对 cmd-in-PowerShell 只有 cmd-variable 一条）。
// 注意：`;` 是 PowerShell 的合法语句分隔符，「exe a; exe b」在 PowerShell 下可正常执行，
// 不构成 cmd 混入证据（评审 BLK-1）；真正的 cmd 串联符是 `&`（无条件串联），「词 & 词」在
// PowerShell 5.1 中是语法错误——以此作为 cmd 方言证据。要求 & 前是词字符，以免误伤
// PowerShell 合法的调用运算符用法（如 { & cmd }、; & cmd）；`&&` 由 posix-operator 覆盖。
const CMD_OPERATOR_PATTERN = /\w\s&\s/
// PowerShell 的 dir/copy/del 是 cmdlet 别名，`/x` 风格开关会解析失败（§1.1 真实失败案例）。
const CMD_DIR_SWITCH_PATTERN = /\bdir\s+\/[A-Za-z]/i
const CMD_COPY_SWITCH_PATTERN = /\bcopy\s+\/[A-Za-z]/i
const CMD_DEL_SWITCH_PATTERN = /\b(?:del|erase)\s+\/[A-Za-z]/i
// `set VAR=value`（cmd 赋值；PowerShell 中 set 是 Set-Item 别名，此写法非法）。
const CMD_SET_VAR_PATTERN = /(^|[\s;&])set\s+[A-Za-z_][A-Za-z0-9_]*=/

function windowsCmdHints(): string[] {
  return [
    '命令混入了 cmd 语法，请改写为 PowerShell 等价命令',
    '环境变量使用 $env:NAME；dir 改用 Get-ChildItem，copy 改用 Copy-Item，del 改用 Remove-Item',
    'cmd 的 & 串联在 PowerShell 中不可用，直接用 ; 分隔各命令即可'
  ]
}

function posixBashHints(): string[] {
  return ['使用 PowerShell 语法重写命令', '环境变量使用 $env:NAME，空输出使用 $null']
}

/** D-8（v1.4 定案）：同会话第 2 次同款错配不再重复同一句，直接给出改写后的命令形态（提示升级，不阻断）。 */
export function escalatedDialectMismatchHints(detectedSyntax: ShellDialect): string[] {
  return detectedSyntax === 'windows-cmd'
    ? [
        '同会话内第二次出现同款方言错配：请直接按 PowerShell 形态给出改写后的整条命令，不要再次提交混有 cmd 语法的版本',
        '改写形态示例：cmd 的 & 串联直接改用 ; 分隔命令，dir /b 改用 Get-ChildItem',
        '环境变量使用 $env:NAME；copy 改用 Copy-Item，del 改用 Remove-Item'
      ]
    : [
        '同会话内第二次出现同款方言错配：请直接按 PowerShell 形态给出改写后的整条命令，不要再次提交 POSIX 语法版本',
        '改写形态示例：把 export A=1 改写为 $env:A = "1"，把 cmd > /dev/null 改写为 cmd | Out-Null',
        '环境变量使用 $env:NAME，空输出使用 $null'
      ]
}

export function detectShellDialectMismatch(command: string, profile: ShellProfile): ShellDialectMismatch | undefined {
  const signals: string[] = []
  if (profile.dialect === 'windows-powershell') {
    if (/\bexport\s+[A-Za-z_][A-Za-z0-9_]*=/.test(command)) signals.push('posix-export')
    if (POSIX_POSITIONAL_PARAM_PATTERN.test(command) || POSIX_EXPANSION_PATTERN.test(command)) signals.push('posix-variable')
    if (command.includes('/dev/null')) signals.push('posix-dev-null')
    if (/\brm\s+-[^\n]*\brf\b/.test(command)) signals.push('posix-rm-rf')
    if (/(^|\s)%[A-Za-z_][A-Za-z0-9_]*%/.test(command)) signals.push('cmd-variable')
    if (CMD_OPERATOR_PATTERN.test(command)) signals.push('cmd-operator')
    if (CMD_DIR_SWITCH_PATTERN.test(command)) signals.push('cmd-dir-switch')
    if (CMD_COPY_SWITCH_PATTERN.test(command)) signals.push('cmd-copy-switch')
    if (CMD_DEL_SWITCH_PATTERN.test(command)) signals.push('cmd-del-switch')
    if (CMD_SET_VAR_PATTERN.test(command)) signals.push('cmd-set-var')
    if (/(^|\s)([^\n]+)\s&&\s/.test(command)) signals.push('posix-operator')
    if (!signals.length) return undefined
    // §4.2.3：detectedSyntax 与 hints 一致——cmd 类信号命中时按「cmd 混入」口径给出 PowerShell 等价写法；
    // 否则按 posix-bash 口径给出 PowerShell 改写指导（不再对 cmd 命令给出 posix hints，反之亦然）。
    const detectedSyntax: ShellDialect = signals.some((signal) => signal.startsWith('cmd-')) ? 'windows-cmd' : 'posix-bash'
    return {
      code: 'SHELL_DIALECT_MISMATCH', detectedSyntax, expectedDialect: profile.dialect,
      shellProfileId: profile.id, executable: profile.executable, signals,
      hints: detectedSyntax === 'windows-cmd' ? windowsCmdHints() : posixBashHints()
    }
  }

  const hasScriptBlock = hasPowerShellScriptBlock(command)
  if (/(^|\s)\$env:[A-Za-z_][A-Za-z0-9_]*|\$null\b/.test(command) ||
      /\b(?:Remove-Item|Get-ChildItem|Write-Output)\b/.test(command) ||
      hasScriptBlock) {
    if (command.includes('$env:')) signals.push('powershell-variable')
    if (command.includes('$null')) signals.push('powershell-null')
    if (/\b(?:Remove-Item|Get-ChildItem|Write-Output)\b/.test(command)) signals.push('powershell-cmdlet')
    if (hasScriptBlock) signals.push('powershell-script-block')
    // 本分支同时覆盖 posix-bash 与 windows-cmd 两类非 PowerShell 目标；hints 按目标方言给出（评审观察项 3）
    const hints = profile.dialect === 'windows-cmd'
      ? ['使用 cmd 语法重写命令', '环境变量使用 %NAME%，目录列举用 dir，删除用 del /q']
      : ['使用 POSIX Bash 语法重写命令', '环境变量使用 $NAME，空输出使用 /dev/null']
    return {
      code: 'SHELL_DIALECT_MISMATCH', detectedSyntax: 'windows-powershell', expectedDialect: profile.dialect,
      shellProfileId: profile.id, executable: profile.executable, signals,
      hints
    }
  }
  return undefined
}
