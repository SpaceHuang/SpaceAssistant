import path from 'path'

/** Windows 上 process.env 可能是 Path 而非 PATH */
export function resolveShellPathEnv(base: NodeJS.ProcessEnv): string {
  return base.PATH ?? base.Path ?? base.path ?? ''
}

/** GUI 启动的 Electron 常缺少 npm/nodejs 路径，与 npmCommandRunner 对齐 */
export function augmentShellPathEnv(base: NodeJS.ProcessEnv): string {
  const existing = resolveShellPathEnv(base)
  if (process.platform !== 'win32') return existing
  const extra: string[] = []
  if (base.APPDATA) extra.push(path.join(base.APPDATA, 'npm'))
  if (base.ProgramFiles) extra.push(path.join(base.ProgramFiles, 'nodejs'))
  if (base['ProgramFiles(x86)']) extra.push(path.join(base['ProgramFiles(x86)'], 'nodejs'))
  if (base.LOCALAPPDATA) extra.push(path.join(base.LOCALAPPDATA, 'Programs', 'nodejs'))
  return [...extra, existing].filter(Boolean).join(path.delimiter)
}

/** 保留 TLS 相关的 NODE_OPTIONS，其余仍由 buildShellEnv 过滤 */
export function pickSafeNodeOptions(base: NodeJS.ProcessEnv): string | undefined {
  const raw = base.NODE_OPTIONS?.trim()
  if (!raw) return undefined
  const safe = raw
    .split(/\s+/)
    .filter((t) => t === '--use-system-ca' || t.startsWith('--use-system-ca='))
  return safe.length ? safe.join(' ') : undefined
}

/**
 * run_shell 经管道捕获 stdout/stderr（非 TTY）时，Playwright 默认进度条会块缓冲，
 * UI 长期停在 0%。强制非 TTY 模式并开启 pw:install 调试日志（按行输出、更易刷新）。
 */
export function applyPlaywrightInstallShellEnv(env: NodeJS.ProcessEnv, command: string): void {
  if (!/\bplaywright\s+install\b/i.test(command)) return
  env.PLAYWRIGHT_FORCE_TTY = '0'
  if (!env.DEBUG?.includes('pw:install')) {
    env.DEBUG = env.DEBUG ? `${env.DEBUG},pw:install` : 'pw:install'
  }
}
