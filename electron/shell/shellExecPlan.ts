import {
  buildShellArgs,
  WINDOWS_POWERSHELL_PROFILE,
  WINDOWS_POWERSHELL_PRELUDE,
  WINDOWS_PWSH_PROFILE,
  type ShellProfile
} from './shellProfiles'

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

/** powershell 家族（5.1 / pwsh）使用 EncodedCommand 模板；cmd 走 {command} 占位符。 */
const POWERSHELL_FAMILY_PROFILES: Record<string, ShellProfile> = {
  [WINDOWS_POWERSHELL_PROFILE.id]: WINDOWS_POWERSHELL_PROFILE,
  [WINDOWS_PWSH_PROFILE.id]: WINDOWS_PWSH_PROFILE
}

function buildSpawnArgs(spec: ShellSpawnSpec, command: string): string[] {
  const powershellFamilyProfile = POWERSHELL_FAMILY_PROFILES[spec.shellId]
  if (powershellFamilyProfile) {
    return buildShellArgs(powershellFamilyProfile, command, WINDOWS_POWERSHELL_PRELUDE)
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
