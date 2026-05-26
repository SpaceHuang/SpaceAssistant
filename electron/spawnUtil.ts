import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import path from 'path'

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
