import path from 'path'

export type ShellSpawnSpec = {
  executable: string
  args: string[]
  shellId: string
}

export type ShellExecPlan = {
  cwd: string
  command: string
  spawnArgs: string[]
}

/** Windows cmd /s 会剥离首尾引号，导致 cd /d "path" && … 语法错误；默认不使用 /s。 */
const WIN_CMD_PREFIX = ['/d', '/c', ''] as const

/**
 * 解析 Windows 命令开头的 `cd /d <dir> &&`，改为 spawn.cwd，避免 cmd 引号与 /s 问题。
 */
export function extractWindowsCdAnd(command: string): { cwd: string; rest: string } | null {
  const m = command.match(
    /^\s*cd\s+\/d\s+(?:"([^"]+)"|'([^']+)'|([^\s&|]+))\s*&&\s*(.+)$/is
  )
  if (!m) return null
  const cwd = (m[1] ?? m[2] ?? m[3] ?? '').trim()
  const rest = (m[4] ?? '').trim()
  if (!cwd || !rest) return null
  return { cwd, rest }
}

function shellConfigUsesCustomExecutable(spec: ShellSpawnSpec): boolean {
  return spec.shellId !== 'cmd' && spec.shellId !== 'bash'
}

function buildSpawnArgs(spec: ShellSpawnSpec, command: string): string[] {
  if (process.platform === 'win32' && !shellConfigUsesCustomExecutable(spec)) {
    return ['/d', '/c', command]
  }
  const args = [...spec.args]
  const lcIdx = args.findIndex((a) => a === '-lc' || a === '-c')
  if (lcIdx >= 0) {
    args[lcIdx + 1] = command
    return args.slice(0, lcIdx + 2)
  }
  return [...args, command]
}

export function planShellExec(
  command: string,
  defaultCwd: string,
  spec: ShellSpawnSpec
): ShellExecPlan {
  let cwd = defaultCwd
  let effectiveCommand = command

  if (process.platform === 'win32' && spec.shellId === 'cmd') {
    const extracted = extractWindowsCdAnd(command)
    if (extracted) {
      cwd = path.resolve(extracted.cwd)
      effectiveCommand = extracted.rest
    }
  }

  const specForSpawn: ShellSpawnSpec =
    process.platform === 'win32' && spec.shellId === 'cmd' && !shellConfigUsesCustomExecutable(spec)
      ? { ...spec, args: [...WIN_CMD_PREFIX] }
      : spec

  return {
    cwd,
    command: effectiveCommand,
    spawnArgs: buildSpawnArgs(specForSpawn, effectiveCommand)
  }
}
