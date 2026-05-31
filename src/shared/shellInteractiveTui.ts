/**
 * 检测 run_shell 中不适合 in-app 管道 + 只读 xterm 的交互式 / 全屏 TUI 命令。
 * 与 shell-output-terminal-enhancement-requirement §9.1 一致：引导用户在外部终端执行。
 */

const INTERACTIVE_TUI_PATTERNS: RegExp[] = [
  /\bless\b/i,
  /\bmore\b/i,
  /\btop\b/i,
  /\bhtop\b/i,
  /\bvim\b/i,
  /\bvi\b/i,
  /\bnano\b/i,
  /\bemacs\b/i,
  /\bnpm\s+init\b(?![^\n]*\s-y\b)/i,
  /\bgit\s+rebase\b[^\n]*-i\b/i,
  /\bgit\s+-i\s+rebase\b/i
]

export function isInteractiveShellTuiCommand(command: string): boolean {
  const t = command.trim()
  if (!t) return false
  return INTERACTIVE_TUI_PATTERNS.some((re) => re.test(t))
}

export const SHELL_TUI_FALLBACK_TITLE = '此命令需要交互式终端'

export function shellTuiFallbackHintLines(): string[] {
  return [
    'SpaceAssistant 内的 run_shell 为只读输出，无法承载 less、vim、top、交互式 npm init 等全屏或需输入的程序。',
    '请在外部系统终端中于工作目录下自行执行该命令；可使用下方按钮打开终端。'
  ]
}
