import { describe, expect, it } from 'vitest'
import {
  MACOS_BASH_PROFILE,
  WINDOWS_POWERSHELL_PROFILE,
  buildShellArgs,
  createShellAdapter,
  freezeShellProfileSnapshot,
  encodePowerShellCommand,
  profileForPlatform
} from './shellProfiles'

describe('ShellProfile', () => {
  it('Windows prelude 只保留 progress 静默（D1）', () => {
    const args = createShellAdapter(WINDOWS_POWERSHELL_PROFILE).buildCommandArgs('Write-Output ok').at(-1)
    const decoded = Buffer.from(String(args), 'base64').toString('utf16le')
    expect(decoded).toContain("$ProgressPreference = 'SilentlyContinue'")
    expect(decoded).not.toContain('OutputEncoding')
  })

  it('macOS 使用显式非 login Bash 模板', () => {
    expect(MACOS_BASH_PROFILE.commandArgsTemplate).toEqual(['--noprofile', '--norc', '-c', '{command}'])
    expect(profileForPlatform('darwin')).toMatchObject(MACOS_BASH_PROFILE)
  })

  it('Windows 固定使用 PowerShell 5.1 EncodedCommand 模板', () => {
    expect(WINDOWS_POWERSHELL_PROFILE.executable).toBe('powershell.exe')
    expect(WINDOWS_POWERSHELL_PROFILE.commandArgsTemplate).toContain('-EncodedCommand')
    expect(profileForPlatform('win32')).toMatchObject(WINDOWS_POWERSHELL_PROFILE)
  })

  it('使用 UTF-16LE Base64 编码命令且可还原 Unicode', () => {
    const command = 'Write-Output "你好"'
    const payload = encodePowerShellCommand(command, "$ProgressPreference = 'SilentlyContinue';")
    const decoded = Buffer.from(payload, 'base64').toString('utf16le')
    expect(decoded).toContain(command)
    expect(buildShellArgs(WINDOWS_POWERSHELL_PROFILE, command)).toContain(
      encodePowerShellCommand(command)
    )
  })

  it('ShellAdapter 统一提供 profile、参数构造和方言检查', () => {
    const bash = createShellAdapter(MACOS_BASH_PROFILE)
    expect(bash.profile.id).toBe(MACOS_BASH_PROFILE.id)
    expect(bash.buildCommandArgs('printf ok')).toEqual(['--noprofile', '--norc', '-c', 'printf ok'])
    expect(bash.detectMismatch('Get-ChildItem .')?.expectedDialect).toBe('posix-bash')

    const powershell = createShellAdapter(WINDOWS_POWERSHELL_PROFILE)
    const encoded = powershell.buildCommandArgs('Write-Output "你好"').at(-1)
    expect(Buffer.from(String(encoded), 'base64').toString('utf16le')).toContain('Write-Output "你好"')
  })

  it('profile snapshot 深冻结，调用方不能修改执行参数', () => {
    const snapshot = freezeShellProfileSnapshot(MACOS_BASH_PROFILE)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.commandArgsTemplate)).toBe(true)
    expect(() => {
      ;(snapshot as { executable: string }).executable = '/tmp/other-shell'
    }).toThrow()
  })

  it('ShellAdapter 在创建时冻结 profile，后续修改不会改变编码和参数模板', () => {
    const mutable = { ...WINDOWS_POWERSHELL_PROFILE, commandArgsTemplate: [...WINDOWS_POWERSHELL_PROFILE.commandArgsTemplate] }
    const adapter = createShellAdapter(mutable)
    mutable.commandArgsTemplate[0] = '-NoProfile-MUTATED'
    mutable.encoding = 'utf8'
    expect(adapter.profile.encoding).toBe('utf16le')
    const encoded = adapter.buildCommandArgs('Write-Output "你好"').at(-1)
    expect(Buffer.from(String(encoded), 'base64').toString('utf16le')).toContain('你好')
    expect(adapter.buildCommandArgs('Write-Output "你好"')[0]).toBe('-NoLogo')
  })

  it.each([
    '',
    'Write-Output "第一行"\nWrite-Output "第二行"',
    'Write-Output "你好🙂" | Where-Object { $_ -ne $null }',
    "Write-Output '特殊`$字符\"'"
  ])('PowerShell 命令形态可通过 UTF-16LE Base64 round-trip：%s', (command) => {
    const encoded = buildShellArgs(WINDOWS_POWERSHELL_PROFILE, command).at(-1)
    expect(Buffer.from(String(encoded), 'base64').toString('utf16le')).toBe(command)
  })
})
