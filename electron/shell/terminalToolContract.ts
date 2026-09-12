import { freezeShellProfileSnapshot, type ShellProfile } from './shellProfiles'

export interface TerminalProfileSnapshot {
  profile: ShellProfile
  os: NodeJS.Platform
  cwd: string
  pathSeparator: '/' | '\\'
  supportsAnsi: boolean
  supportsTty: boolean
}

export interface TerminalToolContract {
  toolName: 'run_shell'
  description: string
  capabilityBlock: string
  profileSnapshot: TerminalProfileSnapshot
}

export function freezeTerminalProfileSnapshot(snapshot: TerminalProfileSnapshot): TerminalProfileSnapshot {
  return Object.freeze({
    ...snapshot,
    profile: freezeShellProfileSnapshot(snapshot.profile)
  })
}

function fence(value: string): string {
  return `«${value.replaceAll('«', '‹').replaceAll('»', '›')}»`
}

export function buildTerminalToolContract(snapshot: TerminalProfileSnapshot): TerminalToolContract {
  snapshot = freezeTerminalProfileSnapshot(snapshot)
  const { profile } = snapshot
  const dialectText = profile.dialect === 'windows-powershell' ? 'Windows PowerShell 5.1' : 'POSIX Bash'
  const syntax = profile.dialect === 'windows-powershell'
    ? '使用 $env:NAME、$null、Remove-Item；不要使用 export、%NAME%、/dev/null 或 Bash 专属语法。'
    : '使用 $NAME、/dev/null 和 POSIX 引号；不要使用 $env:NAME、$null 或 PowerShell cmdlet。'
  const example = profile.dialect === 'windows-powershell'
    ? '示例：$env:NODE_ENV；Get-ChildItem .；多步命令使用 ; 或管道。'
    : '示例：$NODE_ENV；ls -la；多步命令使用 &&、; 或管道。'
  // 决策点 D7：native 工具的中文文本经 PowerShell 变量/管道会用宿主编码重写，损坏不可逆。
  const nativeTextRule = profile.dialect === 'windows-powershell'
    ? '不要用 PowerShell 变量或管道承接 native 工具（git、npm、node 等）的文本输出：宿主控制台编码与 native 输出编码可能不同，中文会被不可逆地损坏；请让命令直接输出，或重定向到文件后再用读文件工具处理。'
    : undefined
  const description = [
    `在 ${dialectText} 中执行命令。当前 shell dialect=${profile.dialect}，不是其他 Shell 方言。`,
    `当前 OS=${snapshot.os}，实际 executable=${fence(profile.executable)}，当前工作目录=${fence(snapshot.cwd)}。`,
    syntax,
    '命令中的变量、引号、路径分隔符和复合命令必须遵循当前 dialect。',
    example,
    nativeTextRule,
    '仅用于 npm、git、构建和测试等 CLI；文件读写、搜索和飞书操作优先使用专用工具。'
  ].filter((line): line is string => Boolean(line)).join(' ')
  const capabilityBlock = [
    '<terminal_environment>',
    `os: ${snapshot.os}`,
    `shell_profile_id: ${profile.id}`,
    `dialect: ${profile.dialect}`,
    `executable: ${fence(profile.executable)}`,
    `cwd: ${fence(snapshot.cwd)}`,
    `path_separator: ${snapshot.pathSeparator}`,
    `output_encoding: ${profile.outputEncoding.kind === 'oem' ? `oem:${profile.outputEncoding.codepage}` : profile.outputEncoding.kind}`,
    `supports_ansi: ${snapshot.supportsAnsi}`,
    `supports_tty: ${snapshot.supportsTty}`,
    '</terminal_environment>'
  ].join('\n')
  return { toolName: 'run_shell', description, capabilityBlock, profileSnapshot: snapshot }
}
