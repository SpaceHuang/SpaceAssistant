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

  it('不把 Bash 参数展开中的花括号误判为 PowerShell script block', () => {
    const command = 'printf "%s\\n" "$value" | tail -40; echo "=== EXIT:${PIPESTATUS[0]} ==="'
    expect(detectShellDialectMismatch(command, MACOS_BASH_PROFILE)).toBeUndefined()
  })

  it('识别 PowerShell 管道中的 script block', () => {
    expect(detectShellDialectMismatch('Get-Process | ForEach-Object { $_.Name }', MACOS_BASH_PROFILE)?.signals)
      .toContain('powershell-script-block')
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

  // ===== P0-B（§4.2）：收紧 posix-variable 误报 + 补齐 cmd 方言信号 =====

  // A-4：$p、$env:NAME、$null 等合法 PowerShell 语法不再单独构成 posix-variable 信号。
  // $PSVersionTable 等裸自动变量同样不得误报（本次事故的最小误报形态即 $p）。
  it('PowerShell 合法变量形态不产生 posix-variable 信号（A-4/A-5）', () => {
    expect(detectShellDialectMismatch('Get-ChildItem $p -Force', WINDOWS_POWERSHELL_PROFILE)).toBeUndefined()
    expect(detectShellDialectMismatch('echo $null', WINDOWS_POWERSHELL_PROFILE)).toBeUndefined()
    expect(detectShellDialectMismatch('echo $env:LOCALAPPDATA', WINDOWS_POWERSHELL_PROFILE)).toBeUndefined()
    expect(detectShellDialectMismatch('$PSVersionTable', WINDOWS_POWERSHELL_PROFILE)).toBeUndefined()
    // $?: PowerShell 合法自动变量（上一命令成功与否），不计信号
    expect(detectShellDialectMismatch('if ($?) { echo done }', WINDOWS_POWERSHELL_PROFILE)).toBeUndefined()
  })

  it('PowerShell 无法解释的 POSIX 变量形态仍产生 posix-variable 信号（收紧但不过放）', () => {
    // 位置/特殊参数：$1、$@、$*（$? 除外——PowerShell 中合法且常用）
    expect(detectShellDialectMismatch('echo $1', WINDOWS_POWERSHELL_PROFILE)?.signals).toContain('posix-variable')
    expect(detectShellDialectMismatch('echo $@', WINDOWS_POWERSHELL_PROFILE)?.signals).toContain('posix-variable')
    expect(detectShellDialectMismatch('echo $*', WINDOWS_POWERSHELL_PROFILE)?.signals).toContain('posix-variable')
    // bash 参数展开修饰符：${VAR:…} ${VAR#…} ${VAR%…} ${VAR/…} ${VAR[…]}
    expect(detectShellDialectMismatch('echo ${PATH##*/}', WINDOWS_POWERSHELL_PROFILE)?.signals).toContain('posix-variable')
    expect(detectShellDialectMismatch('echo ${HOME:-/tmp}', WINDOWS_POWERSHELL_PROFILE)?.signals).toContain('posix-variable')
    expect(detectShellDialectMismatch('echo ${HOME/a/b}', WINDOWS_POWERSHELL_PROFILE)?.signals).toContain('posix-variable')
    // 纯 ${name}（修饰符在花括号外的是路径拼接，PowerShell 同样支持）不误报
    expect(detectShellDialectMismatch('ls ${HOME}/bin', WINDOWS_POWERSHELL_PROFILE)).toBeUndefined()
  })

  it('cmd 方言混入 PowerShell：& 串联、dir/copy/del 开关、set VAR= 计 cmd-* 信号', () => {
    // 评审 BLK-1 定案：cmd 的串联符是 &（PowerShell 5.1 中「词 & 词」是语法错误）；`;` 是
    // PowerShell 合法语句分隔符，「exe a; exe b」可正常执行，不再判为 cmd 混入
    expect(detectShellDialectMismatch('where.exe a & where.exe b', WINDOWS_POWERSHELL_PROFILE)?.signals)
      .toContain('cmd-operator')
    expect(detectShellDialectMismatch('echo done & dir /b notes', WINDOWS_POWERSHELL_PROFILE)?.signals)
      .toContain('cmd-operator')
    expect(detectShellDialectMismatch('where.exe python; where.exe python3', WINDOWS_POWERSHELL_PROFILE))
      .toBeUndefined()
    // PowerShell 合法的 & 调用运算符用法不误报
    expect(detectShellDialectMismatch('{ & $cmd }', WINDOWS_POWERSHELL_PROFILE)).toBeUndefined()
    expect(detectShellDialectMismatch('Get-Content f; & "C:\\tools\\x.exe" --run', WINDOWS_POWERSHELL_PROFILE)).toBeUndefined()
    expect(detectShellDialectMismatch('dir /b "%APPDATA%"', WINDOWS_POWERSHELL_PROFILE)?.signals)
      .toContain('cmd-dir-switch')
    expect(detectShellDialectMismatch('copy /y a.txt b.txt', WINDOWS_POWERSHELL_PROFILE)?.signals)
      .toContain('cmd-copy-switch')
    expect(detectShellDialectMismatch('del /q tmp.txt', WINDOWS_POWERSHELL_PROFILE)?.signals)
      .toContain('cmd-del-switch')
    expect(detectShellDialectMismatch('set PATH=C:\\bin', WINDOWS_POWERSHELL_PROFILE)?.signals)
      .toContain('cmd-set-var')
  })

  // 评审 BLK-1 定案：§1.2 事故命令是语法合法的 PowerShell（; 分隔 + PS 控制流），方言修复后应放行
  // 正常执行；§1.2 的真实问题（posix-variable 误报 $p）已由 A-4 修复。真正需要拦截的 cmd 混写
  //（& 串联、dir /b 等）由 cmd-* 信号覆盖。
  it('§1.2 事故命令（合法 PowerShell 混写风格）在方言修复后放行', () => {
    const command = [
      'where.exe python; where.exe python3; where.exe uv; where.exe uvx; where.exe pipx;',
      'foreach($p in @("$env:LOCALAPPDATA\\uv","$env:USERPROFILE\\.local\\bin")){ if(Test-Path $p)',
      '{ "== $p"; Get-ChildItem $p -Force | Select-Object -First 15 -ExpandProperty Name } }'
    ].join(' ')
    expect(detectShellDialectMismatch(command, WINDOWS_POWERSHELL_PROFILE)).toBeUndefined()
  })

  it('detectedSyntax=windows-cmd 时 hints 给出 cmd→PowerShell 等价写法（口径一致）', () => {
    const result = detectShellDialectMismatch('dir /b notes & echo done', WINDOWS_POWERSHELL_PROFILE)
    expect(result?.detectedSyntax).toBe('windows-cmd')
    expect(result?.signals).toContain('cmd-dir-switch')
    const hints = result?.hints.join(' ') ?? ''
    expect(hints).toContain('Get-ChildItem')
    expect(hints).toContain('$env:')
  })

  it('detectedSyntax=posix-bash 时 hints 保持 PowerShell 改写指导（口径一致）', () => {
    const result = detectShellDialectMismatch('export A=1; ls /dev/null 2>&1', WINDOWS_POWERSHELL_PROFILE)
    expect(result?.detectedSyntax).toBe('posix-bash')
    const hints = result?.hints.join(' ') ?? ''
    expect(hints).toContain('$env:')
    expect(hints).not.toContain('Get-Command')
  })

  it('A-6 回归：纯 POSIX 命令在 PowerShell profile 下仍被拦', () => {
    expect(detectShellDialectMismatch('export FOO=bar; rm -rf dist', WINDOWS_POWERSHELL_PROFILE)?.code).toBe('SHELL_DIALECT_MISMATCH')
    expect(detectShellDialectMismatch('cat log | grep x > /dev/null', WINDOWS_POWERSHELL_PROFILE)?.signals).toContain('posix-dev-null')
    expect(detectShellDialectMismatch('echo a && echo b', WINDOWS_POWERSHELL_PROFILE)?.signals).toContain('posix-operator')
  })
})
