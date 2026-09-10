import { spawnSync } from 'node:child_process'

export type OrphanProcessIdentity = { pid: number; processGroupId?: number; ownerToken: string }
export type OrphanCleanupResult = 'cleaned' | 'not-owned' | 'already-exited' | 'failed'

function normalizeCommandLine(stdout: string | undefined): string | null {
  const text = stdout?.trim() ?? ''
  // PowerShell 对空结果输出字面量 ""，wmic 对无实例输出空行，两者都表示进程不可查。
  if (!text || text === '""') return null
  return text
}

/**
 * Windows 11 24H2 起 WMIC 默认不再随系统提供，命令行必须优先走 PowerShell CIM，
 * wmic 仅作为 PowerShell 不可用时的回退。
 */
function windowsCommandLineForPid(pid: number): string | null {
  const query = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
  const cim = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', query], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (cim.status === 0) return normalizeCommandLine(cim.stdout)
  const wmic = spawnSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine'], {
    encoding: 'utf8',
    windowsHide: true
  })
  return wmic.status === 0 ? normalizeCommandLine(wmic.stdout) : null
}

function commandLineForPid(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (process.platform === 'win32') return windowsCommandLineForPid(pid)
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  return result.status === 0 ? normalizeCommandLine(result.stdout) : null
}

/**
 * 只在 owner token 校验通过后调用。POSIX 上仅当调用方显式给出进程组时才整组终止，
 * 否则按 PID 终止：负 PID 在未设 detached 的子进程上会指向无关进程组。
 */
function signalOwnedOrphan(identity: OrphanProcessIdentity): boolean {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(identity.pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true
    })
    return result.status === 0
  }
  const groupId = identity.processGroupId && identity.processGroupId > 0 ? identity.processGroupId : undefined
  if (groupId) {
    try {
      process.kill(-groupId, 'SIGTERM')
      return true
    } catch {
      // 进程组已不存在时回退到按 PID 终止，避免把可回收的孤儿留在系统里。
    }
  }
  process.kill(identity.pid, 'SIGTERM')
  return true
}

export async function cleanupOrphanProcess(identity: OrphanProcessIdentity, timeoutMs = 3_000): Promise<OrphanCleanupResult> {
  const command = commandLineForPid(identity.pid)
  if (!command) return 'already-exited'
  if (!command.includes(identity.ownerToken)) return 'not-owned'
  try {
    if (!signalOwnedOrphan(identity)) return 'failed'
  } catch {
    return 'failed'
  }
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (Date.now() <= deadline) {
    try { process.kill(identity.pid, 0) } catch { return 'cleaned' }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return 'failed'
}
