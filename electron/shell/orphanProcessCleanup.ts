import { runCommandWithTimeout } from '../spawnUtil'

export type OrphanProcessIdentity = { pid: number; processGroupId?: number; ownerToken: string }
export type OrphanCleanupResult = 'cleaned' | 'not-owned' | 'already-exited' | 'unverified' | 'failed'

const QUERY_TIMEOUT_MS = 5_000
const TERMINATION_TIMEOUT_MS = 5_000

function normalizeCommandLine(stdout: string): string | null {
  const text = stdout.trim()
  // PowerShell 对空结果输出字面量 ""，wmic 对无实例输出空行，两者都表示进程不可查。
  if (!text || text === '""') return null
  return text
}

type CommandLineLookup = { status: 'read'; command: string | null } | { status: 'unverified' }

/**
 * Windows 11 24H2 起 WMIC 默认不再随系统提供，命令行必须优先走 PowerShell CIM，
 * wmic 仅作为 PowerShell 不可用时的回退。
 *
 * 不再改写宿主输出编码（§12-#9）：PowerShell 5.1 按宿主 OEM 代码页写 stdout，交给
 * runCommandWithTimeout 的统一解码器按宿主 OEM CP 还原，因此含非 ASCII 的命令行不再退化成
 * 替换字符（历史事故：owner-中文-… → owner-????-…）。wmic 回退同理由同一解码器处理。
 */
async function windowsCommandLineForPid(pid: number): Promise<CommandLineLookup> {
  const query = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
  const cim = await runCommandWithTimeout(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', query],
    QUERY_TIMEOUT_MS
  )
  if (cim.completed && cim.code === 0) return { status: 'read', command: normalizeCommandLine(cim.stdout) }
  const wmic = await runCommandWithTimeout(
    'wmic',
    ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine'],
    QUERY_TIMEOUT_MS
  )
  if (wmic.completed && wmic.code === 0) return { status: 'read', command: normalizeCommandLine(wmic.stdout) }
  return { status: 'unverified' }
}

async function commandLineForPid(pid: number): Promise<CommandLineLookup> {
  if (!Number.isInteger(pid) || pid <= 0) return { status: 'read', command: null }
  if (process.platform === 'win32') return windowsCommandLineForPid(pid)
  const ps = await runCommandWithTimeout('ps', ['-p', String(pid), '-o', 'command='], QUERY_TIMEOUT_MS)
  if (!ps.completed) return { status: 'unverified' }
  // ps 对不存在的 PID 以非 0 退出，语义就是进程已不在。
  return { status: 'read', command: ps.code === 0 ? normalizeCommandLine(ps.stdout) : null }
}

/**
 * 只在 owner token 校验通过后调用。POSIX 上仅当调用方显式给出进程组时才整组终止，
 * 否则按 PID 终止：负 PID 在未设 detached 的子进程上会指向无关进程组。
 */
async function signalOwnedOrphan(identity: OrphanProcessIdentity): Promise<boolean> {
  if (process.platform === 'win32') {
    const taskkill = await runCommandWithTimeout(
      'taskkill',
      ['/PID', String(identity.pid), '/T', '/F'],
      TERMINATION_TIMEOUT_MS
    )
    return taskkill.completed && taskkill.code === 0
  }
  const groupId = identity.processGroupId && identity.processGroupId > 0 ? identity.processGroupId : undefined
  if (groupId) {
    try {
      process.kill(-groupId, 'SIGTERM')
      return true
    } catch (error) {
      // 只有"进程组已不存在"才回退到按 PID 终止；EPERM 等失败继续抛给上层按 failed 收敛，
      // 避免在 PID 复用竞态下误杀无关进程。
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  process.kill(identity.pid, 'SIGTERM')
  return true
}

export async function cleanupOrphanProcess(identity: OrphanProcessIdentity, timeoutMs = 3_000): Promise<OrphanCleanupResult> {
  const lookup = await commandLineForPid(identity.pid)
  if (lookup.status === 'unverified') return 'unverified'
  if (!lookup.command) return 'already-exited'
  if (!lookup.command.includes(identity.ownerToken)) return 'not-owned'
  try {
    if (!(await signalOwnedOrphan(identity))) return 'failed'
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
