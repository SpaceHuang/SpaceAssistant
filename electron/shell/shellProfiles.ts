import { detectShellDialectMismatch, type ShellDialectMismatch } from './shellDialectMismatch'
import { defaultContractForPlatform, UTF8_CONTRACT } from '../processOutput/contracts'
import type { OutputEncodingContract } from '../../src/shared/outputEncoding'

export type ShellDialect = 'posix-bash' | 'windows-powershell'

export interface ShellProfile {
  id: string
  dialect: ShellDialect
  executable: string
  commandArgsTemplate: readonly string[]
  loginMode: 'none' | 'login'
  /** 输出编码契约：唯一消费者是 processOutput 的解码器（§7.1） */
  outputEncoding: OutputEncodingContract
  /** 契约来源：内置决定 / 宿主注册表探测 / 用户显式配置 */
  encodingSource: 'builtin' | 'user' | 'detected'
  source: 'builtin' | 'user'
}

export interface ShellAdapter {
  readonly profile: ShellProfile
  buildCommandArgs(command: string): string[]
  detectMismatch(command: string): ShellDialectMismatch | undefined
}

export const MACOS_BASH_PROFILE: ShellProfile = Object.freeze({
  id: 'builtin-macos-bash',
  dialect: 'posix-bash',
  executable: '/bin/bash',
  commandArgsTemplate: ['--noprofile', '--norc', '-c', '{command}'],
  loginMode: 'none',
  outputEncoding: UTF8_CONTRACT,
  encodingSource: 'builtin',
  source: 'builtin'
})

/**
 * Windows PowerShell 契约：宿主 OEM CP（D1 之后 prelude 不再改动 `[Console]::OutputEncoding`，
 * PS 自身输出、`cmd` 内建与系统工具统一归一到宿主 OEM CP）。探测结果懒求值并缓存到进程级。
 */
export const WINDOWS_POWERSHELL_PROFILE: ShellProfile = Object.freeze({
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
  get outputEncoding(): OutputEncodingContract {
    return defaultContractForPlatform('win32')
  },
  encodingSource: 'detected',
  source: 'builtin'
})

/**
 * Windows PowerShell 启动 prelude。
 *
 * 只保留进度流静默：非交互宿主会把 progress 记录序列化成 CLIXML 写进 stderr
 * （首次启动的 "Preparing modules for first use." 也会命中）。
 *
 * **不再**设置 `$OutputEncoding` / `[Console]::OutputEncoding`（D1 决策，§7.3 方案 C）：
 * 实测对硬编码自身编码的 native 工具毫无影响（字节透传），却在「native 输出 → PS 字符串」
 * 路径上把 OEM 字节按 UTF-8 严格解码成不可逆的 U+FFFD。回到宿主默认编码后，
 * 「期望编码」由 plan 里的 outputEncoding 契约表达。
 */
export const WINDOWS_POWERSHELL_PRELUDE = "$ProgressPreference = 'SilentlyContinue';"

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
      return buildShellArgs(snapshot, command, snapshot.dialect === 'windows-powershell' ? WINDOWS_POWERSHELL_PRELUDE : '')
    },
    detectMismatch(command: string): ShellDialectMismatch | undefined {
      return detectShellDialectMismatch(command, snapshot)
    }
  }
}
