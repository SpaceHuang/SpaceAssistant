import { spawnSync } from 'node:child_process'

export type OrphanProcessIdentity = { pid: number; processGroupId?: number; ownerToken: string }
export type OrphanCleanupResult = 'cleaned' | 'not-owned' | 'already-exited' | 'failed'

function commandLineForPid(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (process.platform === 'win32') {
    const result = spawnSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine'], { encoding: 'utf8' })
    return result.status === 0 ? result.stdout : null
  }
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout : null
}

export async function cleanupOrphanProcess(identity: OrphanProcessIdentity, timeoutMs = 3_000): Promise<OrphanCleanupResult> {
  const command = commandLineForPid(identity.pid)
  if (!command) return 'already-exited'
  if (!command.includes(identity.ownerToken)) return 'not-owned'
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('taskkill', ['/PID', String(identity.pid), '/T', '/F'], { encoding: 'utf8' })
      if (result.status !== 0) return 'failed'
    } else {
      process.kill(-(identity.processGroupId ?? identity.pid), 'SIGTERM')
    }
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
