import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import path from 'path'
import type { ProcessKiller } from './shell/processSupervisor'

const KILL_TREE_TIMEOUT_MS = 3000
const KILL_TREE_GRACE_MS = 250

/** 断开子进程 stdio，避免进程未退出时管道句柄阻止 Node 事件循环结束。 */
export function detachChildProcessStreams(proc: ChildProcess): void {
  try {
    proc.stdout?.destroy()
  } catch {
    /* ignore */
  }
  try {
    proc.stderr?.destroy()
  } catch {
    /* ignore */
  }
  try {
    proc.stdin?.destroy()
  } catch {
    /* ignore */
  }
}

/** 终止进程及其子进程。Windows 上 SIGTERM 打到 cmd.exe 会弹出「终止批处理操作吗(Y/N)?」，需用 taskkill /T /F。 */
export function killProcessTree(proc: ChildProcess): Promise<void> {
  return killProcessTreeVerified(proc).then(() => undefined)
}

/** 终止并报告是否在 deadline 内收到树根进程的退出确认。 */
export function killProcessTreeVerified(proc: ChildProcess): Promise<boolean> {
  return new Promise((resolve) => {
    const pid = proc.pid
    if (!pid) {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      detachChildProcessStreams(proc)
      resolve(true)
      return
    }

    let settled = false
    const finish = (verified: boolean) => {
      if (settled) return
      settled = true
      detachChildProcessStreams(proc)
      resolve(verified)
    }

    const timer = setTimeout(() => finish(false), KILL_TREE_TIMEOUT_MS)

    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.on('close', (code, signal) => {
        clearTimeout(timer)
        if (code === 0 && signal == null) {
          finish(true)
          return
        }
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
        finish(false)
      })
      killer.on('error', () => {
        clearTimeout(timer)
        try {
          proc.kill()
        } catch {
          /* ignore */
        }
        finish(false)
      })
      return
    }

    const groupPid = process.platform === 'darwin' ? -(pid as number) : undefined
    try {
      if (groupPid) process.kill(groupPid, 'SIGTERM')
      else proc.kill('SIGTERM')
    } catch {
      clearTimeout(timer)
      finish(false)
      return
    }

    const hardKillTimer = setTimeout(() => {
      try {
        if (groupPid) process.kill(groupPid, 'SIGKILL')
        else proc.kill('SIGKILL')
      } catch {
        /* process already exited */
      }
    }, KILL_TREE_GRACE_MS)
    proc.once('close', () => {
      clearTimeout(timer)
      clearTimeout(hardKillTimer)
      finish(true)
    })
    proc.once('error', () => {
      clearTimeout(timer)
      clearTimeout(hardKillTimer)
      finish(false)
    })
  })
}

/** 将现有平台终止实现适配为统一 supervisor contract。 */
export const processTreeKiller: ProcessKiller = {
  async terminate(proc) {
    const verified = await killProcessTreeVerified(proc)
    return { signal: process.platform === 'win32' ? 'taskkill' : 'SIGTERM', verified }
  }
}

/** Windows 上 spawn 非 .exe（.cmd/.bat 或无扩展名 npm shim）会 EINVAL，需经 cmd.exe。 */
export function spawnCommand(
  executable: string,
  args: readonly string[] = [],
  options: SpawnOptions = {}
): ChildProcess {
  const opts: SpawnOptions = { shell: false, windowsHide: true, ...options }

  if (process.platform === 'win32') {
    const base = path.basename(executable).toLowerCase()
    if (!base.endsWith('.exe')) {
      const comspec = process.env.ComSpec ?? 'cmd.exe'
      return spawn(comspec, ['/d', '/s', '/c', executable, ...args], opts)
    }
  }

  return spawn(executable, [...args], opts)
}

export function spawnCommandSafe(
  executable: string,
  args: readonly string[] = [],
  options: SpawnOptions = {}
): { proc: ChildProcess } | { error: string } {
  try {
    return { proc: spawnCommand(executable, args, options) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
