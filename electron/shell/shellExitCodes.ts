const EXIT_HINTS: Record<number, string> = {
  1: '一般性错误',
  2: '误用 shell 命令',
  126: '命令不可执行（权限或格式问题）',
  127: '命令未找到',
  130: '被 SIGINT 中断（Ctrl+C）',
  137: '被 SIGKILL 强制终止',
  143: '被 SIGTERM 终止'
}

export function describeExitCode(code: number | null | undefined): string | undefined {
  if (code === null || code === undefined) return undefined
  return EXIT_HINTS[code] ?? (code !== 0 ? `进程异常退出（退出码 ${code}）` : undefined)
}
