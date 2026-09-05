import { buildShellArgs, WINDOWS_POWERSHELL_PROFILE, WINDOWS_UTF8_OUTPUT_PRELUDE } from './shellProfiles'

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

function buildSpawnArgs(spec: ShellSpawnSpec, command: string): string[] {
  if (spec.shellId === WINDOWS_POWERSHELL_PROFILE.id) {
    return buildShellArgs(WINDOWS_POWERSHELL_PROFILE, command, WINDOWS_UTF8_OUTPUT_PRELUDE)
  }
  const args = [...spec.args]
  const commandIndex = args.indexOf('')
  if (commandIndex < 0) throw new Error('SHELL_PROFILE_COMMAND_PLACEHOLDER_MISSING')
  args[commandIndex] = command
  return args
}

export function planShellExec(
  command: string,
  defaultCwd: string,
  spec: ShellSpawnSpec
): ShellExecPlan {
  return {
    cwd: defaultCwd,
    command,
    spawnArgs: buildSpawnArgs(spec, command)
  }
}
