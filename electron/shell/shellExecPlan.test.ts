import { describe, expect, it } from 'vitest'
import { planShellExec } from './shellExecPlan'
import { WINDOWS_POWERSHELL_PROFILE, WINDOWS_POWERSHELL_PRELUDE } from './shellProfiles'

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
})
