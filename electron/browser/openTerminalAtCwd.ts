import { spawn } from 'node:child_process'
import type { BrowserDetectContext } from './browserDependencyDetect'
import { isAllowedTerminalCwd } from './browserDependencyDetect'

export type OpenTerminalResult = { ok: true } | { ok: false; error: string }

export function openTerminalAtCwd(cwd: string, ctx: BrowserDetectContext): OpenTerminalResult {
  if (!isAllowedTerminalCwd(cwd, ctx)) {
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
