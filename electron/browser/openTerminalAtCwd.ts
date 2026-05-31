import path from 'node:path'
import { spawn } from 'node:child_process'
import type { BrowserDetectContext } from './browserDependencyDetect'
import { isAllowedTerminalCwd } from './browserDependencyDetect'

export type OpenTerminalResult = { ok: true } | { ok: false; error: string }

export type OpenTerminalAtCwdOptions = {
  /** Shell 卡片：允许会话工作目录（与 config.workDir 一致） */
  allowedWorkDir?: string
}

function isAllowedShellWorkDir(cwd: string, allowedWorkDir: string): boolean {
  try {
    return path.resolve(cwd) === path.resolve(allowedWorkDir)
  } catch {
    return false
  }
}

export function openTerminalAtCwd(
  cwd: string,
  ctx: BrowserDetectContext,
  options?: OpenTerminalAtCwdOptions
): OpenTerminalResult {
  const allowedWorkDir = options?.allowedWorkDir?.trim()
  const permitted = allowedWorkDir
    ? isAllowedShellWorkDir(cwd, allowedWorkDir)
    : isAllowedTerminalCwd(cwd, ctx)
  if (!permitted) {
    return { ok: false, error: '不允许在该目录打开终端' }
  }

  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/K', `cd /d "${cwd.replace(/"/g, '""')}"`], {
        detached: true,
        stdio: 'ignore',
        shell: false
      }).unref()
      return { ok: true }
    }

    if (process.platform === 'darwin') {
      const script = `tell application "Terminal" to do script "cd \\"${cwd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}\\""`
      spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref()
      return { ok: true }
    }

    spawn(process.env.SHELL ?? 'bash', ['-lc', `cd "${cwd.replace(/"/g, '\\"')}" && exec $SHELL -l`], {
      detached: true,
      stdio: 'ignore'
    }).unref()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
