import { describe, expect, it } from 'vitest'
import { planShellExec } from './shellExecPlan'
import {
  WINDOWS_CMD_PROFILE,
  WINDOWS_POWERSHELL_PROFILE,
  WINDOWS_POWERSHELL_PRELUDE,
  WINDOWS_PWSH_PROFILE,
  buildShellArgs,
  profileForPlatform
} from './shellProfiles'

describe('planShellExec', () => {
  it('requires an explicit command placeholder instead of inferring -c/-lc', () => {
    expect(() => planShellExec('echo ok', '/tmp', {
      executable: '/bin/bash', args: ['-c'], shellId: 'bash'
    })).toThrow('SHELL_PROFILE_COMMAND_PLACEHOLDER_MISSING')
  })

  it('PowerShell profile 使用 UTF-16LE EncodedCommand，而不是追加裸命令', () => {
    const plan = planShellExec('Write-Output "你好"', 'C:\\work', {
      executable: WINDOWS_POWERSHELL_PROFILE.executable,
      args: [...WINDOWS_POWERSHELL_PROFILE.commandArgsTemplate],
      shellId: WINDOWS_POWERSHELL_PROFILE.id
    })
    expect(plan.spawnArgs).toEqual([
      ...WINDOWS_POWERSHELL_PROFILE.commandArgsTemplate.slice(0, -1),
      expect.any(String)
    ])
    expect(plan.spawnArgs.at(-1)).toBeTypeOf('string')
    expect(Buffer.from(String(plan.spawnArgs.at(-1)), 'base64').toString('utf16le')).toBe(
      `${WINDOWS_POWERSHELL_PRELUDE}Write-Output "你好"`
    )
  })

  // ===== P0-C：降级宿主的参数模板（§7.1 #7）=====
  it('pwsh profile 与 powershell 同构：EncodedCommand + prelude', () => {
    expect(WINDOWS_PWSH_PROFILE.id).toBe('builtin-windows-pwsh')
    expect(WINDOWS_PWSH_PROFILE.executable).toBe('pwsh.exe')
    const plan = planShellExec('Write-Output ok', 'C:\\work', {
      executable: WINDOWS_PWSH_PROFILE.executable,
      args: [],
      shellId: WINDOWS_PWSH_PROFILE.id
    })
    expect(plan.spawnArgs).toContain('-EncodedCommand')
    expect(Buffer.from(String(plan.spawnArgs.at(-1)), 'base64').toString('utf16le')).toBe(
      `${WINDOWS_POWERSHELL_PRELUDE}Write-Output ok`
    )
  })

  it('cmd profile 使用 /d /s /c，不含 -EncodedCommand（降级参数构造）', () => {
    expect(WINDOWS_CMD_PROFILE.id).toBe('builtin-windows-cmd')
    expect(WINDOWS_CMD_PROFILE.executable).toBe('cmd.exe')
    expect(buildShellArgs(WINDOWS_CMD_PROFILE, 'echo ok')).toEqual(['/d', '/s', '/c', 'echo ok'])
    const plan = planShellExec('echo ok', 'C:\\work', {
      executable: WINDOWS_CMD_PROFILE.executable,
      args: buildShellArgs(WINDOWS_CMD_PROFILE, ''),
      shellId: WINDOWS_CMD_PROFILE.id
    })
    expect(plan.spawnArgs).toEqual(['/d', '/s', '/c', 'echo ok'])
    expect(plan.spawnArgs.join(' ')).not.toContain('-EncodedCommand')
  })

  it('默认 profile 不变：win32 仍是 powershell（降级由执行层决策）', () => {
    expect(profileForPlatform('win32').id).toBe('builtin-windows-powershell')
  })
})
