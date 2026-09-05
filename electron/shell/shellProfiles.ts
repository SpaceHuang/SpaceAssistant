import { detectShellDialectMismatch, type ShellDialectMismatch } from './shellDialectMismatch'

export type ShellDialect = 'posix-bash' | 'windows-powershell'

export interface ShellProfile {
  id: string
  dialect: ShellDialect
  executable: string
  commandArgsTemplate: readonly string[]
  loginMode: 'none' | 'login'
  encoding: 'utf8' | 'utf16le'
  source: 'builtin' | 'user'
}

export interface ShellAdapter {
  readonly profile: ShellProfile
  buildCommandArgs(command: string): string[]
  detectMismatch(command: string): ShellDialectMismatch | undefined
}

export const MACOS_BASH_PROFILE: ShellProfile = {
  id: 'builtin-macos-bash',
  dialect: 'posix-bash',
  executable: '/bin/bash',
  commandArgsTemplate: ['--noprofile', '--norc', '-c', '{command}'],
  loginMode: 'none',
  encoding: 'utf8',
  source: 'builtin'
}

export const WINDOWS_POWERSHELL_PROFILE: ShellProfile = {
  id: 'builtin-windows-powershell',
  dialect: 'windows-powershell',
  executable: 'powershell.exe',
  commandArgsTemplate: [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    '{encodedCommand}'
  ],
  loginMode: 'none',
  encoding: 'utf16le',
  source: 'builtin'
}

export const WINDOWS_UTF8_OUTPUT_PRELUDE =
  '$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new();'

export function freezeShellProfileSnapshot(profile: ShellProfile): ShellProfile {
  return Object.freeze({
    ...profile,
    commandArgsTemplate: Object.freeze([...profile.commandArgsTemplate])
  })
}

export function encodePowerShellCommand(command: string, prelude = ''): string {
  return Buffer.from(`${prelude}${command}`, 'utf16le').toString('base64')
}

export function buildShellArgs(profile: ShellProfile, command: string, prelude = ''): string[] {
  const encoded = profile.dialect === 'windows-powershell' ? encodePowerShellCommand(command, prelude) : command
  return profile.commandArgsTemplate.map((arg) =>
    arg === '{command}' ? command : arg === '{encodedCommand}' ? encoded : arg
  )
}

export function profileForPlatform(platform: NodeJS.Platform): ShellProfile {
  return freezeShellProfileSnapshot(platform === 'win32' ? WINDOWS_POWERSHELL_PROFILE : MACOS_BASH_PROFILE)
}

export function createShellAdapter(profile: ShellProfile): ShellAdapter {
  const snapshot = freezeShellProfileSnapshot(profile)
  return {
    profile: snapshot,
    buildCommandArgs(command: string): string[] {
      return buildShellArgs(snapshot, command, snapshot.dialect === 'windows-powershell' ? WINDOWS_UTF8_OUTPUT_PRELUDE : '')
    },
    detectMismatch(command: string): ShellDialectMismatch | undefined {
      return detectShellDialectMismatch(command, snapshot)
    }
  }
}
